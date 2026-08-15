import { api } from "@/convex/_generated/api";
import { useArenaSession } from "@/hooks/use-arena-session";
import { useAction } from "convex/react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CheckCircle2,
  Cookie,
  KeyRound,
  Loader2,
  TerminalSquare,
} from "lucide-react";
import { Suspense, useEffect, useState } from "react";
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

  // Sudah login? Langsung masuk.
  useEffect(() => {
    if (!sessionLoading && session) {
      navigate(redirect, { replace: true });
    }
  }, [sessionLoading, session, navigate, redirect]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!cookie.trim()) {
      setError("Cookie masih kosong. Tempel dulu cookie dari arena.ai.");
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

  return (
    <div className="dark min-h-screen bg-background text-foreground antialiased">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.08),transparent_60%)]" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
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
            Tempel cookie sesi arena.ai-mu, lalu kirim pesan ke Agent Mode dari
            browser.
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
            Cookie arena.ai
          </label>
          <Textarea
            id="arena-cookie"
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder={"arena-auth-prod-v1.0=...;\narena-auth-prod-v1.1=..."}
            rows={4}
            spellCheck={false}
            className="min-h-24 border-white/10 bg-black/30 font-mono text-xs leading-relaxed placeholder:text-muted-foreground/50"
          />

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
            Cara ambil cookie
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
              lalu salin seluruh hasilnya.
            </li>
            <li>Tempel hasilnya di kolom di atas, lalu klik Verifikasi.</li>
          </ol>
          <p className="mt-4 border-t border-white/10 pt-3 text-xs text-muted-foreground">
            Cookie disimpan aman di server dan hanya dipakai untuk memanggil API
            arena.ai atas namamu — tidak pernah dikirim ke klien lain.
          </p>
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
