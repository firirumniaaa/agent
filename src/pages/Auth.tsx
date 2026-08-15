import { api } from "@/convex/_generated/api";
import { useArenaSession } from "@/hooks/use-arena-session";
import {
  ARENA_COOKIE_BOOKMARKLET,
  detectedCookieNames,
  isArenaCookieComplete,
  missingAuthCookies,
  SAMPLE_COOKIE,
} from "@/lib/arena-cookie";
import { useAction } from "convex/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CheckCircle2,
  ClipboardCopy,
  Cookie,
  KeyRound,
  Loader2,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

function resolveRedirect(returnTo: string | null, fallback = "/dashboard") {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

interface AuthProps {
  redirectAfterAuth?: string;
}

function Auth({ redirectAfterAuth = "/dashboard" }: AuthProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirect(searchParams.get("returnTo"), redirectAfterAuth);
  const login = useAction(api.arena.login);

  const { clientId, session, isLoading: sessionLoading } = useArenaSession();
  const [cookie, setCookie] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedBookmarklet, setCopiedBookmarklet] = useState(false);

  // Feedback real-time soal kelengkapan cookie yang ditempel.
  const detected = useMemo(() => detectedCookieNames(cookie), [cookie]);
  const missing = useMemo(() => missingAuthCookies(cookie), [cookie]);
  const isComplete = isArenaCookieComplete(cookie);

  // Sudah login? Langsung masuk.
  useEffect(() => {
    if (!sessionLoading && session) {
      navigate(redirect, { replace: true });
    }
  }, [sessionLoading, session, navigate, redirect]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!cookie.trim()) {
      setError("Cookie masih kosong. Tempel dulu seluruh cookie dari arena.ai.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await login({ clientId, cookie });
      if (result.ok) {
        navigate(redirect, { replace: true });
      } else {
        setError(
          `HTTP ${result.status}: ${result.body || "Session tidak valid."}`,
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Login gagal. Coba lagi.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyBookmarklet = async () => {
    try {
      await navigator.clipboard.writeText(ARENA_COOKIE_BOOKMARKLET);
      setCopiedBookmarklet(true);
      setTimeout(() => setCopiedBookmarklet(false), 2000);
    } catch {
      // abaikan — user bisa salin manual dari <code>
    }
  };

  return (
    <div className="dark min-h-screen bg-background text-foreground antialiased">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.08),transparent_60%)]" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-10">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
            <TerminalSquare className="size-6" />
          </div>
          <p className="font-mono text-xs text-emerald-500">
            arena://login
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">
            Masuk dengan cookie arena.ai
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Tempel <span className="font-semibold text-foreground">seluruh</span>{" "}
            cookie sesi arena.ai-mu (semua hasil{" "}
            <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[12px] text-emerald-300">
              document.cookie
            </code>
            ), lalu kirim pesan ke Agent Mode.
          </p>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-white/10 bg-card/60 p-6 shadow-2xl shadow-black/40 backdrop-blur"
        >
          <label
            htmlFor="arena-cookie"
            className="mb-2 flex items-center gap-2 text-sm font-medium"
          >
            <Cookie className="size-4 text-emerald-400" />
            Cookie arena.ai (lengkap — semua cookie)
          </label>
          <Textarea
            id="arena-cookie"
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder={SAMPLE_COOKIE}
            rows={6}
            spellCheck={false}
            className="min-h-32 border-white/10 bg-black/30 font-mono text-[11px] leading-relaxed placeholder:text-muted-foreground/40"
          />

          {/* Status kelengkapan cookie */}
          {cookie.trim() && (
            <div className="mt-3 space-y-2">
              <div
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                  isComplete
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-300"
                }`}
              >
                {isComplete ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                )}
                <div>
                  {isComplete ? (
                    <>
                      Cookie lengkap —{" "}
                      <code className="font-mono">arena-auth-prod-v1.0</code> +{" "}
                      <code className="font-mono">arena-auth-prod-v1.1</code>{" "}
                      terdeteksi (+ {detected.length - 2} cookie lain).
                    </>
                  ) : (
                    <>
                      Cookie belum lengkap. Yang kurang:{" "}
                      <code className="font-mono">
                        {missing.join("</code>, <code className=\"font-mono\">")}
                      </code>
                      . Tempel <span className="font-semibold">seluruh</span>{" "}
                      hasil{" "}
                      <code className="rounded bg-black/40 px-1 py-0.5 font-mono">
                        document.cookie
                      </code>{" "}
                      — bukan cuma 2 cookie auth.
                    </>
                  )}
                </div>
              </div>
              {detected.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {detected.slice(0, 8).map((name) => (
                    <span
                      key={name}
                      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                        name.startsWith("arena-auth-prod")
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                          : "border-white/10 bg-black/30 text-muted-foreground"
                      }`}
                    >
                      {name}
                    </span>
                  ))}
                  {detected.length > 8 && (
                    <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                      +{detected.length - 8} lainnya
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-300">
              {error}
            </div>
          )}

          <Button
            type="submit"
            disabled={isSubmitting}
            className="mt-5 w-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Memverifikasi sesi...
              </>
            ) : (
              <>
                <KeyRound className="size-4" />
                Verifikasi & Masuk
              </>
            )}
          </Button>
        </form>

        {/* Cara ambil cookie */}
        <div className="mt-6 rounded-2xl border border-white/10 bg-card/40 p-5 text-sm">
          <p className="mb-3 flex items-center gap-2 font-medium">
            <CheckCircle2 className="size-4 text-emerald-400" />
            Cara ambil cookie (harus lengkap)
          </p>
          <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
            <li>
              Buka{" "}
              <a
                href="https://arena.ai/agent"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline decoration-emerald-400/40 underline-offset-2 hover:text-emerald-300"
              >
                arena.ai/agent
              </a>{" "}
              lalu login akun Arena-mu.
            </li>
            <li>Buka DevTools (F12) → tab Console.</li>
            <li>
              Jalankan{" "}
              <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-emerald-300">
                document.cookie
              </code>{" "}
              lalu salin{" "}
              <span className="font-semibold text-foreground">SELURUH</span>{" "}
              hasilnya (semua cookie:{" "}
              <code className="font-mono">arena-auth-prod-v1.0</code>,{" "}
              <code className="font-mono">arena-auth-prod-v1.1</code>,{" "}
              <code className="font-mono">user_country_code</code>,{" "}
              <code className="font-mono">_ga</code>, dst. — satu string panjang
              dipisah titik koma).
            </li>
            <li>Tempel hasilnya di kolom di atas, lalu klik Verifikasi.</li>
          </ol>
          <p className="mt-4 border-t border-white/10 pt-3 text-xs text-muted-foreground">
            Cookie disimpan aman di server dan hanya dipakai untuk memanggil API
            arena.ai atas namamu — tidak pernah dikirim ke klien lain.
          </p>
        </div>

        {/* Bookmarklet */}
        <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-sm">
          <p className="mb-1 flex items-center gap-2 font-medium">
            <ClipboardCopy className="size-4 text-emerald-400" />
            Cara cepat: bookmarklet “ARENA AUTH COOKIES”
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Sekali klik di arena.ai → muncul overlay berisi kedua cookie auth,
            dan <span className="font-semibold text-foreground">semua cookie</span>{" "}
            langsung tersalin ke clipboard (format persis seperti contoh di atas).
          </p>
          <div className="mt-3 flex items-start gap-2">
            <code className="max-h-24 flex-1 overflow-y-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-emerald-300">
              {ARENA_COOKIE_BOOKMARKLET}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copyBookmarklet}
              className="shrink-0 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
            >
              {copiedBookmarklet ? "Tersalin ✓" : "Salin"}
            </Button>
          </div>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[11px] leading-relaxed text-muted-foreground">
            <li>Salin kode di atas.</li>
            <li>Di browser: buat bookmark baru → tempel kode sebagai alamat (URL).</li>
            <li>Buka arena.ai/agent → klik bookmark → cookie otomatis tersalin.</li>
          </ol>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          <Link to="/" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
            Kembali ke beranda
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
