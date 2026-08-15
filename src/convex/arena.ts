import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
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

/** Validasi cookie terhadap /api/me lalu simpan sesi. */
export const login = action({
  args: { clientId: v.string(), cookie: v.string() },
  handler: async (ctx, { clientId, cookie }) => {
    const trimmed = cookie.trim();
    if (!trimmed) {
      throw new ConvexError("Cookie kosong. Tempel cookie arena.ai dulu.");
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
    "User-Agent": UA,
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
