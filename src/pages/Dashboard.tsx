import { api } from "@/convex/_generated/api";
import { useArenaSession } from "@/hooks/use-arena-session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useMutation } from "convex/react";
import {
  Bot,
  GitBranch,
  Loader2,
  LogOut,
  Send,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";

const CONVEX_SITE_URL = (import.meta.env.VITE_CONVEX_URL as string).replace(
  /\.cloud$/,
  ".site",
);

type MessageStatus = "streaming" | "error" | "done";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: MessageStatus;
}

interface RepoConfig {
  repoOwner: string;
  repoName: string;
  repoId: number;
}

const REPO_KEY = "arena:repo";

function loadRepoConfig(): RepoConfig | null {
  try {
    const raw = window.localStorage.getItem(REPO_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RepoConfig;
    if (
      parsed.repoOwner &&
      parsed.repoName &&
      typeof parsed.repoId === "number" &&
      parsed.repoId > 0
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveRepoConfig(config: RepoConfig) {
  window.localStorage.setItem(REPO_KEY, JSON.stringify(config));
}

/** Ubah body error arena.ai (JSON polos / ZodError) jadi pesan yang jelas. */
function formatArenaError(status: number, body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body.slice(0, 600);
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as { error?: unknown; success?: boolean };
    const err = obj.error;
    if (typeof err === "string") {
      if (err === "coding_agent_disabled") {
        return (
          "Arena menolak: fitur coding agent dinonaktifkan di akun arena.ai kamu. " +
          "Aktifkan Agent Mode dan sambungkan GitHub di arena.ai, lalu coba lagi."
        );
      }
      return err;
    }
    if (obj.success === false && err && typeof err === "object") {
      const issues = (err as {
        issues?: { path?: Array<string | number>; message?: string }[];
      }).issues;
      const first = issues?.[0];
      if (first) {
        const field = first.path?.join(".");
        return `Arena menolak data: ${first.message ?? "tidak valid"}${
          field ? ` (${field})` : ""
        }`;
      }
      return "Arena menolak data yang dikirim.";
    }
  }
  return `HTTP ${status}: ${body.slice(0, 600)}`;
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
  const logout = useMutation(api.arenaSession.logout);
  const navigate = useNavigate();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);

  // Konfigurasi repo target (disimpan di localStorage browser ini).
  const [repoConfig, setRepoConfig] = useState<RepoConfig | null>(() =>
    loadRepoConfig(),
  );
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [repoInput, setRepoInput] = useState("");
  const [repoSaving, setRepoSaving] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Kalau repo diatur via Keys (env) dan belum ada konfigurasi lokal, pakai itu.
  useEffect(() => {
    if (
      session?.repoConfigured &&
      session.repoId &&
      !loadRepoConfig()
    ) {
      setRepoConfig({
        repoOwner: session.repoOwner,
        repoName: session.repoName,
        repoId: session.repoId,
      });
    }
  }, [session]);

  if (!isLoading && !session) {
    return <Navigate to="/auth" replace />;
  }

  const openRepoDialog = () => {
    setRepoError(null);
    setRepoInput(
      repoConfig ? `${repoConfig.repoOwner}/${repoConfig.repoName}` : "",
    );
    setRepoDialogOpen(true);
  };

  const handleSaveRepo = async () => {
    const value = repoInput
      .trim()
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/\/+$/, "");
    const parts = value.split("/").filter(Boolean);
    if (parts.length < 2) {
      setRepoError("Format: username/nama-repo (contoh: facebook/react)");
      return;
    }
    const [owner, name] = parts;
    setRepoSaving(true);
    setRepoError(null);
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(
            "Repo tidak ditemukan di GitHub. Periksa pemilik dan nama repo.",
          );
        }
        throw new Error(`GitHub API error ${res.status}`);
      }
      const data = (await res.json()) as { id?: number };
      if (!data.id) {
        throw new Error("GitHub tidak mengembalikan id repo.");
      }
      const config: RepoConfig = {
        repoOwner: owner,
        repoName: name,
        repoId: data.id,
      };
      saveRepoConfig(config);
      setRepoConfig(config);
      setRepoDialogOpen(false);
    } catch (err) {
      setRepoError(
        err instanceof Error ? err.message : "Gagal mengambil info repo.",
      );
    } finally {
      setRepoSaving(false);
    }
  };

  const handleSend = async (raw?: string) => {
    const message = (raw ?? input).trim();
    if (!message || isStreaming) return;

    if (!repoConfig) {
      setBannerError(
        "Repo target belum diatur — Arena menolak chat tanpa repo. Atur dulu lewat tombol repo di kanan atas.",
      );
      openRepoDialog();
      return;
    }

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

    let received = "";
    try {
      const res = await fetch(`${CONVEX_SITE_URL}/arena/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          message,
          repoOwner: repoConfig.repoOwner,
          repoName: repoConfig.repoName,
          repoId: repoConfig.repoId,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(formatArenaError(res.status, text));
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: received } : m,
          ),
        );
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, status: "done" } : m,
        ),
      );
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : "Terjadi kesalahan tak terduga.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: detail,
                status: "error",
              }
            : m,
        ),
      );
    } finally {
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  };

  const handleSignOut = async () => {
    await logout({ clientId });
    navigate("/");
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
            {repoConfig ? (
              <button
                type="button"
                onClick={openRepoDialog}
                title="Ubah repo target (Arena butuh repo untuk diproses)"
              >
                <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400 transition-colors hover:bg-emerald-500/20">
                  <GitBranch className="size-3" />
                  {repoConfig.repoOwner}/{repoConfig.repoName}
                </Badge>
              </button>
            ) : (
              <button
                type="button"
                onClick={openRepoDialog}
                title="Arena menolak chat tanpa repo. Klik untuk mengatur."
              >
                <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-400 transition-colors hover:bg-amber-500/20">
                  <TriangleAlert className="size-3" />
                  Atur repo
                </Badge>
              </button>
            )}
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
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={handleSignOut}
              title="Keluar"
            >
              <LogOut className="size-4" />
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
                Respons agent akan mengalir di sini secara real-time — sama
                seperti menjalankan{" "}
                <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[12px] text-emerald-300">
                  arena_agent_test.py
                </code>
                . Pastikan repo target sudah diatur (badge hijau di pojok kanan
                atas).
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {[
                  "halo, ini tes dari web",
                  "jelaskan isi repo ini",
                  "tolong perbaiki bug di file utama",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => handleSend(suggestion)}
                    disabled={isStreaming || !repoConfig}
                    className="rounded-full border border-white/10 bg-card/60 px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
              {!repoConfig && (
                <Button
                  type="button"
                  onClick={openRepoDialog}
                  variant="outline"
                  className="mt-6 h-10"
                >
                  <GitBranch className="size-4" />
                  Atur repo target dulu
                </Button>
              )}
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
                      message.content ? (
                        <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed">
                          {message.content}
                          {message.status === "streaming" && (
                            <span className="ml-0.5 inline-block h-3.5 w-2 animate-pulse bg-emerald-400 align-middle" />
                          )}
                        </pre>
                      ) : (
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <span className="inline-block size-3 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
                          Agent sedang menulis...
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
                  ? "Agent sedang membalas..."
                  : repoConfig
                    ? "Tulis pesan untuk Agent Mode… (Enter untuk kirim)"
                    : "Atur repo target dulu, lalu tulis pesan…"
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
            Pesan dikirim ke arena.ai/coding-agent — cookie sesimu dipakai
            server-side, tidak pernah tampil di browser.
          </p>
        </div>
      </footer>

      {/* Dialog pengaturan repo */}
      <Dialog open={repoDialogOpen} onOpenChange={setRepoDialogOpen}>
        <DialogContent className="border-white/10 bg-card text-foreground">
          <DialogHeader>
            <DialogTitle>Repo target</DialogTitle>
            <DialogDescription>
              Arena Agent menolak chat tanpa repo. Masukkan owner dan nama repo
              GitHub — ID repo diambil otomatis dari GitHub.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveRepo();
                }
              }}
              placeholder="username/nama-repo"
              spellCheck={false}
              className="border-white/10 bg-black/30 font-mono placeholder:text-muted-foreground/50"
            />
            {repoError && (
              <p className="text-xs leading-relaxed text-red-300">
                {repoError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRepoDialogOpen(false)}
            >
              Batal
            </Button>
            <Button
              type="button"
              onClick={() => void handleSaveRepo()}
              disabled={repoSaving}
              className="bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
            >
              {repoSaving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Memeriksa...
                </>
              ) : (
                <>
                  <GitBranch className="size-4" />
                  Simpan repo
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
