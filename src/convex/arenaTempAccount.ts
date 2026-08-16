import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * ===== Cookie jar =====
 *
 * Jangan pernah cuma membaca `response.headers.get("set-cookie")` — itu sering
 * hanya berisi sebagian atau format gabungan yang susah di-parse (Expires
 * memuat koma). Yang benar: pakai `getSetCookie()` (tersedia di Node 18+ /
 * runtime Convex) yang mengembalikan SATU STRING PER COOKIE, lalu merge semua
 * pasangan ke jar (Map name -> value, name terakhir menang).
 */

/** Pecah SEMUA header Set-Cookie dari response (bukan cuma cookie pertama). */
function collectSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers
      .getSetCookie()
      .map((c: string) => c.split(";")[0].trim())
      .filter(Boolean);
  }
  // Fallback manual: header "set-cookie" bisa menggabungkan beberapa cookie
  // dengan koma — koma hanya pemisah kalau bukan bagian dari Expires=
  // (perilaku set-cookie-parser.splitCookiesString).
  const header = headers.get("set-cookie") ?? "";
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < header.length) {
    const ch = header[i];
    if (ch === ",") {
      const tail = current.slice(current.lastIndexOf(";") + 1);
      if (!/expires=/i.test(tail)) {
        parts.push(current.trim());
        current = "";
        i++;
        continue;
      }
    }
    current += ch;
    i++;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((c) => c.split(";")[0].trim()).filter(Boolean);
}

/**
 * Merge SEMUA pasangan Set-Cookie dari response ke jar. Harus dipanggil
 * setelah TIAP request penting: signup, magic-link, callback, set-password,
 * /me, chat — supaya sesi akhir lengkap (v1.0 + v1.1 + cookie pendukung).
 */
function mergeResponseCookies(
  jar: Map<string, string>,
  res: Response,
): Map<string, string> {
  for (const pair of collectSetCookies(res)) {
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return jar;
}

/** Bangun header Cookie dari jar. */
function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

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
 * Alur upgrade anonim -> email via magic-link, persis urutan browser:
 * anon sign-up -> magic-link (dengan cookie anon) -> callback -> set-password
 * -> cek /api/me + create-chat.
 *
 * Kunci: SEMUA Set-Cookie dari setiap request di-merge ke jar
 * (getSetCookie, bukan cuma cookie pertama), jadi sesi akhir lengkap
 * (arena-auth-prod-v1.0 + v1.1 + cookie pendukung).
 *
 * Hasil akhir melaporkan `hasV10`, `hasV11`, dan `chatAuth` (status
 * create-chat dengan token reCAPTCHA). Sesi disimpan HANYA kalau /api/me 200
 * — supaya tidak menimpa sesi user yang sudah terhubung dengan sesi rusak.
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

    // 2) Kunjungan pertama -> provisional_user_id (jar mulai diisi dari /agent)
    const jar = new Map<string, string>();
    const visitRes = await fetch(`${BASE}/agent`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    mergeResponseCookies(jar, visitRes);
    const provisionalUserId = jar.get("provisional_user_id") ?? "";
    log.push({ step: "visit", status: visitRes.status, provisionalUserId });

    // 3) sign-up ANONIM
    const recaptchaToken = await mintRecaptchaToken();
    if (!recaptchaToken) return { error: "recaptcha token gagal", address };
    const suRes = await fetch(`${BASE}/nextjs-api/sign-up`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({ recaptchaToken, provisionalUserId }),
      signal: AbortSignal.timeout(20_000),
    });
    const suBody = await suRes.text();
    mergeResponseCookies(jar, suRes);
    log.push({
      step: "signup-anon",
      status: suRes.status,
      setCookies: collectSetCookies(suRes).map((c) => c.split("=")[0]),
      body: suBody.slice(0, 150),
    });
    if (suRes.status !== 200) return { address, log };

    // 4) magic-link dengan cookie anon — MERGE Set-Cookie response juga
    const mlRes = await fetch(`${BASE}/nextjs-api/sign-up/magic-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        email: address,
        fullName: "Test Arena",
        shouldLinkHistory: false,
        marketingConsent: false,
        registeredCountryCode: "US",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    mergeResponseCookies(jar, mlRes);
    log.push({
      step: "magic-link",
      status: mlRes.status,
      setCookies: collectSetCookies(mlRes).map((c) => c.split("=")[0]),
      body: (await mlRes.text()).slice(0, 200),
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

    // 6) Follow callback redirect — merge cookie tiap hop + ambil token set-password
    let current = callbackUrl;
    let setPasswordToken = "";
    const hops = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(current, {
        redirect: "manual",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          Cookie: cookieHeader(jar),
        },
        signal: AbortSignal.timeout(15_000),
      });
      const loc = r.headers.get("location");
      mergeResponseCookies(jar, r);
      hops.push({ hop: i, status: r.status, loc: loc?.slice(0, 80) ?? null });
      if (loc) {
        if (loc.includes("/auth/set-password")) {
          setPasswordToken = loc.match(/token=([^&]+)/)?.[1] ?? "";
        }
        current = new URL(loc, current).toString();
      } else {
        break;
      }
    }
    log.push({ step: "callback", hops, hasToken: Boolean(setPasswordToken) });
    if (!setPasswordToken) return { address, log };

    // 7) set-password dengan cookie sesi (anon + provisional baru)
    const spRes = await fetch(`${BASE}/nextjs-api/auth/set-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({ password, token: setPasswordToken }),
      signal: AbortSignal.timeout(20_000),
    });
    const spBody = await spRes.text();
    mergeResponseCookies(jar, spRes);
    const spPairs = collectSetCookies(spRes);
    log.push({
      step: "set-password",
      status: spRes.status,
      setCookies: spPairs.map((c) => c.split("=")[0]),
      body: spBody.slice(0, 200),
    });

    // 8) /api/me (merge Set-Cookie kalau ada)
    const meRes = await fetch(`${BASE}/api/me`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/event-stream, */*",
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: cookieHeader(jar),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const meBody = await meRes.text();
    mergeResponseCookies(jar, meRes);
    log.push({ step: "me", status: meRes.status, body: meBody.slice(0, 300) });

    const hasV10 = jar.has("arena-auth-prod-v1.0");
    const hasV11 = jar.has("arena-auth-prod-v1.1");

    // 9) Isolasi auth create-chat (token null: 401 = auth gagal, 403 = auth OK)
    const chatNullRes = await fetch(`${BASE}/nextjs-api/stream/create-chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Accept: "application/json, text/event-stream, */*",
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: cookieHeader(jar),
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
    });
    mergeResponseCookies(jar, chatNullRes);
    log.push({
      step: "chat-null-token",
      status: chatNullRes.status,
      body: (await chatNullRes.text()).slice(0, 200),
    });

    // 10) create-chat DENGAN token reCAPTCHA — status inilah yang dipakai
    //     untuk menentukan ok (200/201 = akun benar-benar bisa chat).
    let chatAuth = chatNullRes.status;
    const chatToken = await mintRecaptchaToken();
    if (chatToken) {
      const chatRes = await fetch(`${BASE}/nextjs-api/stream/create-chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Accept: "application/json, text/event-stream, */*",
          Origin: BASE,
          Referer: BASE + "/agent",
          Cookie: cookieHeader(jar),
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
      });
      chatAuth = chatRes.status;
      mergeResponseCookies(jar, chatRes);
      log.push({
        step: "chat-real-token",
        status: chatRes.status,
        body: (await chatRes.text()).slice(0, 200),
      });
    } else {
      log.push({
        step: "chat-real-token",
        status: chatAuth,
        body: "token reCAPTCHA gagal di-mint",
      });
    }

    // Simpan sesi final HANYA kalau /api/me 200 — jangan timpa sesi user yang
    // sudah terhubung dengan sesi temp yang rusak.
    if (meRes.status === 200) {
      const saveClientId = clientId?.trim() || "temp-mail-magiclink";
      await ctx.runMutation(internal.arenaSession.upsert, {
        clientId: saveClientId,
        cookie: cookieHeader(jar),
        name: "Temp MagicLink",
        email: address,
      });
    }

    return {
      address,
      password,
      hasV10,
      hasV11,
      chatAuth,
      cookieNames: Array.from(jar.keys()),
      log,
    };
  },
});
