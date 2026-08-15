import { ConvexError, v } from "convex/values";
import { api, internal } from "./_generated/api";
import { action, httpAction } from "./_generated/server";

const BASE = "https://arena.ai";
const READ_MS = 120_000; // sama seperti READ_SECONDS = 120 di script

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function arenaHeaders(cookie: string, jsonBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/json, text/event-stream, */*",
    Origin: BASE,
    Referer: BASE + "/agent",
    Cookie: cookie,
  };
  if (jsonBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/** Ekstrak info user dari respons /api/me yang bentuknya tidak terdokumentasi. */
function extractUser(body: string) {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const source = (parsed.user ??
      (parsed.data as Record<string, unknown> | undefined)?.user ??
      parsed) as Record<string, unknown>;
    const str = (value: unknown) =>
      typeof value === "string" && value.length > 0 ? value : undefined;
    return {
      arenaUserId: str(source.id) ?? str(source.userId),
      name: str(source.name) ?? str(source.displayName) ?? str(source.username),
      email: str(source.email),
    };
  } catch {
    return { arenaUserId: undefined, name: undefined, email: undefined };
  }
}

/** Cookie auth wajib ada — seperti output bookmarklet "ARENA AUTH COOKIES". */
const REQUIRED_AUTH_COOKIES = [
  "arena-auth-prod-v1.0",
  "arena-auth-prod-v1.1",
];

/** Cek cookie yang kurang (case-insensitive, toleran spasi/newline). */
function missingAuthCookies(cookie: string): string[] {
  return REQUIRED_AUTH_COOKIES.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|;)\\s*${escaped}=`, "i");
    return !re.test(cookie);
  });
}

/** Validasi cookie terhadap /api/me lalu simpan sesi. */
export const login = action({
  args: { clientId: v.string(), cookie: v.string() },
  handler: async (ctx, { clientId, cookie }) => {
    const trimmed = cookie.trim();
    if (!trimmed) {
      throw new ConvexError("Cookie kosong. Tempel cookie arena.ai dulu.");
    }

    // Cookie harus LENGKAP — seluruh hasil document.cookie (bukan cuma 2 cookie
    // auth). Kalau auth cookie kurang, /api/me pasti gagal → tolak lebih awal
    // dengan pesan yang jelas.
    const missing = missingAuthCookies(trimmed);
    if (missing.length > 0) {
      return {
        ok: false as const,
        status: 400,
        body: `Cookie belum lengkap. Yang kurang: ${missing.join(", ")}. Tempel SELURUH hasil document.cookie dari arena.ai (semua cookie, dipisah titik koma), bukan cuma 2 cookie auth.`,
        user: null,
      };
    }

    let res: Response;
    try {
      res = await fetch(`${BASE}/api/me`, {
        headers: arenaHeaders(trimmed),
        signal: AbortSignal.timeout(READ_MS),
      });
    } catch (error) {
      throw new ConvexError(
        `Gagal menghubungi arena.ai: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const bodyText = await res.text();

    if (res.status !== 200) {
      return {
        ok: false as const,
        status: res.status,
        body: bodyText.slice(0, 500),
        user: null,
      };
    }

    const user = extractUser(bodyText);
    await ctx.runMutation(internal.arenaSession.upsert, {
      clientId,
      cookie: trimmed,
      arenaUserId: user.arenaUserId,
      name: user.name,
      email: user.email,
      raw: bodyText,
    });

    return { ok: true as const, status: 200, user, body: null };
  },
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

/** Ubah body error JSON arena.ai jadi string yang enak dibaca. */
function extractArenaError(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; success?: boolean };
    const err = parsed.error;
    if (typeof err === "string") return err;
    if (parsed.success === false && err && typeof err === "object") {
      const issues = (err as {
        issues?: { path?: Array<string | number>; message?: string }[];
      }).issues;
      const first = issues?.[0];
      if (first) {
        return `Data tidak valid: ${first.message ?? "?"}${
          first.path?.length ? ` (${first.path.join(".")})` : ""
        }`;
      }
    }
  } catch {
    // bukan JSON — pakai teks apa adanya
  }
  return `HTTP ${status}: ${text.slice(0, 300)}`;
}

/**
 * Endpoint chat arena.ai. Dua mode:
 *  - "chat"   (default): /nextjs-api/stream/create-chat — TANPA GitHub, tapi
 *    wajib token reCAPTCHA Enterprise yang di-mint di browser klien.
 *    Respons 200 {id: sessionId} -> dikembalikan sebagai JSON ke klien.
 *  - "coding": /api/coding-agent/sessions — butuh repo GitHub terhubung;
 *    stream respons apa adanya (text/event-stream) ke klien.
 */
export const streamChat = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: {
    clientId?: string;
    message?: string;
    mode?: "chat" | "coding";
    timezone?: string;
    recaptchaV3Token?: string | null;
    repoOwner?: string;
    repoName?: string;
    repoId?: number;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const clientId = body.clientId?.trim();
  const message = body.message?.trim();
  if (!clientId || !message) {
    return jsonResponse(
      { error: "clientId dan message wajib diisi." },
      400,
    );
  }

  const cookie = await ctx.runQuery(internal.arenaSession.getCookie, {
    clientId,
  });
  if (!cookie) {
    return jsonResponse(
      { error: "Sesi belum login. Login dulu dengan cookie arena.ai." },
      401,
    );
  }

  const mode = body.mode === "coding" ? "coding" : "chat";

  // ===== Mode chat biasa (tanpa GitHub, butuh token reCAPTCHA dari browser) =====
  if (mode === "chat") {
    const token = body.recaptchaV3Token?.trim();
    if (!token) {
      return jsonResponse(
        {
          error:
            "Token reCAPTCHA arena belum tersedia. Muat ulang halaman lalu coba kirim lagi.",
        },
        400,
      );
    }
    const payload = {
      message: {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: message }],
      },
      timezone: body.timezone?.trim() || "Asia/Jakarta",
      recaptchaV2Token: null,
      recaptchaV3Token: token,
    };

    let res: Response;
    try {
      res = await fetch(`${BASE}/nextjs-api/stream/create-chat`, {
        method: "POST",
        headers: arenaHeaders(cookie, true),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return jsonResponse(
        {
          error: `Gagal menghubungi arena.ai: ${error instanceof Error ? error.message : String(error)}`,
        },
        502,
      );
    }

    const text = await res.text();
    if (res.status !== 200) {
      const message = extractArenaError(res.status, text);
      return jsonResponse({ error: message }, res.status === 403 ? 403 : 502);
    }
    try {
      const parsed = JSON.parse(text) as { id?: string };
      if (parsed.id) {
        return jsonResponse({ ok: true, sessionId: parsed.id }, 200);
      }
    } catch {
      // bukan JSON — jatuh ke bawah
    }
    return jsonResponse(
      { error: `Respons create-chat tidak dikenali: ${text.slice(0, 300)}` },
      502,
    );
  }

  // ===== Mode coding (butuh repo GitHub, tanpa recaptcha) =====
  const repoOwner = body.repoOwner?.trim() || process.env.ARENA_REPO_OWNER || "";
  const repoName = body.repoName?.trim() || process.env.ARENA_REPO_NAME || "";
  const envRepoId = Number(process.env.ARENA_REPO_ID ?? "");
  const repoId =
    body.repoId ?? (Number.isFinite(envRepoId) && envRepoId > 0 ? envRepoId : 0);

  if (!repoOwner || !repoName || !repoId) {
    return jsonResponse(
      {
        error:
          "Repo target belum dikonfigurasi. Atur repo (owner/nama) lewat tombol repo di halaman chat.",
      },
      400,
    );
  }

  const payload = {
    repoId,
    repoOwner,
    repoName,
    baseBranch: "main",
    message,
  };

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/coding-agent/sessions`, {
      method: "POST",
      headers: arenaHeaders(cookie, true),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(READ_MS),
    });
  } catch (error) {
    return jsonResponse(
      {
        error: `Gagal menghubungi arena.ai: ${error instanceof Error ? error.message : String(error)}`,
      },
      502,
    );
  }

  // Teruskan stream apa adanya (text/event-stream dari arena.ai).
  return new Response(res.body, {
    status: res.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": res.headers.get("content-type") ?? "text/event-stream",
    },
  });
});

/**
 * Buat akun arena.ai otomatis via email sementara (mail.tm) lalu simpan
 * sesinya untuk clientId ini. Alur yang dipakai (sudah terbukti):
 *   anon sign-up -> magic-link -> callback -> set-password -> sesi v1.0/v1.1
 * Hasil akhir: /api/me 200 DAN auth create-chat lolos (tinggal token
 * reCAPTCHA dari browser saat chat). Khusus untuk tes — akun email temp.
 */
export const registerTempAccount = action({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const result = (await ctx.runAction(
      api.arenaDebug.debugAnonUpgradeViaMagicLink,
      { clientId },
    )) as Record<string, unknown>;
    const log = (result.log as Array<Record<string, unknown>> | undefined) ?? [];
    const step = (name: string) =>
      log.find((l) => l.step === name) ?? null;
    const signup = step("signup-anon");
    const setPassword = step("set-password");
    const me = step("me");
    const chat = step("chat-null-token");
    return {
      ok: Boolean(me && (me.status === 200 || me.status === 201)),
      address: typeof result.address === "string" ? result.address : null,
      password: typeof result.password === "string" ? result.password : null,
      hasV10: Boolean(result.hasV10),
      steps: {
        signup: signup?.status ?? null,
        setPassword: setPassword?.status ?? null,
        me: me?.status ?? null,
        chatAuth: chat?.status ?? null, // 403 = auth lolos, tinggal recaptcha
      },
    };
  },
});

// ====== DEBUG (sementara, untuk tes via `bunx convex run`) ======

type FirstSession = {
  clientId: string;
  cookie: string;
  name: string | null;
  email: string | null;
  updatedAt: number;
} | null;

export const debugMe = action({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const session: FirstSession = await ctx.runQuery(
      internal.arenaSession.firstSession,
      {},
    );
    if (!session) {
      return { error: "Tidak ada sesi tersimpan di Convex. Login dulu dari browser." };
    }
    const res = await fetch(`${BASE}/api/me`, {
      headers: arenaHeaders(session.cookie),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    return {
      sessionClientId: session.clientId,
      sessionUser: session.email ?? session.name ?? "?",
      status: res.status,
      user: extractUser(body),
      bodyPreview: body.slice(0, 400),
    };
  },
});

export const debugChat = action({
  args: {
    message: v.optional(v.string()),
    repoOwner: v.optional(v.string()),
    repoName: v.optional(v.string()),
    repoId: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { message, repoOwner, repoName, repoId },
  ): Promise<Record<string, unknown>> => {
    const session: FirstSession = await ctx.runQuery(
      internal.arenaSession.firstSession,
      {},
    );
    if (!session) {
      return { error: "Tidak ada sesi tersimpan di Convex. Login dulu dari browser." };
    }
    const payload = {
      repoId: repoId ?? Number(process.env.ARENA_REPO_ID ?? 0),
      repoOwner: repoOwner ?? process.env.ARENA_REPO_OWNER ?? "",
      repoName: repoName ?? process.env.ARENA_REPO_NAME ?? "",
      baseBranch: "main",
      message: message ?? "halo, ini tes debug dari web",
    };
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/coding-agent/sessions`, {
        method: "POST",
        headers: arenaHeaders(session.cookie, true),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25_000),
      });
    } catch (error) {
      return {
        error: `fetch gagal: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const contentType = res.headers.get("content-type") ?? "?";
    let body = "";
    const deadline = Date.now() + 18_000;
    try {
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        while (Date.now() < deadline) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
        await reader.cancel().catch(() => {});
      } else {
        body = await res.text();
      }
    } catch (error) {
      body += `\n[read error] ${error instanceof Error ? error.message : String(error)}`;
    }
    return {
      repoPayload: payload,
      status: res.status,
      contentType,
      bodyLength: body.length,
      bodyPreview: body.slice(0, 4000),
    };
  },
});

// ====== DEBUG: bypass reCAPTCHA via anchor protocol (origin lmarena.ai) ======

const RECAPTCHA_KEY = "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0";
const RECAPTCHA_ORIGIN = "https://lmarena.ai";
const RECAPTCHA_ORIGIN_B64 = "aHR0cHM6Ly9sbWFyZW5hLmFp";
const RECAPTCHA_VERSION = "XOqlk8PL_yVx6IdpLbpXdiLy";

const RECAPTCHA_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function mintRecaptchaToken(extra = ""): Promise<string | null> {
  const url =
    `https://www.google.com/recaptcha/enterprise/anchor?ar=1` +
    `&k=${RECAPTCHA_KEY}` +
    `&co=${RECAPTCHA_ORIGIN_B64}` +
    `&hl=en&v=${RECAPTCHA_VERSION}&size=invisible&cb=${Math.random().toString(36).slice(2)}${extra}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": RECAPTCHA_UA,
      Origin: RECAPTCHA_ORIGIN,
      Referer: RECAPTCHA_ORIGIN + "/",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const html = await res.text();
  const m = html.match(/id="recaptcha-token" value="([^"]+)"/);
  return m?.[1] ?? null;
}

async function createChatWithCookie(
  cookie: string,
  token: string,
  message: string,
  origin: string,
): Promise<{ status: number; body: string }> {
  const payload = {
    message: {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: message }],
    },
    timezone: "Asia/Jakarta",
    recaptchaV2Token: null,
    recaptchaV3Token: token,
  };
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Accept: "application/json, text/event-stream, */*",
    Cookie: cookie,
  };
  if (origin) {
    headers.Origin = origin;
    headers.Referer = origin + "/agent";
  }
  headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}/nextjs-api/stream/create-chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: (await res.text()).slice(0, 300) };
}

export const debugBypass = action({
  args: { message: v.optional(v.string()) },
  handler: async (ctx, { message }): Promise<Record<string, unknown>> => {
    const session: FirstSession = await ctx.runQuery(
      internal.arenaSession.firstSession,
      {},
    );
    if (!session) {
      return { error: "Tidak ada sesi tersimpan di Convex." };
    }

    const msg = message ?? "halo, ini tes bypass recaptcha — balas singkat";
    const token = await mintRecaptchaToken();
    if (!token) {
      return { error: "Gagal mengambil token dari anchor." };
    }
    const origins = [
      { name: "arena.ai", origin: "https://arena.ai" },
      { name: "lmarena.ai", origin: "https://lmarena.ai" },
      { name: "no-origin", origin: "" },
    ];
    const results = [];
    for (const o of origins) {
      let res: { status: number; body: string };
      try {
        res = await createChatWithCookie(session.cookie, token, msg, o.origin);
      } catch (error) {
        results.push({
          variant: o.name,
          error: `fetch gagal: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      results.push({
        variant: o.name,
        status: res.status,
        body: res.body,
      });
    }
    return { tokenLength: token.length, results };
  },
});

// Tes dengan token yang di-mint di browser sungguhan (dari console arena.ai).
export const debugToken = action({
  args: { token: v.string(), message: v.optional(v.string()) },
  handler: async (ctx, { token, message }): Promise<Record<string, unknown>> => {
    const session: FirstSession = await ctx.runQuery(
      internal.arenaSession.firstSession,
      {},
    );
    if (!session) {
      return { error: "Tidak ada sesi tersimpan di Convex." };
    }
    const res = await createChatWithCookie(
      session.cookie,
      token.trim(),
      message ?? "halo, ini tes token browser",
      "https://arena.ai",
    );
    return { status: res.status, body: res.body };
  },
});

// Tes auth arena: apakah sign-in/email butuh recaptcha?
export const debugAuth = action({
  args: {
    email: v.optional(v.string()),
    password: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { email, password },
  ): Promise<Record<string, unknown>> => {
    const payload: Record<string, unknown> = {
      email: email ?? "wondywansy@gmail.com",
      password: password ?? "wrong-password-test-123",
      shouldLinkHistory: false,
    };
    const results = [];

    // Varian 1: tanpa recaptcha
    {
      const res = await fetch(`${BASE}/nextjs-api/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Origin: BASE,
          Referer: BASE + "/agent",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
      results.push({
        variant: "no-recaptcha",
        status: res.status,
        setCookie: res.headers.get("set-cookie")?.slice(0, 120) ?? null,
        body: (await res.text()).slice(0, 300),
      });
    }

    // Varian 2: dengan token mint-server (lmarena)
    const token = await mintRecaptchaToken();
    if (token) {
      const res = await fetch(`${BASE}/nextjs-api/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Origin: BASE,
          Referer: BASE + "/agent",
        },
        body: JSON.stringify({ ...payload, recaptchaToken: token }),
        signal: AbortSignal.timeout(20_000),
      });
      results.push({
        variant: "with-recaptcha",
        status: res.status,
        setCookie: res.headers.get("set-cookie")?.slice(0, 120) ?? null,
        body: (await res.text()).slice(0, 300),
      });
    }

    return { results };
  },
});

// ====== DEBUG: signup arena via magic-link + email sementara (mail.tm) ======

const MAIL_TM = "https://api.mail.tm";

function randomAddress(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "arena";
  for (let i = 0; i < 10; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${s}@emalupe.com`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pecah Set-Cookie jadi array pasangan "name=value" yang bersih.
 * getSetCookie() adalah API yang benar — header Set-Cookie manual di-split
 * pakai koma akan salah pecah karena Expires memuat koma ("Thu, 15 Aug ...").
 */
function collectSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof headers.getSetCookie === "function") {
    return headers
      .getSetCookie()
      .map((c: string) => c.split(";")[0].trim())
      .filter(Boolean);
  }
  // Fallback manual: koma hanya pemisah jika bukan bagian dari Expires=.
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

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decode base64/base64url ke UTF-8 — murni manual (tanpa Buffer/atob yang
 * tidak konsisten di runtime Convex). Toleran tanpa padding & karakter aneh.
 */
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

/** Encode UTF-8 ke base64url (tanpa padding) — murni manual, tanpa btoa. */
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

export const debugTempSignup = action({
  args: {},
  handler: async (): Promise<Record<string, unknown>> => {
    // 1) Buat mailbox sementara
    const address = randomAddress();
    const password = "TempPass!" + Math.random().toString(36).slice(2, 10);
    let createRes: Response;
    try {
      createRes = await fetch(`${MAIL_TM}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, password }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return { error: `mail.tm create gagal: ${String(error)}` };
    }
    if (createRes.status !== 201) {
      return { error: `mail.tm create: HTTP ${createRes.status} ${(await createRes.text()).slice(0, 200)}` };
    }

    // 2) Kirim magic-link arena
    const signupPayload = {
      email: address,
      fullName: "Test Arena",
      shouldLinkHistory: false,
      marketingConsent: false,
      registeredCountryCode: "ID",
    };
    let magicRes: Response;
    try {
      magicRes = await fetch(`${BASE}/nextjs-api/sign-up/magic-link`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Origin: BASE,
          Referer: BASE + "/agent",
        },
        body: JSON.stringify(signupPayload),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return { address, error: `magic-link fetch gagal: ${String(error)}` };
    }
    const magicBody = (await magicRes.text()).slice(0, 300);
    return { address, password, magicStatus: magicRes.status, magicBody };
  },
});

/**
 * Tahap 2: ambil email verifikasi dari mailbox, klik link callback dari server,
 * tangkap cookie sesi, lalu tes create-chat dengan sesi baru (dibuat dari IP server).
 */
export const debugVerifyAndChat = action({
  args: { address: v.string(), password: v.string() },
  handler: async (ctx, { address, password }): Promise<Record<string, unknown>> => {
    // 1) Token mail.tm
    let token = "";
    try {
      const tRes = await fetch(`${MAIL_TM}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, password }),
        signal: AbortSignal.timeout(15_000),
      });
      const tBody = (await tRes.json()) as { token?: string };
      token = tBody.token ?? "";
    } catch {
      // ignore
    }

    // 2) Poll inbox sampai ada email dari arena
    let callbackUrl = "";
    const polls = [];
    for (let i = 0; i < 6; i++) {
      await sleep(5000);
      try {
        const mRes = await fetch(`${MAIL_TM}/messages`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
        const mBody = (await mRes.json()) as {
          "hydra:member"?: Array<{ id: string; subject?: string }>;
        };
        const members = mBody["hydra:member"] ?? [];
        polls.push({ poll: i, count: members.length });
        if (members.length > 0) {
          const first = members[0];
          const dRes = await fetch(`${MAIL_TM}/messages/${first.id}`, {
            headers: { Authorization: `Bearer ${token}` },
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

    if (!callbackUrl) {
      return { error: "Email verifikasi belum tiba / link tidak ditemukan.", polls };
    }

    // 3) Klik callback dari server, tangkap cookie sesi (ikuti redirect manual)
    const cookies: string[] = [];
    let current = callbackUrl;
    const hops = [];
    let setPasswordFullLocation = "";
    for (let i = 0; i < 6; i++) {
      const res = await fetch(current, {
        redirect: "manual",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(15_000),
      });
      const location = res.headers.get("location");
      const cookiePairs = collectSetCookies(res);
      for (const pair of cookiePairs) {
        if (pair && !cookies.includes(pair)) cookies.push(pair);
      }
      hops.push({
        hop: i,
        status: res.status,
        location: location?.slice(0, 120) ?? null,
        setCookieCount: cookiePairs.length,
        bodyPreview: (await res.text()).slice(0, 120),
      });
      if (location) {
        if (location.includes("/auth/set-password")) {
          setPasswordFullLocation = new URL(location, current).toString();
        }
        current = new URL(location, current).toString();
      } else {
        break;
      }
    }

    const cookieString = cookies.join("; ");
    const provisionalMatch = cookieString.match(/provisional_user_id=([^;]+)/);
    const provisionalUserId = provisionalMatch?.[1] ?? "";
    const setPasswordToken =
      setPasswordFullLocation.match(/token=([^&]+)/)?.[1] ?? "";

    const accountResults: Record<string, unknown>[] = [];
    let sessionCookie = cookieString;
    const setPassword = Math.random().toString(36).slice(2, 10) + "ArenaTemp!";

    // Urutan yang benar (meniru browser):
    //   1) set-password DULU (buat user email + cookie v1.0/v1.1)
    //   2) sign-up dengan provisionalUserId ASLI dari callback (buat row arena
    //      untuk user email tsb — persis yang dilakukan halaman agent saat
    //      userState === "provisional").

    // 4a) Tautkan email: POST /nextjs-api/auth/set-password (token JWT dari
    //     callback) dengan cookie provisional.
    if (setPasswordToken) {
      const spRes = await fetch(`${BASE}/nextjs-api/auth/set-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Origin: BASE,
          Referer: BASE + "/agent",
          Cookie: sessionCookie,
        },
        body: JSON.stringify({ password: setPassword, token: setPasswordToken }),
        signal: AbortSignal.timeout(20_000),
      });
      const spBody = await spRes.text();
      const spPairs = collectSetCookies(spRes).filter(
        (c: string) => c && !cookies.includes(c),
      );
      for (const p of spPairs) cookies.push(p);
      sessionCookie = cookies.join("; ");
      accountResults.push({
        step: "set-password",
        status: spRes.status,
        setCookieCount: spPairs.length,
        body: spBody.slice(0, 300),
      });
    }

    // 4b) Buat row arena untuk user email: POST /nextjs-api/sign-up dengan
    //     provisionalUserId ASLI dari callback (cookie provisional_user_id),
    //     memakai sesi terbaru (v1.0/v1.1).
    if (provisionalUserId) {
      const recaptchaToken = await mintRecaptchaToken();
      if (recaptchaToken) {
        const res = await fetch(`${BASE}/nextjs-api/sign-up`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": UA,
            Origin: BASE,
            Referer: BASE + "/agent",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({ recaptchaToken, provisionalUserId }),
          signal: AbortSignal.timeout(20_000),
        });
        const newPairs = collectSetCookies(res).filter(
          (c: string) => c && !cookies.includes(c),
        );
        for (const p of newPairs) cookies.push(p);
        sessionCookie = cookies.join("; ");
        accountResults.push({
          step: "sign-up-after-set-password",
          status: res.status,
          setCookieCount: newPairs.length,
          body: (await res.text()).slice(0, 300),
        });
      }
    }

    // 5) Simpan sesi baru
    await ctx.runMutation(internal.arenaSession.upsert, {
      clientId: "temp-mail-session",
      cookie: sessionCookie,
      name: "Temp Mail",
      email: address,
    });

    // 6) Tes /api/me + create-chat dengan sesi baru
    const meRes = await fetch(`${BASE}/api/me`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/event-stream, */*",
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: sessionCookie,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const meBody = await meRes.text();

    const recaptchaToken2 = await mintRecaptchaToken();
    let chatResult: Record<string, unknown> = {};
    if (recaptchaToken2) {
      const res = await createChatWithCookie(
        sessionCookie,
        recaptchaToken2,
        "halo, tes sesi dari email sementara",
        "https://arena.ai",
      );
      chatResult = { status: res.status, body: res.body };
    }

    return {
      address,
      callbackUrl: callbackUrl.slice(0, 80),
      provisionalUserId,
      hasSetPasswordToken: Boolean(setPasswordToken),
      accountResults,
      meStatus: meRes.status,
      meBody: meBody.slice(0, 200),
      cookieNames: cookies.map((c) => c.split("=")[0]),
      chatResult,
    };
  },
});

// Tes sesi temp (arena-auth-prod-v1 vs v1.0/v1.1) terhadap /api/me + create-chat
export const debugTempSessionTest = action({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const session: FirstSession = await ctx.runQuery(
      internal.arenaSession.firstSession,
      {},
    );
    if (!session || !session.cookie.includes("arena-auth-prod")) {
      return { error: "Sesi temp belum tersimpan (jalankan debugVerifyAndChat dulu)." };
    }

    const v10 = session.cookie.match(/arena-auth-prod-v1\.0=([^;]+)/)?.[1] ?? "";
    const v11 = session.cookie.match(/arena-auth-prod-v1\.1=([^;]+)/)?.[1] ?? "";

    // Decode payload v1.0 + v1.1 (arena membagi SATU nilai besar jadi dua
    // cookie: v1.0 = bagian pertama, v1.1 = lanjutannya).
    let innerAccess = "";
    let innerRefresh = "";
    let v10Json = null;
    try {
      if (v10.startsWith("base64-")) {
        const combined = v10.slice(7) + v11;
        v10Json = JSON.parse(b64UrlDecode(combined)) as Record<string, unknown>;
        innerAccess = (v10Json.access_token as string) ?? "";
        innerRefresh = (v10Json.refresh_token as string) ?? "";
      }
    } catch (error) {
      v10Json = { decodeError: String(error) };
    }

    // Decode user id dari JWT access token (bagian payload)
    let accessPayload: Record<string, unknown> | null = null;
    try {
      const parts = innerAccess.split(".");
      if (parts.length === 3) {
        accessPayload = JSON.parse(
          b64UrlDecode(parts[1]),
        ) as Record<string, unknown>;
      }
    } catch {
      // ignore
    }

    // Decode user id dari cookie v1 (sesi anonim)
    const v1old = session.cookie.match(/arena-auth-prod-v1=([^;]+)/)?.[1] ?? "";
    let v1Json: Record<string, unknown> | null = null;
    try {
      if (v1old.startsWith("base64-")) {
        v1Json = JSON.parse(b64UrlDecode(v1old.slice(7))) as Record<string, unknown>;
      }
    } catch {
      // ignore
    }

    const variants: Array<{ name: string; cookie: string }> = [
      { name: "as-stored", cookie: session.cookie },
      {
        name: "only-v1.0+v1.1",
        cookie: `arena-auth-prod-v1.0=${v10}; arena-auth-prod-v1.1=${v11}`,
      },
      {
        name: "v1.0-only",
        cookie: `arena-auth-prod-v1.0=${v10}`,
      },
      {
        name: "v1.0=raw-access-jwt",
        cookie: `arena-auth-prod-v1.0=${innerAccess}; arena-auth-prod-v1.1=${innerRefresh}`,
      },
      {
        name: "v1.1-only",
        cookie: `arena-auth-prod-v1.1=${v11}`,
      },
      {
        name: "v1-only",
        cookie: `arena-auth-prod-v1=${v1old}`,
      },
      {
        name: "no-auth-cookie",
        cookie: `provisional_user_id=${session.cookie.match(/provisional_user_id=([^;]+)/)?.[1] ?? ""}`,
      },
    ];

    const results = [];
    for (const variant of variants) {
      const meRes = await fetch(`${BASE}/api/me`, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json, text/event-stream, */*",
          Origin: BASE,
          Referer: BASE + "/agent",
          Cookie: variant.cookie,
        },
        signal: AbortSignal.timeout(15_000),
      });
      results.push({
        variant: variant.name,
        meStatus: meRes.status,
        meBody: (await meRes.text()).slice(0, 150),
      });
    }
    return {
      results,
      v10Length: v10.length,
      v11Length: v11.length,
      v10RawPrefix: v10.slice(0, 120),
      v11RawPrefix: v11.slice(0, 120),
      v10Json,
      accessPayload,
      v1Json,
      hasV1: Boolean(v1old),
    };
  },
});

// Tes: apakah /nextjs-api/sign-up bisa langsung menerima email+password
// (membuat user arena lengkap dari server, tanpa magic-link).
export const debugSignupDirect = action({
  args: {},
  handler: async (): Promise<Record<string, unknown>> => {
    const address = randomAddress();
    const password = "TempPass!" + Math.random().toString(36).slice(2, 10);
    const token = await mintRecaptchaToken();
    if (!token) return { error: "token recaptcha gagal" };

    const payloads: Array<Record<string, unknown>> = [
      {
        email: address,
        password,
        fullName: "Test Arena",
        shouldLinkHistory: false,
        marketingConsent: false,
        registeredCountryCode: "ID",
      },
      {
        email: address,
        password,
        shouldLinkHistory: false,
        registeredCountryCode: "ID",
      },
      {
        email: address,
        password,
        fullName: "Test Arena",
        shouldLinkHistory: false,
      },
    ];

    const results = [];
    for (let i = 0; i < payloads.length; i++) {
      const res = await fetch(`${BASE}/nextjs-api/sign-up`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Origin: BASE,
          Referer: BASE + "/agent",
        },
        body: JSON.stringify({ ...payloads[i], recaptchaToken: token }),
        signal: AbortSignal.timeout(20_000),
      });
      results.push({
        variant: i,
        status: res.status,
        setCookieNames: collectSetCookies(res).map(
          (c: string) => c.split(";")[0].split("=")[0],
        ),
        body: (await res.text()).slice(0, 300),
      });
      if (res.status === 200 || res.status === 201) break;
    }
    return { address, password, results };
  },
});

// Probe skema Zod endpoint sign-up dengan body kosong / variasi field.
export const debugSignupSchema = action({
  args: {},
  handler: async (): Promise<Record<string, unknown>> => {
    const results = [];
    const variants: Array<{ name: string; body: Record<string, unknown> }> = [
      { name: "empty", body: {} },
      { name: "only-recaptcha", body: { recaptchaToken: "x" } },
      {
        name: "only-provisional",
        body: { provisionalUserId: crypto.randomUUID() },
      },
      {
        name: "both+",
        body: {
          recaptchaToken: "x",
          provisionalUserId: crypto.randomUUID(),
          email: "tes@example.com",
          password: "pw",
          fullName: "T",
        },
      },
      {
        name: "both+signup_intent",
        body: {
          recaptchaToken: "x",
          provisionalUserId: crypto.randomUUID(),
          signup_intent_id: "abc",
        },
      },
    ];
    for (const v of variants) {
      const res = await fetch(`${BASE}/nextjs-api/sign-up`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Origin: BASE,
          Referer: BASE + "/agent",
        },
        body: JSON.stringify(v.body),
        signal: AbortSignal.timeout(20_000),
      });
      results.push({
        variant: v.name,
        status: res.status,
        body: (await res.text()).slice(0, 400),
      });
    }
    return { results };
  },
});

/**
 * Gabungkan cookie lama + pasangan baru (name=value terakhir menang).
 */
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
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Coba beberapa varian POST /nextjs-api/sign-up untuk mengaktifkan user arena
 * (row user yang dicari /api/me). Begitu /api/me 200, langsung tes create-chat
 * dengan sesi baru.
 */
export const debugFinishSignup = action({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const session: FirstSession = await ctx.runQuery(
      internal.arenaSession.firstSession,
      {},
    );
    if (!session) {
      return { error: "Tidak ada sesi tersimpan. Jalankan debugVerifyAndChat dulu." };
    }

    const cookie = session.cookie;
    const provisionalUserId =
      cookie.match(/provisional_user_id=([^;]+)/)?.[1] ?? "";
    const v10 = cookie.match(/arena-auth-prod-v1\.0=([^;]+)/)?.[1] ?? "";
    const v11 = cookie.match(/arena-auth-prod-v1\.1=([^;]+)/)?.[1] ?? "";

    let email = "";
    let signupIntentId = "";
    try {
      const json = JSON.parse(b64UrlDecode(v10.slice(7) + v11)) as {
        user?: {
          email?: string;
          user_metadata?: { signup_intent_id?: string };
        };
      };
      email = json.user?.email ?? "";
      signupIntentId = json.user?.user_metadata?.signup_intent_id ?? "";
    } catch (error) {
      return { error: `decode sesi gagal: ${String(error)}` };
    }

    const token = await mintRecaptchaToken();
    if (!token) return { error: "token recaptcha gagal" };

    const variants: Array<{ name: string; body: Record<string, unknown> }> = [
      {
        name: "intent-only",
        body: { recaptchaToken: token, signup_intent_id: signupIntentId },
      },
      {
        name: "intent+provisional",
        body: {
          recaptchaToken: token,
          signup_intent_id: signupIntentId,
          provisionalUserId,
        },
      },
      {
        name: "email+intent",
        body: { recaptchaToken: token, email, signup_intent_id: signupIntentId },
      },
      {
        name: "email+provisional",
        body: { recaptchaToken: token, email, provisionalUserId },
      },
    ];

    const results: Array<Record<string, unknown>> = [];
    let finalCookie = cookie;
    let success = false;
    for (const v of variants) {
      if (success) break;
      let res: Response;
      try {
        res = await fetch(`${BASE}/nextjs-api/sign-up`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": UA,
            Origin: BASE,
            Referer: BASE + "/agent",
            Cookie: finalCookie,
          },
          body: JSON.stringify(v.body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        results.push({ variant: v.name, error: String(error) });
        continue;
      }
      const bodyText = (await res.text()).slice(0, 300);
      const newPairs = collectSetCookies(res);
      results.push({
        variant: v.name,
        status: res.status,
        setCookieCount: newPairs.length,
        body: bodyText,
      });
      if (!res.ok) continue;

      finalCookie = mergeCookies(finalCookie, newPairs);
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
      const meBody = (await meRes.text()).slice(0, 300);
      results.push({
        variant: v.name + "->me",
        status: meRes.status,
        body: meBody,
      });
      if (meRes.status !== 200) continue;

      // /api/me OK → tes create-chat dengan token recaptcha BARU
      success = true;
      const token2 = await mintRecaptchaToken();
      let chatResult: Record<string, unknown> = { skipped: "token2 gagal" };
      if (token2) {
        const chat = await createChatWithCookie(
          finalCookie,
          token2,
          "halo, tes sesi lengkap dari email sementara — balas singkat",
          "https://arena.ai",
        );
        chatResult = { status: chat.status, body: chat.body };
      }

      await ctx.runMutation(internal.arenaSession.upsert, {
        clientId: "temp-mail-session",
        cookie: finalCookie,
        name: "Temp Mail",
        email,
      });
      return { email, signupIntentId, provisionalUserId, results, chatResult };
    }

    return { email, signupIntentId, provisionalUserId, results };
  },
});

/**
 * Alur TERBALIK: sign-up (provisionalUserId) DULU, baru set-password.
 * Hipotesis: set-password membuat Supabase user; /api/me butuh row arena user
 * yang dibuat oleh /nextjs-api/sign-up — dan sign-up harus dipanggil SEBELUM
 * user email ada, kalau tidak dapat "User already exists".
 */
export const debugSignupReverse = action({
  args: {
    doSetPassword: v.optional(v.boolean()),
    message: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { doSetPassword, message },
  ): Promise<Record<string, unknown>> => {
    // 1) Mailbox sementara baru
    const address = randomAddress();
    const password = "TempPass!" + Math.random().toString(36).slice(2, 10);
    try {
      const createRes = await fetch(`${MAIL_TM}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, password }),
        signal: AbortSignal.timeout(15_000),
      });
      if (createRes.status !== 201) {
        return {
          error: `mail.tm create: HTTP ${createRes.status} ${(await createRes.text()).slice(0, 200)}`,
        };
      }
    } catch (error) {
      return { error: `mail.tm create gagal: ${String(error)}` };
    }

    // 2) Magic link
    const magicRes = await fetch(`${BASE}/nextjs-api/sign-up/magic-link`, {
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
        registeredCountryCode: "ID",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const magicStatus = magicRes.status;
    const magicBody = (await magicRes.text()).slice(0, 200);
    if (magicStatus !== 200) {
      return { address, magicStatus, magicBody };
    }

    // 3) Token mail.tm + poll inbox sampai email tiba
    let token = "";
    try {
      const tRes = await fetch(`${MAIL_TM}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, password }),
        signal: AbortSignal.timeout(15_000),
      });
      token = ((await tRes.json()) as { token?: string }).token ?? "";
    } catch {
      // token kosong — poll tetap jalan tanpa auth
    }

    let callbackUrl = "";
    for (let i = 0; i < 5 && !callbackUrl; i++) {
      await sleep(5000);
      try {
        const mRes = await fetch(`${MAIL_TM}/messages`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
        const members =
          ((await mRes.json()) as { "hydra:member"?: Array<{ id: string }> })[
            "hydra:member"
          ] ?? [];
        if (members.length > 0) {
          const dRes = await fetch(`${MAIL_TM}/messages/${members[0].id}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          });
          const detail = (await dRes.json()) as { text?: string };
          const match = (detail.text ?? "").match(
            /https:\/\/arena\.ai\/nextjs-api\/callback\/[^\s]+/,
          );
          if (match) callbackUrl = match[0];
        }
      } catch {
        // retry
      }
    }
    if (!callbackUrl) {
      return { address, error: "Callback tidak ditemukan di email." };
    }

    // 4) Follow redirect (tanpa set-password), kumpulkan cookie provisional
    const cookies: string[] = [];
    let current = callbackUrl;
    let setPasswordFullLocation = "";
    for (let i = 0; i < 6; i++) {
      const res = await fetch(current, {
        redirect: "manual",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(15_000),
      });
      const location = res.headers.get("location");
      const pairs = collectSetCookies(res);
      for (const p of pairs) if (p && !cookies.includes(p)) cookies.push(p);
      if (location) {
        if (location.includes("/auth/set-password")) {
          setPasswordFullLocation = new URL(location, current).toString();
        }
        current = new URL(location, current).toString();
      } else {
        break;
      }
    }
    const cookieBase = cookies.join("; ");
    const provisionalUserId =
      cookieBase.match(/provisional_user_id=([^;]+)/)?.[1] ?? "";
    const setPasswordToken =
      setPasswordFullLocation.match(/token=([^&]+)/)?.[1] ?? "";

    // 5) sign-up DULU (belum ada user email → seharusnya sukses)
    const recaptchaToken = await mintRecaptchaToken();
    if (!recaptchaToken) {
      return { address, error: "recaptcha token gagal" };
    }
    // Varian 1: sign-up dengan email (row arena langsung terisi email)
    let suRes = await fetch(`${BASE}/nextjs-api/sign-up`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: BASE,
        Referer: BASE + "/agent",
        Cookie: cookieBase,
      },
      body: JSON.stringify({
        recaptchaToken,
        provisionalUserId,
        email: address,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    let suBodyFull = await suRes.text();
    let suStatus = suRes.status;
    let suBodyText = suBodyFull.slice(0, 300);
    if (suStatus === 400 && suBodyText.includes("Invalid request body")) {
      // Varian 2: tanpa email (skema lama)
      suRes = await fetch(`${BASE}/nextjs-api/sign-up`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Origin: BASE,
          Referer: BASE + "/agent",
          Cookie: cookieBase,
        },
        body: JSON.stringify({ recaptchaToken, provisionalUserId }),
        signal: AbortSignal.timeout(20_000),
      });
      suBodyFull = await suRes.text();
      suBodyText = suBodyFull.slice(0, 300);
      suStatus = suRes.status;
    }
    const suBody = suBodyText;
    const suPairs = collectSetCookies(suRes);
    let cookieAfter = mergeCookies(cookieBase, suPairs);

    // 5b) Poll inbox untuk email VERIFIKASI Supabase (type=signup). Link ini
    //     yang bikin user aktif penuh — tanpa klik, userState belum "active".
    let verificationUrl = "";
    let verificationStatus = "tidak-ditemukan";
    for (let i = 0; i < 4 && !verificationUrl; i++) {
      await sleep(6000);
      try {
        const mRes = await fetch(`${MAIL_TM}/messages`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
        const members =
          ((await mRes.json()) as {
            "hydra:member"?: Array<{ id: string; subject?: string }>;
          })["hydra:member"] ?? [];
        for (const m of members) {
          const dRes = await fetch(`${MAIL_TM}/messages/${m.id}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          });
          const detail = (await dRes.json()) as { text?: string };
          const match = (detail.text ?? "").match(
            /https:\/\/[a-z0-9-]+\.supabase\.co\/auth\/v1\/verify[^\s"<]+/i,
          );
          if (match) {
            verificationUrl = match[0];
            break;
          }
        }
      } catch {
        // retry
      }
    }
    if (verificationUrl) {
      let vCurrent = verificationUrl;
      for (let i = 0; i < 5; i++) {
        const vRes = await fetch(vCurrent, {
          redirect: "manual",
          headers: {
            "User-Agent": UA,
            Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
            Cookie: cookieAfter,
          },
          signal: AbortSignal.timeout(15_000),
        });
        const vLoc = vRes.headers.get("location");
        const vPairs = collectSetCookies(vRes);
        if (vPairs.length > 0) {
          cookieAfter = mergeCookies(cookieAfter, vPairs);
          verificationStatus = `ok(status=${vRes.status}, cookies=${vPairs.length})`;
        }
        if (vLoc) {
          vCurrent = new URL(vLoc, vCurrent).toString();
        } else {
          break;
        }
      }
    }

    const meCall = async (cookie: string) => {
      const r = await fetch(`${BASE}/api/me`, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json, text/event-stream, */*",
          Origin: BASE,
          Referer: BASE + "/agent",
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(15_000),
      });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    };

    // 6a) Tes /api/me dengan sesi hasil sign-up SAJA
    const meAfterSignup = await meCall(cookieAfter);
    const cookieAfterSignup = cookieAfter;

    // 6a2) Konstruksi cookie v1.0/v1.1 dari session JSON respons sign-up.
    //      Server membagi nilai jadi dua cookie (v1.0 = 3180 char termasuk
    //      prefix "base64-", v1.1 = sisanya) — inilah yang create-chat butuh.
    let cookieV10v11 = cookieAfterSignup;
    let constructed: Record<string, unknown> = { skipped: "signup != 200" };
    if (suStatus === 200) {
      try {
        const session = JSON.parse(suBodyFull) as Record<string, unknown>;
        const encoded = "base64-" + b64UrlEncode(JSON.stringify(session));
        const cut = 3180;
        const part1 = encoded.slice(0, cut);
        const part2 = encoded.slice(cut);
        cookieV10v11 = mergeCookies(cookieAfterSignup, [
          `arena-auth-prod-v1.0=${part1}`,
          `arena-auth-prod-v1.1=${part2}`,
        ]);
        constructed = {
          sessionKeys: Object.keys(session),
          encodedLen: encoded.length,
          part1Len: part1.length,
          part2Len: part2.length,
        };
      } catch (error) {
        constructed = { error: String(error) };
      }
    }

    // 6b) set-password HANYA jika diminta — terbukti membuat user Supabase
    //     baru yang mengubah sesi v1.0/v1.1 menjadi invalid di /api/me.
    const generatedPassword =
      Math.random().toString(36).slice(2, 10) + "ArenaTemp!";
    let spStatus = 0;
    let spBody = "";
    let spPairs: string[] = [];
    if (doSetPassword && setPasswordToken) {
      const spRes = await fetch(`${BASE}/nextjs-api/auth/set-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          Origin: BASE,
          Referer: BASE + "/agent",
          Cookie: cookieAfter,
        },
        body: JSON.stringify({
          password: generatedPassword,
          token: setPasswordToken,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      spStatus = spRes.status;
      spBody = (await spRes.text()).slice(0, 300);
      spPairs = collectSetCookies(spRes);
      cookieAfter = mergeCookies(cookieAfter, spPairs);
    }

    // 7) /api/me final (dengan cookie v1.0/v1.1)
    const meFinal = await meCall(cookieAfter);

    // 8) Tes /api/me + create-chat dengan:
    //    - cookieV1  : sesi hasil sign-up (v1 saja)
    //    - cookieV10 : v1.0/v1.1 hasil konstruksi dari session JSON
    const meV1 = await meCall(cookieAfterSignup);
    const meV10 = await meCall(cookieV10v11);

    const token2 = await mintRecaptchaToken();
    let chatV1: Record<string, unknown> = { skipped: "token2 gagal" };
    let chatV10: Record<string, unknown> = { skipped: "token2 gagal" };
    if (token2) {
      chatV1 = await createChatWithCookie(
        cookieAfterSignup,
        token2,
        message ?? "halo, tes chat sesi baru — balas singkat",
        "https://arena.ai",
      );
      const token3 = await mintRecaptchaToken();
      if (token3) {
        chatV10 = await createChatWithCookie(
          cookieV10v11,
          token3,
          message ?? "halo, tes chat sesi baru — balas singkat",
          "https://arena.ai",
        );
      }
    }

    // Simpan sesi konstruksi (kalau /api/me-nya 200) untuk tes lanjutan
    await ctx.runMutation(internal.arenaSession.upsert, {
      clientId: "temp-mail-session",
      cookie: meV10.status === 200 ? cookieV10v11 : cookieAfterSignup,
      name: "Temp Mail",
      email: address,
    });

    return {
      address,
      provisionalUserId,
      hasSetPasswordToken: Boolean(setPasswordToken),
      signup: { status: suStatus, body: suBody, setCookieCount: suPairs.length },
      verificationUrl: verificationUrl.slice(0, 120) || null,
      verificationStatus,
      meAfterSignup,
      setPassword: { status: spStatus, body: spBody, setCookieCount: spPairs.length },
      meFinal,
      meV1,
      meV10,
      constructed,
      chatV1,
      chatV10,
      cookieNamesAfter: cookieAfter
        .split(";")
        .map((c) => c.split("=")[0].trim()),
    };
  },
});

/**
 * Bandingkan semua sesi tersimpan: decode isi cookie v1.0+v1.1 (Supabase
 * session) + tes /api/me — untuk melihat beda sesi browser valid vs temp.
 */
export const debugCompareSessions = action({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const sessions = await ctx.runQuery(internal.arenaSession.allSessions, {});
    const results = [];
    for (const s of sessions) {
      const v10 = s.cookie.match(/arena-auth-prod-v1\.0=([^;]+)/)?.[1] ?? "";
      const v11 = s.cookie.match(/arena-auth-prod-v1\.1=([^;]+)/)?.[1] ?? "";
      let decoded: Record<string, unknown> | null = null;
      try {
        if (v10.startsWith("base64-")) {
          decoded = JSON.parse(
            b64UrlDecode(v10.slice(7) + v11),
          ) as Record<string, unknown>;
        } else {
          decoded = { notBase64Prefix: v10.slice(0, 60) };
        }
      } catch (error) {
        decoded = { decodeError: String(error) };
      }
      const user = (decoded?.user ?? null) as
        | {
            email?: string;
            id?: string;
            confirmed_at?: string;
            is_anonymous?: boolean;
          }
        | null;
      const meRes = await fetch(`${BASE}/api/me`, {
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
        email: s.email,
        meStatus: meRes.status,
        meBody: (await meRes.text()).slice(0, 150),
        decodedUser: user
          ? {
              id: user.id ?? null,
              email: user.email ?? null,
              confirmed_at: user.confirmed_at ?? null,
              is_anonymous: user.is_anonymous ?? null,
            }
          : decoded,
        v10Len: v10.length,
        v11Len: v11.length,
      });
    }
    return { results };
  },
});

export const debugCreateChat = action({
  args: { message: v.optional(v.string()) },
  handler: async (
    ctx,
    { message },
  ): Promise<Record<string, unknown>> => {
    const session: FirstSession = await ctx.runQuery(
      internal.arenaSession.firstSession,
      {},
    );
    if (!session) {
      return { error: "Tidak ada sesi tersimpan di Convex. Login dulu dari browser." };
    }
    const payload = {
      message: {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: message ?? "halo, ini tes chat biasa dari web" }],
      },
      timezone: "Asia/Jakarta",
      recaptchaV3Token: null,
      recaptchaV2Token: null,
    };
    let res: Response;
    try {
      res = await fetch(`${BASE}/nextjs-api/stream/create-chat`, {
        method: "POST",
        headers: arenaHeaders(session.cookie, true),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return {
        error: `fetch gagal: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const contentType = res.headers.get("content-type") ?? "?";
    let body = "";
    const deadline = Date.now() + 20_000;
    try {
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        while (Date.now() < deadline) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
        await reader.cancel().catch(() => {});
      } else {
        body = await res.text();
      }
    } catch (error) {
      body += `\n[read error] ${error instanceof Error ? error.message : String(error)}`;
    }
    return {
      payload,
      status: res.status,
      contentType,
      bodyLength: body.length,
      bodyPreview: body.slice(0, 4000),
    };
  },
});
