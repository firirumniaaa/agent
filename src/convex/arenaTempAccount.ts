import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { CookieJar, fetchWithJar, followRedirectsWithJar } from "./cookieJar";
import { mintArenaRecaptchaToken } from "./arenaRecaptcha";

const BASE = "https://arena.ai";
const MAIL_TM = "https://api.mail.tm";

// Desktop Chrome — perilaku paling mirip browser sungguhan untuk warm-up dan
// seluruh alur (header browser-like, bukan User-Agent iPhone).
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Identitas QA sintetis — jelas BUKAN orang asli: nama selalu berakhiran
 * "QA"/"Test" dan email local-part selalu memuat "qa"/"test". Bukan dari fake
 * name generator, bukan impersonasi siapa pun.
 */
const QA_IDENTITIES = [
  { fullName: "Ari Pratama QA", local: "ari.pratama.qa" },
  { fullName: "Bima Santoso Test", local: "bima.santoso.test" },
  { fullName: "Dina Lestari QA", local: "dina.lestari.qa" },
  { fullName: "Raka Wijaya Test", local: "raka.wijaya.test" },
];

/** Fallback domain mail.tm bila /domains tidak bisa diambil (domainnya rotasi). */
const FALLBACK_MAIL_DOMAINS = ["emalupe.com", "mailto.plus", "gfbzb.com"];

/** Ambil domain mail.tm yang aktif (rotasi berkala), fallback ke daftar statis. */
async function tempMailDomain(): Promise<string> {
  try {
    const res = await fetch(`${MAIL_TM}/domains`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        "hydra:member"?: Array<{ domain?: string; isActive?: boolean }>;
      };
      const active = (data["hydra:member"] ?? []).filter(
        (d) => d.isActive !== false && d.domain,
      );
      if (active.length) {
        return active[Math.floor(Math.random() * active.length)].domain as string;
      }
    }
  } catch {
    // lanjut ke fallback
  }
  return FALLBACK_MAIL_DOMAINS[
    Math.floor(Math.random() * FALLBACK_MAIL_DOMAINS.length)
  ];
}

/**
 * Identitas QA sintetis: nama jelas TEST ("Ari Pratama QA") + email
 * local-part normal (ari.pratama.qa.<ts>@domain) — bukan gibberish acak.
 */
export async function syntheticQaIdentity(): Promise<{
  fullName: string;
  address: string;
}> {
  const pick = QA_IDENTITIES[Math.floor(Math.random() * QA_IDENTITIES.length)];
  const domain = await tempMailDomain();
  const stamp = Date.now().toString(36);
  return {
    fullName: pick.fullName,
    address: `${pick.local}.${stamp}@${domain}`,
  };
}

/** Scrub nilai mirip token/JWT dari teks debug sebelum dikembalikan. */
function scrubPreview(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{40,}(?:\.[A-Za-z0-9_-]{40,}){1,}/g, "[token]")
    .slice(0, 300);
}

/** Header mirip browser untuk halaman HTML (warm-up). */
const HTML_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  Referer: BASE + "/",
  "Upgrade-Insecure-Requests": "1",
};

/** Header mirip browser untuk API JSON arena.ai. */
function jsonHeaders(): Record<string, string> {
  return {
    "User-Agent": BROWSER_UA,
    Accept: "application/json, text/event-stream, */*",
    Origin: BASE,
    Referer: BASE + "/agent",
  };
}

/** POST create-chat dengan jar — token null untuk isolasi auth. */
async function createChatWithJar(
  jar: CookieJar,
  token: string | null,
): Promise<{ status: number; statusText: string; body: string }> {
  const res = await fetchWithJar(jar, `${BASE}/nextjs-api/stream/create-chat`, {
    method: "POST",
    headers: {
      ...jsonHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "halo tes setelah upgrade email" }],
      },
      timezone: "Asia/Jakarta",
      recaptchaV2Token: null,
      recaptchaV3Token: token,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, statusText: res.statusText, body: await res.text() };
}

/**
 * Buat akun arena.ai otomatis via email sementara (mail.tm) lalu simpan
 * sesinya untuk clientId ini. Alur persis urutan browser:
 *   anon sign-up -> magic-link -> callback (redirect manual) -> set-password
 *   -> /api/me -> WARM-UP (GET / + GET /agent ala browser) -> /api/me lagi
 *   -> create-chat (null token dulu, lalu token reCAPTCHA).
 *
 * SEMUA Set-Cookie di-merge ke CookieJar setelah tiap request penting, dan
 * setiap request berikutnya mengirim jar terbaru (lihat cookieJar.ts).
 *
 * KEAMANAN DEBUG: tidak pernah mengembalikan/melog cookie mentah, token,
 * password, atau body yang bisa memuat token — hanya status, nama cookie,
 * finalUrls, dan responsePreview yang sudah di-scrub.
 */
export const createTempAccount = action({
  args: { clientId: v.optional(v.string()) },
  handler: async (ctx, { clientId }): Promise<Record<string, unknown>> => {
    const steps: Record<string, number | null> = {
      signup: null,
      setPassword: null,
      meBeforeWarmup: null,
      homeWarmup: null,
      agentWarmup: null,
      meAfterWarmup: null,
      chatAuthNull: null,
      chatAuth: null,
    };
    const finalUrls: Record<string, string | null> = { home: null, agent: null };
    const statusTexts: Record<string, string> = {};
    let responsePreview: string | null = null;
    let error: string | null = null;

    const { fullName, address } = await syntheticQaIdentity();
    const password = "TempPass!" + Math.random().toString(36).slice(2, 10);
    const jar = CookieJar.empty();

    function finish(): Record<string, unknown> {
      const hasV10 = jar.has("arena-auth-prod-v1.0");
      const hasV11 = jar.has("arena-auth-prod-v1.1");
      const chatAuth = steps.chatAuth;
      return {
        ok: (chatAuth === 200 || chatAuth === 201) && hasV10 && hasV11,
        error,
        hasV10,
        hasV11,
        cookieNames: jar.names(),
        steps,
        finalUrls,
        statusTexts,
        responsePreview,
        address,
      };
    }

    // 1) Mailbox sementara
    try {
      const r = await fetch(`${MAIL_TM}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, password }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status !== 201) {
        error = `mail.tm create: HTTP ${r.status}`;
        return finish();
      }
    } catch (e) {
      error = `mail.tm create gagal: ${String(e)}`;
      return finish();
    }

    // 2) Kunjungan /agent -> provisional_user_id (Set-Cookie masuk jar)
    const visitRes = await fetchWithJar(jar, `${BASE}/agent`, {
      headers: HTML_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    const provisionalUserId = jar.get("provisional_user_id") ?? "";
    if (!provisionalUserId) {
      error = "provisional_user_id tidak diset oleh GET /agent";
      return finish();
    }

    // 3) sign-up ANONIM
    const recaptchaToken = await mintArenaRecaptchaToken();
    if (!recaptchaToken) {
      error = "recaptcha token gagal";
      return finish();
    }
    const suRes = await fetchWithJar(jar, `${BASE}/nextjs-api/sign-up`, {
      method: "POST",
      headers: { ...jsonHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ recaptchaToken, provisionalUserId }),
      signal: AbortSignal.timeout(20_000),
    });
    steps.signup = suRes.status;
    statusTexts.signup = suRes.statusText;
    if (suRes.status !== 200) {
      error = `signup anon: HTTP ${suRes.status}`;
      return finish();
    }

    // 4) magic-link dengan cookie anon (Set-Cookie respons ikut di-merge)
    const mlRes = await fetchWithJar(
      jar,
      `${BASE}/nextjs-api/sign-up/magic-link`,
      {
        method: "POST",
        headers: { ...jsonHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          email: address,
          fullName,
          shouldLinkHistory: false,
          marketingConsent: false,
          registeredCountryCode: "US",
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    // 5) Token mail.tm + poll inbox sampai email callback tiba
    let mailToken = "";
    try {
      const tRes = await fetch(`${MAIL_TM}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, password }),
        signal: AbortSignal.timeout(15_000),
      });
      mailToken = ((await tRes.json()) as { token?: string }).token ?? "";
    } catch {
      // ignore
    }

    let callbackUrl = "";
    for (let i = 0; i < 8 && !callbackUrl; i++) {
      await sleep(5000);
      try {
        const mRes = await fetch(`${MAIL_TM}/messages`, {
          headers: { Authorization: `Bearer ${mailToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        const members =
          ((await mRes.json()) as { "hydra:member"?: Array<{ id: string }> })[
            "hydra:member"
          ] ?? [];
        for (const m of members) {
          const dRes = await fetch(`${MAIL_TM}/messages/${m.id}`, {
            headers: { Authorization: `Bearer ${mailToken}` },
            signal: AbortSignal.timeout(15_000),
          });
          const detail = (await dRes.json()) as { text?: string };
          const match = (detail.text ?? "").match(
            /https:\/\/arena\.ai\/nextjs-api\/callback\/[^\s]+/,
          );
          if (match) {
            callbackUrl = match[0];
            break;
          }
        }
      } catch {
        // poll berikutnya
      }
    }
    if (!callbackUrl) {
      error = "Email verifikasi belum tiba / link callback tidak ditemukan";
      return finish();
    }

    // 6) Callback: ikuti redirect MANUAL sambil merge Set-Cookie tiap hop —
    //    seperti perilaku browser. Tangkap token set-password dari hop /auth/set-password.
    const { response: cbRes, hops } = await followRedirectsWithJar(
      jar,
      callbackUrl,
      { headers: HTML_HEADERS, signal: AbortSignal.timeout(20_000) },
      6,
    );
    const setPasswordHop = hops.find((h) =>
      h.location?.includes("/auth/set-password"),
    );
    const setPasswordToken =
      setPasswordHop?.location?.match(/token=([^&]+)/)?.[1] ?? "";
    if (!setPasswordToken) {
      error = `callback tanpa hop set-password (final HTTP ${cbRes.status})`;
      return finish();
    }

    // 7) set-password dengan cookie sesi (anon + provisional baru)
    const spRes = await fetchWithJar(
      jar,
      `${BASE}/nextjs-api/auth/set-password`,
      {
        method: "POST",
        headers: { ...jsonHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ password, token: setPasswordToken }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    steps.setPassword = spRes.status;
    statusTexts.setPassword = spRes.statusText;

    // 8) /api/me SEBELUM warm-up
    const meRes = await fetchWithJar(jar, `${BASE}/api/me`, {
      headers: jsonHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    steps.meBeforeWarmup = meRes.status;
    statusTexts.meBeforeWarmup = meRes.statusText;

    // 9) WARM-UP ala browser: GET / lalu GET /agent, ikuti redirect manual
    //    sambil merge Set-Cookie dari SETIAP hop. Header browser-like.
    const homeWarm = await followRedirectsWithJar(
      jar,
      `${BASE}/`,
      { headers: HTML_HEADERS, signal: AbortSignal.timeout(20_000) },
      6,
    );
    steps.homeWarmup = homeWarm.response.status;
    statusTexts.homeWarmup = homeWarm.response.statusText;
    finalUrls.home = homeWarm.finalUrl;

    const agentWarm = await followRedirectsWithJar(
      jar,
      `${BASE}/agent`,
      { headers: HTML_HEADERS, signal: AbortSignal.timeout(20_000) },
      6,
    );
    steps.agentWarmup = agentWarm.response.status;
    statusTexts.agentWarmup = agentWarm.response.statusText;
    finalUrls.agent = agentWarm.finalUrl;

    // 10) /api/me SETELAH warm-up
    const meAfter = await fetchWithJar(jar, `${BASE}/api/me`, {
      headers: jsonHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    steps.meAfterWarmup = meAfter.status;
    statusTexts.meAfterWarmup = meAfter.statusText;

    // 11) create-chat token null — isolasi auth: 401 = auth gagal,
    //     400/403 = auth OK, masalahnya reCAPTCHA/bot check.
    const chatNull = await createChatWithJar(jar, null);
    steps.chatAuthNull = chatNull.status;
    statusTexts.chatAuthNull = chatNull.statusText;
    responsePreview = scrubPreview(chatNull.body);

    // 12) create-chat DENGAN token reCAPTCHA — status inilah yang menentukan
    //     kesiapan sesi (200/201 = akun benar-benar bisa chat).
    const chatToken = await mintArenaRecaptchaToken();
    if (chatToken) {
      const chatReal = await createChatWithJar(jar, chatToken);
      steps.chatAuth = chatReal.status;
      statusTexts.chatAuth = chatReal.statusText;
      responsePreview = scrubPreview(chatReal.body);
    } else {
      steps.chatAuth = chatNull.status;
      statusTexts.chatAuth = `${chatNull.statusText} (token mint gagal)`;
    }

    // Simpan sesi final HANYA kalau /api/me 200 (pakai hasil terbaru yang
    // valid) — jangan menimpa sesi user yang sudah terhubung dengan sesi
    // temp yang rusak.
    const meOk =
      steps.meAfterWarmup === 200 || steps.meBeforeWarmup === 200;
    if (meOk) {
      const saveClientId = clientId?.trim() || "temp-mail-magiclink";
      await ctx.runMutation(internal.arenaSession.upsert, {
        clientId: saveClientId,
        cookie: jar.header(),
        name: fullName,
        email: address,
      });
    }

    return finish();
  },
});
