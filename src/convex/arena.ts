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

/**
 * Endpoint streaming: klien POST { clientId, message }, lalu respons dari
 * /api/coding-agent/sessions arena.ai diteruskan apa adanya (text/event-stream).
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

  // Repo target: dari body (dikonfigurasi di UI) atau fallback env (Keys).
  // Arena butuh repoId berupa ANGKA + owner/nama yang valid — kalau kosong,
  // API menolak dengan ZodError 400.
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
