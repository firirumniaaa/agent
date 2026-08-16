import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { CookieJar, fetchWithJar, followRedirectsWithJar } from "./cookieJar";

const BASE = "https://arena.ai";
const MAIL_TM = "https://api.mail.tm";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const RECAPTCHA_KEY = "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0";
const RECAPTCHA_ORIGIN_B64 = "aHR0cHM6Ly9sbWFyZW5hLmFp";
const RECAPTCHA_VERSION = "XOqlk8PL_yVx6IdpLbpXdiLy";
const RECAPTCHA_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mint token reCAPTCHA dari anchor (server-side). */
async function mintRecaptchaToken(): Promise<string | null> {
  const url =
    `https://www.google.com/recaptcha/enterprise/anchor?ar=1` +
    `&k=${RECAPTCHA_KEY}` +
    `&co=${RECAPTCHA_ORIGIN_B64}` +
    `&hl=en&v=${RECAPTCHA_VERSION}&size=invisible&cb=${Math.random().toString(36).slice(2)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": RECAPTCHA_UA,
        Origin: "https://lmarena.ai",
        Referer: "https://lmarena.ai/",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(15_000),
    });
    const html = await res.text();
    const m = html.match(/id="recaptcha-token" value="([^"]+)"/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function randomAddress(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "arena";
  for (let i = 0; i < 10; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${s}@emalupe.com`;
}

/**
 * Buat akun arena.ai otomatis via email sementara (mail.tm) lalu simpan
 * sesinya untuk clientId ini. Alur persis urutan browser:
 *   anon sign-up -> magic-link -> callback (redirect manual) -> set-password
 *   -> /api/me -> create-chat.
 *
 * SEMUA Set-Cookie di-merge ke CookieJar setelah tiap request penting
 * (getSetCookie / raw / split aman — lihat cookieJar.ts), dan setiap request
 * berikutnya mengirim jar terbaru. Sesi akhir harus punya v1.0 + v1.1.
 *
 * KEAMANAN DEBUG: tidak pernah mengembalikan/melog cookie mentah, token,
 * password, atau body respons yang bisa memuat token — hanya status + nama
 * cookie.
 */
export const createTempAccount = action({
  args: { clientId: v.optional(v.string()) },
  handler: async (ctx, { clientId }): Promise<Record<string, unknown>> => {
    const log: Array<Record<string, unknown>> = [];
    const address = randomAddress();
    const password = "TempPass!" + Math.random().toString(36).slice(2, 10);

    // 1) Mailbox sementara
    try {
      const r = await fetch(`${MAIL_TM}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, password }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status !== 201) {
        return { error: `mail.tm create: HTTP ${r.status}`, address };
      }
    } catch (error) {
      return { error: `mail.tm create gagal: ${String(error)}`, address };
    }

    // 2) Kunjungan /agent -> provisional_user_id (Set-Cookie masuk jar)
    const jar = CookieJar.empty();
    const visitRes = await fetchWithJar(jar, `${BASE}/agent`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    const provisionalUserId = jar.get("provisional_user_id") ?? "";
    log.push({
      step: "visit",
      status: visitRes.status,
      provisionalUserId,
      cookieNames: jar.names(),
    });

    // 3) sign-up ANONIM
    const recaptchaToken = await mintRecaptchaToken();
    if (!recaptchaToken) return { error: "recaptcha token gagal", address };
    const suRes = await fetchWithJar(jar, `${BASE}/nextjs-api/sign-up`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: BASE,
        Referer: BASE + "/agent",
      },
      body: JSON.stringify({ recaptchaToken, provisionalUserId }),
      signal: AbortSignal.timeout(20_000),
    });
    log.push({
      step: "signup-anon",
      status: suRes.status,
      cookieNames: jar.names(),
    });
    if (suRes.status !== 200) return { address, log };

    // 4) magic-link dengan cookie anon (Set-Cookie response ikut di-merge)
    const mlRes = await fetchWithJar(
      jar,
      `${BASE}/nextjs-api/sign-up/magic-link`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Origin: BASE,
          Referer: BASE + "/agent",
        },
        body: JSON.stringify({
          email: address,
          fullName: "Test Arena",
          shouldLinkHistory: false,
          marketingConsent: false,
          registeredCountryCode: "US",
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    log.push({
      step: "magic-link",
      status: mlRes.status,
      cookieNames: jar.names(),
    });

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
    const polls: Array<Record<string, unknown>> = [];
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
        polls.push({ poll: i, count: members.length });
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
      } catch (error) {
        polls.push({ poll: i, error: String(error) });
      }
    }
    log.push({
      step: "poll",
      polls,
      callbackUrl: callbackUrl.slice(0, 100) || null,
    });
    if (!callbackUrl) return { address, log };

    // 6) Callback: ikuti redirect MANUAL (redirect:"manual" + Location sendiri)
    //    sambil merge Set-Cookie dari SETIAP hop — seperti perilaku browser.
    const { response: cbRes, hops } = await followRedirectsWithJar(
      jar,
      callbackUrl,
      {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        },
      },
      6,
    );
    const setPasswordHop = hops.find((h) =>
      h.location?.includes("/auth/set-password"),
    );
    const setPasswordToken =
      setPasswordHop?.location?.match(/token=([^&]+)/)?.[1] ?? "";
    log.push({
      step: "callback",
      status: cbRes.status,
      hops,
      hasToken: Boolean(setPasswordToken),
      cookieNames: jar.names(),
    });
    if (!setPasswordToken) return { address, log };

    // 7) set-password dengan cookie sesi (anon + provisional baru)
    const spRes = await fetchWithJar(
      jar,
      `${BASE}/nextjs-api/auth/set-password`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Origin: BASE,
          Referer: BASE + "/agent",
        },
        body: JSON.stringify({ password, token: setPasswordToken }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    log.push({
      step: "set-password",
      status: spRes.status,
      cookieNames: jar.names(),
    });

    // 8) /api/me
    const meRes = await fetchWithJar(jar, `${BASE}/api/me`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/event-stream, */*",
        Origin: BASE,
        Referer: BASE + "/agent",
      },
      signal: AbortSignal.timeout(15_000),
    });
    log.push({ step: "me", status: meRes.status });

    const hasV10 = jar.has("arena-auth-prod-v1.0");
    const hasV11 = jar.has("arena-auth-prod-v1.1");

    // 9) Isolasi auth create-chat (token null: 401 = auth gagal, 403 = auth OK)
    const chatNullRes = await fetchWithJar(
      jar,
      `${BASE}/nextjs-api/stream/create-chat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Accept: "application/json, text/event-stream, */*",
          Origin: BASE,
          Referer: BASE + "/agent",
        },
        body: JSON.stringify({
          message: {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "halo tes setelah upgrade email" }],
          },
          timezone: "Asia/Jakarta",
          recaptchaV2Token: null,
          recaptchaV3Token: null,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    log.push({ step: "chat-null-token", status: chatNullRes.status });

    // 10) create-chat DENGAN token reCAPTCHA — status inilah yang menentukan
    //     kesiapan sesi (200/201 = akun benar-benar bisa chat).
    let chatAuth = chatNullRes.status;
    const chatToken = await mintRecaptchaToken();
    if (chatToken) {
      const chatRes = await fetchWithJar(
        jar,
        `${BASE}/nextjs-api/stream/create-chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": UA,
            Accept: "application/json, text/event-stream, */*",
            Origin: BASE,
            Referer: BASE + "/agent",
          },
          body: JSON.stringify({
            message: {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "halo tes setelah upgrade email" }],
            },
            timezone: "Asia/Jakarta",
            recaptchaV2Token: null,
            recaptchaV3Token: chatToken,
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      chatAuth = chatRes.status;
    }
    log.push({ step: "chat-real-token", status: chatAuth });

    // Simpan sesi final HANYA kalau /api/me 200 — jangan menimpa sesi user
    // yang sudah terhubung dengan sesi temp yang rusak.
    if (meRes.status === 200) {
      const saveClientId = clientId?.trim() || "temp-mail-magiclink";
      await ctx.runMutation(internal.arenaSession.upsert, {
        clientId: saveClientId,
        cookie: jar.header(),
        name: "Temp MagicLink",
        email: address,
      });
    }

    return {
      ok: chatAuth === 200 || chatAuth === 201,
      hasV10,
      hasV11,
      chatAuth,
      cookieNames: jar.names(),
      address,
      log,
    };
  },
});
