import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/** Pecah Set-Cookie jadi pasangan bersih (getSetCookie). */
function collectSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers
      .getSetCookie()
      .map((c: string) => c.split(";")[0].trim())
      .filter(Boolean);
  }
  return [];
}

/** Gabungkan cookie lama + pasangan baru (name=value terakhir menang). */
function mergeCookies(existing: string, newPairs: string[]): string {
  const map = new Map<string, string>();
  for (const pair of existing.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  for (const pair of newPairs) {
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return Array.from(map.entries())
    .map(([k, val]) => `${k}=${val}`)
    .join("; ");
}

const BASE = "https://arena.ai";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/**
 * Scan bundle JS arena.ai untuk menemukan endpoint API yang dipakai frontend
 * (khususnya yang berkaitan dengan signup/link email/complete profile).
 */
export const debugFindEndpoints = action({
  args: {},
  handler: async (): Promise<Record<string, unknown>> => {
    const htmlRes = await fetch(`${BASE}/agent`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(20_000),
    });
    const html = await htmlRes.text();
    const scripts = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map(
      (m) => m[1],
    );
    // Prioritas: chunk halaman agent/layout dulu, lalu sisanya (kecuali polyfill
    // webpack/beacon), maksimal 14 script.
    const priority = scripts.filter((s) =>
      s.includes("agent/page") || s.includes("agent/layout"),
    );
    const rest = scripts.filter(
      (s) =>
        !priority.includes(s) &&
        !s.includes("polyfills") &&
        !s.includes("webpack") &&
        !s.includes("cloudflareinsights"),
    );
    const targets = [...priority, ...rest].slice(0, 14);

    const keywords = [
      "sign-up",
      "signup",
      "provisional",
      "magic-link",
      "magic_link",
      "tou-consent",
      "touConsent",
      "complete-signup",
      "link-email",
      "set-password",
      "create-chat",
      "username",
      "emailProvider",
    ];
    const found: Record<
      string,
      { size: number; hits: string[]; nextjsApi?: string[] }
    > = {};
    for (const src of targets) {
      const url = new URL(src, BASE).toString();
      let js = "";
      try {
        const jsRes = await fetch(url, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(30_000),
        });
        js = await jsRes.text();
      } catch {
        continue;
      }
      const hits = new Set<string>();
      for (const kw of keywords) {
        if (js.includes(kw)) hits.add(kw);
      }
      if (hits.size === 0) continue;
      // kumpulkan snippet endpoint di sekitar keyword
      const snippets: string[] = [];
      for (const m of js.matchAll(
        /["'`]\/nextjs-api\/[a-zA-Z0-9_\-/{}.:?=&]+["'`]/g,
      )) {
        snippets.push(m[0]);
      }
      found[url.slice(-80)] = {
        size: js.length,
        hits: [...hits],
        nextjsApi: [...new Set(snippets)].slice(0, 40),
      };
    }
    return {
      htmlStatus: htmlRes.status,
      scriptCount: scripts.length,
      scanned: targets.length,
      found,
    };
  },
});

/**
 * Probe endpoint yang mungkin melengkapi user temp (TOU consent, link email,
 * update profile) lalu cek /api/me + create-chat setelah tiap langkah.
 */
export const debugProbeUserEndpoints = action({
  args: { email: v.optional(v.string()) },
  handler: async (ctx, { email }): Promise<Record<string, unknown>> => {
    const session = await ctx.runQuery(internal.arenaSession.firstSession, {});
    if (!session) {
      return { error: "Tidak ada sesi tersimpan di Convex." };
    }
    const targetEmail = email ?? "probe" + Date.now() % 100000 + "@emalupe.com";
    const candidates: Array<{ name: string; method: string; path: string; body?: Record<string, unknown> }> = [
      { name: "tou-consent", method: "POST", path: "/nextjs-api/tou-consent", body: {} },
      { name: "user/tou-consent", method: "POST", path: "/nextjs-api/user/tou-consent", body: {} },
      { name: "user/update", method: "POST", path: "/nextjs-api/user/update", body: { username: "testuser" + Date.now() % 100000, email: targetEmail } },
      { name: "user", method: "POST", path: "/nextjs-api/user", body: { username: "testuser" + Date.now() % 100000, email: targetEmail } },
      { name: "link-email", method: "POST", path: "/nextjs-api/link-email", body: { email: targetEmail } },
      { name: "sign-up/complete", method: "POST", path: "/nextjs-api/sign-up/complete", body: { email: targetEmail } },
      { name: "profile", method: "POST", path: "/nextjs-api/profile", body: { username: "testuser" + Date.now() % 100000 } },
    ];

    const results: Array<Record<string, unknown>> = [];
    let cookie = session.cookie;
    let meStatus = 0;
    for (const c of candidates) {
      let res: Response;
      try {
        res = await fetch(`${BASE}${c.path}`, {
          method: c.method,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": UA,
            Origin: BASE,
            Referer: BASE + "/agent",
            Cookie: cookie,
          },
          body: JSON.stringify(c.body ?? {}),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        results.push({ endpoint: c.name, error: String(error) });
        continue;
      }
      const bodyText = (await res.text()).slice(0, 200);
      results.push({
        endpoint: c.name,
        status: res.status,
        body: bodyText,
        setCookies: collectSetCookies(res).length,
      });
      if (res.ok && collectSetCookies(res).length > 0) {
        cookie = mergeCookies(cookie, collectSetCookies(res));
      }
      if (res.ok && res.status !== 204) {
        const meRes = await fetch(`${BASE}/api/me`, {
          headers: {
            "User-Agent": UA,
            Accept: "application/json, text/event-stream, */*",
            Origin: BASE,
            Referer: BASE + "/agent",
            Cookie: cookie,
          },
          signal: AbortSignal.timeout(15_000),
        });
        meStatus = meRes.status;
        const meBody = (await meRes.text()).slice(0, 250);
        results.push({ endpoint: c.name + "->me", status: meStatus, body: meBody });
        if (meStatus === 200 && meBody.includes("\"email\":\"\"")) {
          // email masih kosong — lanjut coba endpoint lain
        }
      }
    }
    return { targetEmail, results };
  },
});

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode UTF-8 ke base64url (tanpa padding). */
function b64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let result = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      result += B64_ALPHABET[(buffer >> bits) & 0x3f];
    }
  }
  if (bits > 0) result += B64_ALPHABET[(buffer << (6 - bits)) & 0x3f];
  return result;
}

/**
 * Isolasi auth create-chat: 401 = auth gagal, 403/400 = auth OK (baru recaptcha).
 * Coba varian konstruksi cookie v1.0/v1.1 dari sesi temp tersimpan.
 */
export const debugChatCookieVariants = action({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const session = await ctx.runQuery(internal.arenaSession.firstSession, {});
    if (!session) {
      return { error: "Tidak ada sesi tersimpan di Convex." };
    }
    const cookie = session.cookie;
    const v10 = cookie.match(/arena-auth-prod-v1\.0=([^;]+)/)?.[1] ?? "";
    const v11 = cookie.match(/arena-auth-prod-v1\.1=([^;]+)/)?.[1] ?? "";
    const v1old = cookie.match(/arena-auth-prod-v1=([^;]+)/)?.[1] ?? "";

    // Decode JSON sesi dari cookie tersimpan
    let json = "";
    if (v10.startsWith("base64-")) {
      json = b64UrlDecode(v10.slice(7) + v11);
    } else if (v1old.startsWith("base64-")) {
      json = b64UrlDecode(v1old.slice(7));
    }
    if (!json) return { error: "Sesi tanpa v1.0/v1.1 yang bisa di-decode." };

    const encoded = "base64-" + b64UrlEncode(json);
    const base = (pairs: string[]) => mergeCookies(cookie, pairs);
    const variants: Array<{ name: string; cookie: string }> = [
      { name: "as-stored", cookie },
      // tanpa v1.1 sama sekali
      {
        name: "v1.0-only-no-v11",
        cookie: mergeCookies(
          cookie.replace(/;\s*arena-auth-prod-v1\.1=[^;]*/, ""),
          [`arena-auth-prod-v1.0=${encoded}`],
        ).replace(/;\s*arena-auth-prod-v1\.1=[^;]*/, ""),
      },
      // v1.1 non-kosong: potong di 3180 seperti browser
      {
        name: "split-at-3180",
        cookie: base([
          `arena-auth-prod-v1.0=${encoded.slice(0, 3180)}`,
          `arena-auth-prod-v1.1=${encoded.slice(3180)}`,
        ]),
      },
      // v1.1 dummy non-kosong
      {
        name: "v1.1-dummy",
        cookie: base([
          `arena-auth-prod-v1.0=${encoded}`,
          `arena-auth-prod-v1.1=zzz`,
        ]),
      },
      // hanya cookie lama v1
      {
        name: "v1-only",
        cookie: `arena-auth-prod-v1=${v1old}`,
      },
      // tanpa cookie auth sama sekali
      { name: "no-auth", cookie: "" },
    ];

    const results = [];
    for (const v of variants) {
      let res: Response;
      try {
        res = await fetch(`${BASE}/nextjs-api/stream/create-chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": UA,
            Accept: "application/json, text/event-stream, */*",
            Origin: BASE,
            Referer: BASE + "/agent",
            ...(v.cookie ? { Cookie: v.cookie } : {}),
          },
          body: JSON.stringify({
            message: {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "halo tes auth" }],
            },
            timezone: "Asia/Jakarta",
            recaptchaV2Token: null,
            recaptchaV3Token: null,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        results.push({ variant: v.name, error: String(error) });
        continue;
      }
      results.push({
        variant: v.name,
        status: res.status,
        body: (await res.text()).slice(0, 200),
      });
    }
    return {
      sessionEmail: session.email,
      encodedLen: encoded.length,
      results,
    };
  },
});

/** Decode base64/base64url ke UTF-8 (toleran tanpa padding). */
function b64UrlDecode(s: string): string {
  const cleaned = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of cleaned) {
    const val = B64_ALPHABET.indexOf(ch);
    if (val === -1) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

const MAIL_TM = "https://api.mail.tm";
const RECAPTCHA_KEY = "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0";
const RECAPTCHA_ORIGIN_B64 = "aHR0cHM6Ly9sbWFyZW5hLmFp";
const RECAPTCHA_VERSION = "XOqlk8PL_yVx6IdpLbpXdiLy";

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
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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
 * Alur LENGKAP ala browser: anonim (sign-up tanpa email) -> upgrade email via
 * Supabase updateUser -> konfirmasi dari mailbox temp -> refresh sesi ->
 * /api/me + create-chat. Kunci tebakan: create-chat butuh user NON-anonim
 * (email terkonfirmasi).
 */
export const debugAnonymousUpgrade = action({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
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

    // 2) Ambil provisional_user_id dari GET /agent
    const visitRes = await fetch(`${BASE}/agent`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const visitCookies = collectSetCookies(visitRes).join("; ");
    const provisionalUserId =
      visitCookies.match(/provisional_user_id=([^;]+)/)?.[1] ?? "";
    log.push({ step: "visit", status: visitRes.status, provisionalUserId });
    if (!provisionalUserId) {
      return { error: "provisional_user_id tidak diset oleh GET /agent", address };
    }

    // 3) sign-up ANONIM (tanpa email) — persis seperti frontend
    const recaptchaToken = await mintRecaptchaToken();
    if (!recaptchaToken) return { error: "recaptcha token gagal", address };
    const suRes = await fetch(`${BASE}/nextjs-api/sign-up`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: visitCookies,
      },
      body: JSON.stringify({ recaptchaToken, provisionalUserId }),
      signal: AbortSignal.timeout(20_000),
    });
    const suBody = await suRes.text();
    let session: Record<string, unknown> = {};
    try {
      session = JSON.parse(suBody) as Record<string, unknown>;
    } catch {
      // bukan JSON
    }
    const suCookie = mergeCookies(visitCookies, collectSetCookies(suRes));
    log.push({
      step: "signup-anon",
      status: suRes.status,
      setCookies: collectSetCookies(suRes).map((c) => c.split("=")[0]),
      body: suBody.slice(0, 200),
    });
    if (suRes.status !== 200) {
      return { address, log };
    }

    const accessToken = (session.access_token as string) ?? "";
    const refreshToken = (session.refresh_token as string) ?? "";
    if (!accessToken) return { error: "session tanpa access_token", address, log };

    // 4) updateUser({email}) — upgrade anonim -> email
    let supabaseUrl = "";
    try {
      const payload = JSON.parse(
        b64UrlDecode(accessToken.split(".")[1] ?? ""),
      ) as { iss?: string };
      supabaseUrl = (payload.iss ?? "").replace(/\/auth\/v1$/, "");
    } catch {
      // ignore
    }
    if (!supabaseUrl) {
      return { error: "supabase url tidak bisa diekstrak", address, log };
    }
    log.push({ step: "supabase-url", url: supabaseUrl });

    const updateRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": UA,
      },
      body: JSON.stringify({ email: address }),
      signal: AbortSignal.timeout(15_000),
    });
    const updateBody = await updateRes.text();
    log.push({ step: "updateUser", status: updateRes.status, body: updateBody.slice(0, 200) });
    if (updateRes.status !== 200) {
      return { address, log };
    }

    // 5) Token mail.tm + poll inbox untuk email konfirmasi Supabase
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

    let confirmUrl = "";
    const polls: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 8 && !confirmUrl; i++) {
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
            /https:\/\/[a-z0-9-]+\.supabase\.co\/auth\/v1\/verify[^\s"<]+/i,
          );
          if (match) {
            confirmUrl = match[0];
            break;
          }
        }
      } catch (error) {
        polls.push({ poll: i, error: String(error) });
      }
    }
    log.push({ step: "poll-confirm", polls, confirmUrl: confirmUrl.slice(0, 160) || null });
    if (!confirmUrl) {
      return { address, log };
    }

    // 6) Klik link konfirmasi (redirect manual)
    let confirmStatus = 0;
    let cur = confirmUrl;
    for (let i = 0; i < 5; i++) {
      const r = await fetch(cur, {
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
        signal: AbortSignal.timeout(15_000),
      });
      confirmStatus = r.status;
      const loc = r.headers.get("location");
      if (loc) {
        cur = new URL(loc, cur).toString();
      } else {
        break;
      }
    }
    log.push({ step: "confirm-click", status: confirmStatus });

    // 7) Refresh sesi -> user sekarang ber-email
    const refreshRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshToken}`,
        "User-Agent": UA,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
    const refreshBody = await refreshRes.text();
    log.push({ step: "refresh", status: refreshRes.status, body: refreshBody.slice(0, 150) });
    let refreshed: Record<string, unknown> = {};
    try {
      refreshed = JSON.parse(refreshBody) as Record<string, unknown>;
    } catch {
      // ignore
    }
    const newAccess = (refreshed.access_token as string) ?? "";
    const newRefresh = (refreshed.refresh_token as string) ?? refreshToken;

    // 8) Bangun cookie v1.0/v1.1 dari sesi baru
    const sessionJson = JSON.stringify({
      access_token: newAccess,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: newRefresh,
      user: refreshed.user ?? null,
    });
    const encoded = "base64-" + b64UrlEncode(sessionJson);
    const finalCookie = mergeCookies(suCookie, [
      `arena-auth-prod-v1.0=${encoded.slice(0, 3180)}`,
      `arena-auth-prod-v1.1=${encoded.slice(3180)}`,
    ]);

    // 9) Tes /api/me
    const meRes = await fetch(`${BASE}/api/me`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/event-stream, */*",
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: finalCookie,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const meBody = await meRes.text();
    log.push({ step: "me-final", status: meRes.status, body: meBody.slice(0, 250) });

    // 10) Tes create-chat (token null dulu: kalau auth lolos, error jadi
    //     recaptcha 403, bukan 401 Login required)
    const chatRes = await fetch(`${BASE}/nextjs-api/stream/create-chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Accept: "application/json, text/event-stream, */*",
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: finalCookie,
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
    const chatBody = await chatRes.text();
    log.push({ step: "chat-null-token", status: chatRes.status, body: chatBody.slice(0, 200) });

    // Simpan sesi final kalau /api/me 200
    if (meRes.status === 200) {
      await ctx.runMutation(internal.arenaSession.upsert, {
        clientId: "temp-mail-upgraded",
        cookie: finalCookie,
        name: "Temp Upgraded",
        email: address,
      });
    }

    return {
      address,
      password,
      encodedLen: encoded.length,
      log,
    };
  },
});

/**
 * Alur upgrade anonim -> email via magic-link, persis urutan browser:
 * anon sign-up -> magic-link (dengan cookie anon) -> callback -> set-password
 * -> cek /api/me + create-chat. Set-password seharusnya meng-upgrade user
 * anonim yang sama (Supabase anonymous conversion), bukan membuat user baru.
 */
export const debugAnonUpgradeViaMagicLink = action({
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

    // 2) Kunjungan pertama -> provisional_user_id
    const visitRes = await fetch(`${BASE}/agent`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    let cookie = collectSetCookies(visitRes).join("; ");
    const provisionalUserId =
      cookie.match(/provisional_user_id=([^;]+)/)?.[1] ?? "";
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
        Cookie: cookie,
      },
      body: JSON.stringify({ recaptchaToken, provisionalUserId }),
      signal: AbortSignal.timeout(20_000),
    });
    const suBody = await suRes.text();
    cookie = mergeCookies(cookie, collectSetCookies(suRes));
    log.push({
      step: "signup-anon",
      status: suRes.status,
      setCookies: collectSetCookies(suRes).map((c) => c.split("=")[0]),
      body: suBody.slice(0, 150),
    });
    if (suRes.status !== 200) return { address, log };

    // 4) magic-link dengan cookie anon
    const mlRes = await fetch(`${BASE}/nextjs-api/sign-up/magic-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: cookie,
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
    log.push({
      step: "magic-link",
      status: mlRes.status,
      body: (await mlRes.text()).slice(0, 200),
    });

    // 5) Token mail.tm + poll inbox
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
    log.push({ step: "poll", polls, callbackUrl: callbackUrl.slice(0, 100) || null });
    if (!callbackUrl) return { address, log };

    // 6) Follow callback redirect, kumpulkan cookie + token set-password
    let current = callbackUrl;
    let setPasswordToken = "";
    const hops = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(current, {
        redirect: "manual",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(15_000),
      });
      const loc = r.headers.get("location");
      const pairs = collectSetCookies(r);
      if (pairs.length > 0) cookie = mergeCookies(cookie, pairs);
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
        Cookie: cookie,
      },
      body: JSON.stringify({ password, token: setPasswordToken }),
      signal: AbortSignal.timeout(20_000),
    });
    const spBody = await spRes.text();
    const spPairs = collectSetCookies(spRes);
    cookie = mergeCookies(cookie, spPairs);
    log.push({
      step: "set-password",
      status: spRes.status,
      setCookies: spPairs.map((c) => c.split("=")[0]),
      body: spBody.slice(0, 200),
    });

    // 8) /api/me
    const meRes = await fetch(`${BASE}/api/me`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/event-stream, */*",
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: cookie,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const meBody = await meRes.text();
    log.push({ step: "me", status: meRes.status, body: meBody.slice(0, 300) });

    // 9) create-chat (null token untuk isolasi auth)
    const chatRes = await fetch(`${BASE}/nextjs-api/stream/create-chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Accept: "application/json, text/event-stream, */*",
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: cookie,
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
    log.push({
      step: "chat-null-token",
      status: chatRes.status,
      body: (await chatRes.text()).slice(0, 200),
    });

    // Simpan sesi final (kalau ada cookie v1.0/v1.1)
    const hasV10 = /arena-auth-prod-v1\.0=/.test(cookie);
    const saveClientId = clientId?.trim() || "temp-mail-magiclink";
    await ctx.runMutation(internal.arenaSession.upsert, {
      clientId: saveClientId,
      cookie,
      name: "Temp MagicLink",
      email: address,
    });

    return {
      address,
      password,
      hasV10,
      cookieNames: cookie.split(";").map((c) => c.split("=")[0].trim()),
      log,
    };
  },
});

/**
 * Decode isi cookie v1.0+v1.1 semua sesi tersimpan, bandingkan struktur JSON
 * sesi browser (wondywansy) vs sesi temp (email sementara) — untuk tahu apakah
 * format cookie kita sudah benar atau beda dari yang dibuat browser.
 */
export const debugDecodeCookies = action({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const sessions = await ctx.runQuery(internal.arenaSession.allSessions, {});
    const results = [];
    for (const s of sessions) {
      const v10 = s.cookie.match(/arena-auth-prod-v1\.0=([^;]+)/)?.[1] ?? "";
      const v11 = s.cookie.match(/arena-auth-prod-v1\.1=([^;]+)/)?.[1] ?? "";
      const v1old = s.cookie.match(/arena-auth-prod-v1=([^;]+)/)?.[1] ?? "";
      let decoded: Record<string, unknown> | null = null;
      let note = "";
      if (v10.startsWith("base64-")) {
        try {
          decoded = JSON.parse(
            b64UrlDecode(v10.slice(7) + v11),
          ) as Record<string, unknown>;
        } catch (error) {
          note = `decode error: ${String(error)}`;
        }
      } else if (v10) {
        note = "v1.0 tanpa prefix base64-";
      } else if (v1old.startsWith("base64-")) {
        try {
          decoded = JSON.parse(
            b64UrlDecode(v1old.slice(7)),
          ) as Record<string, unknown>;
          note = "dari v1 (lama)";
        } catch (error) {
          note = `v1 decode error: ${String(error)}`;
        }
      }
      const user = (decoded?.user ?? null) as
        | (Record<string, unknown> & { email?: string; id?: string })
        | null;
      const supabaseUser = (decoded?.supabaseUser ?? null) as
        | (Record<string, unknown> & { email?: string; id?: string })
        | null;
      results.push({
        clientId: s.clientId,
        email: s.email,
        v10Len: v10.length,
        v11Len: v11.length,
        hasV1old: Boolean(v1old),
        note,
        topKeys: decoded ? Object.keys(decoded) : null,
        userKeys: user ? Object.keys(user) : null,
        userEmail: user?.email ?? null,
        userId: user?.id ?? null,
        userConfirmedAt: user?.confirmed_at ?? null,
        userIsAnonymous: user?.is_anonymous ?? null,
        supabaseEmail: supabaseUser?.email ?? null,
        supabaseConfirmedAt: supabaseUser?.confirmed_at ?? null,
        supabaseEmailConfirmedAt: supabaseUser?.email_confirmed_at ?? null,
        supabaseIsAnonymous: supabaseUser?.is_anonymous ?? null,
        hasRefresh: Boolean(decoded?.refresh_token),
        hasAccess: Boolean(decoded?.access_token),
      });
    }
    return { results };
  },
});

/**
 * Tampilkan body /api/me LENGKAP untuk semua sesi tersimpan — untuk membandingkan
 * field yang membedakan sesi valid (browser) vs sesi temp (email sementara).
 */
export const debugMeBodies = action({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const sessions = await ctx.runQuery(internal.arenaSession.allSessions, {});
    const results = [];
    for (const s of sessions) {
      const res = await fetch(`${BASE}/api/me`, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json, text/event-stream, */*",
          Origin: BASE,
          Referer: BASE + "/agent",
          Cookie: s.cookie,
        },
        signal: AbortSignal.timeout(15_000),
      });
      results.push({
        clientId: s.clientId,
        status: res.status,
        body: (await res.text()).slice(0, 1800),
      });
    }
    return { results };
  },
});
