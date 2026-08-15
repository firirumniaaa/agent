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
