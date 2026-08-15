import { api } from "@/convex/_generated/api";
import { useArenaSession } from "@/hooks/use-arena-session";
import { useAuth } from "@/hooks/use-auth";
import {
  ARENA_RECAPTCHA_BOOKMARKLET,
  getArenaRecaptchaToken,
  isRecaptchaError,
} from "@/lib/recaptcha";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useMutation } from "convex/react";
import {
  ArrowRight,
  Bot,
  ExternalLink,
  LogOut,
  Plug,
  Send,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

const CONVEX_SITE_URL = (import.meta.env.VITE_CONVEX_URL as string).replace(
  /\.cloud$/,
  ".site",
);

const ARENA_AGENT_URL = "https://arena.ai/agent";

type MessageStatus = "streaming" | "error" | "done";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: MessageStatus;
  sessionId?: string;
}

function userInitials(name: string | null, email: string | null) {
  if (name) {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("");
  }
  return (email?.[0] ?? "A").toUpperCase();
}

export default function Dashboard() {
  const { clientId, session, isLoading } = useArenaSession();
  const { user, isAuthenticated, signOut } = useAuth();
  const logout = useMutation(api.arenaSession.logout);
  const navigate = useNavigate();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  // Token reCAPTCHA manual (dari bookmarklet di arena.ai) — fallback saat
  // token yang di-mint otomatis di browser kita ditolak arena.
  const [manualToken, setManualToken] = useState("");
  const [showTokenPanel, setShowTokenPanel] = useState(false);
  const [copiedBookmarklet, setCopiedBookmarklet] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSignOut = async () => {
    try {
      await logout({ clientId });
    } catch {
      // abaikan — sesi arena mungkin belum tersambung
    }
    if (isAuthenticated) {
      await signOut();
    }
    navigate("/");
  };

  if (!isLoading && !session) {
    const appName = user?.name || user?.email || "Pengguna";
    return (
      <div className="dark flex h-dvh flex-col bg-background text-foreground antialiased">
        <header className="border-b border-white/10 bg-card/40 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
            <Link to="/" className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                <TerminalSquare className="size-4" />
              </div>
              <div className="leading-tight">
                <p className="font-mono text-sm font-semibold tracking-tight">
                  arena://agent
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Agent Mode — web client
                </p>
              </div>
            </Link>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={handleSignOut}
              title="Keluar"
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Keluar</span>
            </Button>
          </div>
        </header>
        <main className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-card/50 p-8 text-center shadow-2xl shadow-black/40">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
              <Plug className="size-6" />
            </div>
            <h2 className="text-lg font-bold tracking-tight">
              Akun siap — tinggal hubungkan cookie arena.ai
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Login web berhasil ({appName}). Untuk mengirim pesan ke Agent
              Mode, hubungkan dulu sesi arena.ai-mu lewat halaman masuk.
            </p>
            <Button
              asChild
              className="mt-6 w-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
            >
              <Link to="/auth?tab=arena">
                Hubungkan cookie arena
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <p className="mt-3 text-[11px] text-muted-foreground/70">
              Tempel seluruh <code className="font-mono">document.cookie</code>{" "}
              dari arena.ai — sesi divalidasi dulu sebelum disimpan.
            </p>
          </div>
        </main>
      </div>
    );
  }

  const handleSend = async (raw?: string) => {
    const message = (raw ?? input).trim();
    if (!message || isStreaming) return;

    setInput("");
    setBannerError(null);
    setIsStreaming(true);

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message,
      status: "done",
    };
    const assistantId = `assistant-${Date.now()}`;
    const assistantMessage: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      status: "streaming",
    };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);

    const finishError = (detail: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: detail, status: "error" } : m,
        ),
      );
    };

    try {
      const trimmedManual = manualToken.trim();
      let token: string;
      if (trimmedManual) {
        // Token manual dari bookmarklet arena.ai — sudah terbukti diterima.
        token = trimmedManual;
        setManualToken("");
      } else {
        try {
          token = await getArenaRecaptchaToken();
        } catch (err) {
          throw new Error(
            err instanceof Error
              ? err.message
              : "Gagal mendapatkan token reCAPTCHA.",
          );
        }
      }

      const res = await fetch(`${CONVEX_SITE_URL}/arena/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          message,
          mode: "chat",
          recaptchaV3Token: token,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });

      const text = await res.text();
      let parsed: { ok?: boolean; sessionId?: string; error?: string };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        parsed = {};
      }

      if (!res.ok || !parsed.ok) {
        const detail = parsed.error || `HTTP ${res.status}: ${text.slice(0, 200)}`;
        if (isRecaptchaError(detail)) {
          setShowTokenPanel(true);
          setBannerError(
            "Token reCAPTCHA ditolak arena. Ambil token FRESH dari arena.ai lewat bookmarklet di bawah, lalu kirim ulang. (Token cuma berlaku ±2 menit dan sekali pakai.)",
          );
        }
        throw new Error(detail);
      }

      // Chat berhasil dibuat — jawaban agent mengalir di halaman arena.ai.
      const sessionId = parsed.sessionId;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: "Chat berhasil dibuat di arena.ai.",
                status: "done",
                sessionId,
              }
            : m,
        ),
      );
    } catch (err) {
      finishError(
        err instanceof Error ? err.message : "Terjadi kesalahan tak terduga.",
      );
    } finally {
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  };

  const copyRecaptchaBookmarklet = async () => {
    try {
      await navigator.clipboard.writeText(ARENA_RECAPTCHA_BOOKMARKLET);
      setCopiedBookmarklet(true);
      setTimeout(() => setCopiedBookmarklet(false), 2000);
    } catch {
      // abaikan — user bisa salin manual dari <code>
    }
  };

  const displayName = session?.name || session?.email || "Arena user";

  return (
    <div className="dark flex h-dvh flex-col bg-background text-foreground antialiased">
      {/* Header */}
      <header className="border-b border-white/10 bg-card/40 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
              <TerminalSquare className="size-4" />
            </div>
            <div className="leading-tight">
              <p className="font-mono text-sm font-semibold tracking-tight">
                arena://agent
              </p>
              <p className="text-[11px] text-muted-foreground">
                Agent Mode — web client
              </p>
            </div>
          </Link>

          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="hidden gap-1.5 border-white/10 sm:inline-flex"
            >
              <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/20 text-[10px] font-bold text-emerald-400">
                {userInitials(session?.name ?? null, session?.email ?? null)}
              </span>
              <span className="max-w-32 truncate text-xs">{displayName}</span>
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={handleSignOut}
              title="Keluar"
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Keluar</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Pesan */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          {messages.length === 0 ? (
            <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
              <div className="mb-5 flex size-14 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                <Bot className="size-7" />
              </div>
              <h2 className="text-xl font-bold tracking-tight">
                Kirim pesan ke Agent Mode
              </h2>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                Tanpa GitHub, tanpa Python — cukup cookie arena.ai. Chat dibuat
                lewat API{" "}
                <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[12px] text-emerald-300">
                  create-chat
                </code>{" "}
                dan jawaban agent mengalir di halaman arena.ai-mu.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {[
                  "halo, ini tes dari web",
                  "tolong buatkan puisi tentang coding",
                  "jelaskan cara kerja reCAPTCHA",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => handleSend(suggestion)}
                    disabled={isStreaming}
                    className="rounded-full border border-white/10 bg-card/60 px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {message.role === "assistant" && (
                    <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                      <Bot className="size-4" />
                    </div>
                  )}
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      message.role === "user"
                        ? "bg-emerald-500 text-zinc-950"
                        : message.status === "error"
                          ? "border border-red-500/30 bg-red-500/10 text-red-300"
                          : "border border-white/10 bg-card/60"
                    }`}
                  >
                    {message.role === "assistant" ? (
                      message.sessionId ? (
                        <div className="space-y-3">
                          <p className="flex items-center gap-2 font-medium text-emerald-300">
                            <Bot className="size-4" />
                            Chat berhasil dibuat
                          </p>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            Jawaban agent mengalir di halaman arena.ai (halaman
                            arena tidak mengizinkan embed, jadi dibuka di tab
                            baru).
                          </p>
                          <Button
                            asChild
                            size="sm"
                            className="bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
                          >
                            <a
                              href={`${ARENA_AGENT_URL}/${message.sessionId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Buka jawaban di arena.ai
                              <ExternalLink className="size-4" />
                            </a>
                          </Button>
                          <p className="break-all font-mono text-[11px] text-muted-foreground/60">
                            {ARENA_AGENT_URL}/{message.sessionId}
                          </p>
                        </div>
                      ) : message.content ? (
                        <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed">
                          {message.content}
                          {message.status === "streaming" && (
                            <span className="ml-0.5 inline-block h-3.5 w-2 animate-pulse bg-emerald-400 align-middle" />
                          )}
                        </pre>
                      ) : (
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <span className="inline-block size-3 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
                          Membuat chat di arena.ai...
                        </span>
                      )
                    ) : (
                      <p className="whitespace-pre-wrap break-words">
                        {message.content}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      {/* Composer */}
      <footer className="border-t border-white/10 bg-card/40 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl px-4 py-3">
          {/* Panel token reCAPTCHA manual — fallback saat token otomatis ditolak */}
          <div className="mb-2">
            <button
              type="button"
              onClick={() => setShowTokenPanel((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-emerald-300"
            >
              {showTokenPanel ? "▾" : "▸"} Token reCAPTCHA manual
            </button>
            {showTokenPanel && (
              <div className="mt-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Kalau token otomatis ditolak arena (403{" "}
                  <code className="font-mono">recaptcha validation failed</code>
                  ), ambil token FRESH dari halaman arena.ai: buka{" "}
                  <a
                    href="https://arena.ai/agent"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
                  >
                    arena.ai/agent
                  </a>{" "}
                  → klik bookmarklet di bawah → token tersalin → tempel di sini →
                  kirim ulang. Token berlaku ±2 menit & sekali pakai.
                </p>
                <div className="mt-2 flex items-start gap-2">
                  <code className="max-h-16 flex-1 overflow-y-auto rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-[9.5px] leading-relaxed text-emerald-300">
                    {ARENA_RECAPTCHA_BOOKMARKLET}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={copyRecaptchaBookmarklet}
                    className="shrink-0 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                  >
                    {copiedBookmarklet ? "Tersalin ✓" : "Salin bookmarklet"}
                  </Button>
                </div>
                <Textarea
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  placeholder="Tempel token reCAPTCHA di sini (mulai dengan 0cAFcWeA…)"
                  rows={2}
                  spellCheck={false}
                  className="mt-2 min-h-16 resize-none border-white/10 bg-black/30 font-mono text-[10.5px] leading-relaxed placeholder:text-muted-foreground/40"
                />
                <p className="mt-1.5 text-[10.5px] text-muted-foreground/70">
                  Cara buat bookmarklet: bookmark baru → tempel kode sebagai
                  alamat → jalankan di arena.ai/agent saat sudah login.
                </p>
              </div>
            )}
          </div>

          {bannerError && (
            <div className="mb-2 flex items-start justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300">
              <span>{bannerError}</span>
              <button
                type="button"
                onClick={() => setBannerError(null)}
                className="shrink-0 underline underline-offset-2 hover:text-red-200"
              >
                tutup
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={
                isStreaming
                  ? "Membuat chat di arena.ai..."
                  : "Tulis pesan untuk Agent Mode… (Enter untuk kirim)"
              }
              rows={1}
              disabled={isStreaming}
              className="max-h-40 min-h-11 flex-1 resize-none border-white/10 bg-black/30 text-sm placeholder:text-muted-foreground/50 disabled:opacity-60"
            />
            <Button
              type="button"
              onClick={() => void handleSend()}
              disabled={isStreaming || !input.trim()}
              className="h-11 bg-emerald-500 px-4 text-zinc-950 hover:bg-emerald-400"
              title="Kirim pesan"
            >
              {isStreaming ? (
                <span className="inline-block size-4 animate-spin rounded-full border-2 border-zinc-950 border-t-transparent" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </div>
          <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
            Chat dibuat via arena.ai/nextjs-api/stream/create-chat — cookie
            sesimu dipakai server-side, tidak pernah tampil di browser.
          </p>
        </div>
      </footer>
    </div>
  );
}
