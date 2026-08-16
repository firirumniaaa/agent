import { api } from "@/convex/_generated/api";
import { useArenaSession } from "@/hooks/use-arena-session";
import { useAuth } from "@/hooks/use-auth";
import {
  ARENA_COOKIE_BOOKMARKLET,
  detectedCookieNames,
  isArenaCookieComplete,
  missingAuthCookies,
  SAMPLE_COOKIE,
} from "@/lib/arena-cookie";
import { useAction, useMutation } from "convex/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCopy,
  Cookie,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Mail,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  TriangleAlert,
  UserPlus,
  Zap,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

const CONVEX_SITE_URL = (import.meta.env.VITE_CONVEX_URL as string).replace(
  /\.cloud$/,
  ".site",
);

function resolveRedirect(returnTo: string | null, fallback = "/dashboard") {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

/** Terjemahkan pesan error auth dari server jadi kalimat yang enak dibaca. */
function translateAuthError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid credentials/i.test(msg)) {
    return "Email atau password salah. Coba lagi, atau daftar dulu.";
  }
  if (/invalid password/i.test(msg)) {
    return "Password tidak valid — minimal 8 karakter.";
  }
  if (/already exists|already an account/i.test(msg)) {
    return "Email sudah terdaftar. Masuk pakai password, atau pilih “Kode email”.";
  }
  if (/invalid email|email.*invalid/i.test(msg)) {
    return "Format email tidak valid.";
  }
  if (/delivery|send.*fail/i.test(msg)) {
    return "Gagal mengirim kode email. Cek alamatnya lalu coba lagi.";
  }
  return msg;
}

interface AuthProps {
  redirectAfterAuth?: string;
}

function Auth({ redirectAfterAuth = "/dashboard" }: AuthProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const redirect = resolveRedirect(searchParams.get("returnTo"), redirectAfterAuth);

  const { signIn, signOut, isAuthenticated } = useAuth();
  const login = useAction(api.arena.login);
  const registerTemp = useAction(api.arena.registerTempAccount);
  const logout = useMutation(api.arenaSession.logout);

  const { clientId, session, isLoading: sessionLoading } = useArenaSession();

  // Tab aktif disimpan di URL (?tab=masuk|daftar|arena) supaya bisa di-link,
  // mis. dari dashboard: /auth?tab=arena
  const tab = searchParams.get("tab") ?? "masuk";
  const setTab = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", value);
    setSearchParams(next, { replace: true });
  };

  // ---- Masuk: password ----
  const [loginMethod, setLoginMethod] = useState<"password" | "otp">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Masuk: kode email ----
  const [otpEmail, setOtpEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpStep, setOtpStep] = useState<"request" | "verify">("request");
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  // ---- Daftar (manual) ----
  const [regName, setRegName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regSubmitting, setRegSubmitting] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  // ---- Cookie arena ----
  const [cookie, setCookie] = useState("");
  const [cookieSubmitting, setCookieSubmitting] = useState(false);
  const [cookieError, setCookieError] = useState<string | null>(null);
  const [copiedBookmarklet, setCopiedBookmarklet] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [copiedAuto, setCopiedAuto] = useState(false);

  const detected = useMemo(() => detectedCookieNames(cookie), [cookie]);
  const missing = useMemo(() => missingAuthCookies(cookie), [cookie]);
  const isComplete = isArenaCookieComplete(cookie);

  // Sudah punya sesi arena aktif? Langsung masuk.
  useEffect(() => {
    if (!sessionLoading && session) {
      navigate(redirect, { replace: true });
    }
  }, [sessionLoading, session, navigate, redirect]);

  // ===== Masuk dengan password =====
  const handlePasswordLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("Isi email dan password dulu.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await signIn("password", {
        flow: "signIn",
        email: email.trim(),
        password,
      });
      navigate(redirect, { replace: true });
    } catch (err) {
      setError(translateAuthError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  // ===== Masuk dengan kode email (OTP) =====
  const sendOtp = async (target: string) => {
    setOtpSubmitting(true);
    setOtpError(null);
    try {
      await signIn("email-otp", { email: target });
      setOtpStep("verify");
    } catch (err) {
      setOtpError(translateAuthError(err));
    } finally {
      setOtpSubmitting(false);
    }
  };

  const handleOtpRequest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!otpEmail.trim()) {
      setOtpError("Masukkan alamat email dulu.");
      return;
    }
    await sendOtp(otpEmail.trim());
  };

  const handleOtpResend = async () => {
    if (otpEmail.trim()) {
      await sendOtp(otpEmail.trim());
    }
  };

  const handleOtpVerify = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = otpCode.trim();
    if (!code) {
      setOtpError("Masukkan kode 6 digit dari email.");
      return;
    }
    setOtpSubmitting(true);
    setOtpError(null);
    try {
      await signIn("email-otp", { email: otpEmail.trim(), code });
      navigate(redirect, { replace: true });
    } catch (err) {
      setOtpError(translateAuthError(err));
    } finally {
      setOtpSubmitting(false);
    }
  };

  // ===== Daftar manual =====
  const handleRegister = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!regName.trim() || !regEmail.trim() || !regPassword) {
      setRegError("Lengkapi nama, email, dan password.");
      return;
    }
    if (regPassword.length < 8) {
      setRegError("Password minimal 8 karakter.");
      return;
    }
    setRegSubmitting(true);
    setRegError(null);
    try {
      await signIn("password", {
        flow: "signUp",
        email: regEmail.trim(),
        password: regPassword,
        name: regName.trim(),
      });
      navigate(redirect, { replace: true });
    } catch (err) {
      setRegError(translateAuthError(err));
    } finally {
      setRegSubmitting(false);
    }
  };

  // ===== Cookie arena =====
  const handleCookieSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!cookie.trim()) {
      setCookieError(
        "Cookie masih kosong. Tempel dulu seluruh cookie dari arena.ai.",
      );
      return;
    }
    setCookieSubmitting(true);
    setCookieError(null);
    try {
      const result = await login({ clientId, cookie });
      if (result.ok) {
        navigate(redirect, { replace: true });
      } else {
        setCookieError(
          `HTTP ${result.status}: ${result.body || "Session tidak valid."}`,
        );
      }
    } catch (err) {
      setCookieError(
        err instanceof Error ? err.message : "Login gagal. Coba lagi.",
      );
    } finally {
      setCookieSubmitting(false);
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

  // Buat akun arena baru via email sementara: anon sign-up -> magic-link ->
  // set-password. Sesi disimpan untuk clientId ini, user langsung masuk.
  const handleRegisterTemp = async () => {
    setIsRegistering(true);
    setRegisterError(null);
    try {
      const result = await registerTemp({ clientId });
      if (result.ok) {
        navigate(redirect, { replace: true });
      } else {
        setRegisterError(
          result.error ||
            `Gagal membuat akun (signup=${result.steps.signup ?? "?"}, setPassword=${result.steps.setPassword ?? "?"}, me=${result.steps.me ?? "?"}, chatAuth=${result.steps.chatAuth ?? "?"}). Coba lagi, atau tempel cookie manual di atas.`,
        );
      }
    } catch (err) {
      setRegisterError(
        err instanceof Error
          ? err.message
          : "Gagal membuat akun tes. Coba lagi.",
      );
    } finally {
      setIsRegistering(false);
    }
  };

  // Bookmarklet auto-connect: URL-nya unik per browser (clientId sudah
  // terkunci), jadi sekali disalin cukup untuk browser ini selamanya.
  const autoConnectBookmarklet = `javascript:(async()=>{const c=document.cookie;if(!c){alert("Tidak ada cookie ditemukan. Login dulu di arena.ai.");return}try{const r=await fetch("${CONVEX_SITE_URL}/arena/connect-cookie",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId:"${clientId}",cookie:c})});const j=await r.json();if(j&&j.ok){alert("Sesi arena tersambung! Buka kembali aplikasi.")}else{alert("Gagal tersambung: "+(j&&(j.body||j.error)||("HTTP "+r.status)))}catch(e){alert("Gagal menghubungi aplikasi: "+e.message)}})()`;

  const copyAutoConnect = async () => {
    try {
      await navigator.clipboard.writeText(autoConnectBookmarklet);
      setCopiedAuto(true);
      setTimeout(() => setCopiedAuto(false), 2000);
    } catch {
      // abaikan — user bisa salin manual dari <code>
    }
  };

  // Keluar dari web (akun app) + lepas sesi arena browser ini.
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

  const methodButton = (active: boolean) =>
    `flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-emerald-500 text-zinc-950"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="dark min-h-screen bg-background text-foreground antialiased">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.08),transparent_60%)]" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-10">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
            <TerminalSquare className="size-6" />
          </div>
          <p className="font-mono text-xs text-emerald-500">arena://auth</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">
            Masuk / Daftar
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Login pakai password, kode email, atau cookie arena.ai — lalu chat
            dengan Agent Mode.
          </p>
        </div>

        {/* Sudah masuk ke web? */}
        {isAuthenticated && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
            <p className="flex items-center gap-2 text-sm text-emerald-300">
              <ShieldCheck className="size-4 shrink-0" />
              Kamu sudah masuk ke web ini.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                asChild
                size="sm"
                className="bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
              >
                <Link to={redirect}>
                  Ke Dashboard
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleSignOut}
                className="border-white/10 text-muted-foreground hover:text-foreground"
              >
                <LogOut className="size-4" />
                Keluar
              </Button>
            </div>
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3 bg-black/40">
            <TabsTrigger value="masuk">Masuk</TabsTrigger>
            <TabsTrigger value="daftar">Daftar</TabsTrigger>
            <TabsTrigger value="arena">Cookie arena</TabsTrigger>
          </TabsList>

          {/* ================= MASUK ================= */}
          <TabsContent value="masuk" className="mt-4">
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-black/30 p-1">
              <button
                type="button"
                onClick={() => setLoginMethod("password")}
                className={methodButton(loginMethod === "password")}
              >
                <span className="inline-flex items-center justify-center gap-1.5">
                  <Lock className="size-3.5" />
                  Password
                </span>
              </button>
              <button
                type="button"
                onClick={() => setLoginMethod("otp")}
                className={methodButton(loginMethod === "otp")}
              >
                <span className="inline-flex items-center justify-center gap-1.5">
                  <Mail className="size-3.5" />
                  Kode email
                </span>
              </button>
            </div>

            {loginMethod === "password" ? (
              <form
                onSubmit={handlePasswordLogin}
                className="mt-4 rounded-2xl border border-white/10 bg-card/60 p-6 shadow-2xl shadow-black/40 backdrop-blur"
              >
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="login-email">Email</Label>
                    <Input
                      id="login-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="nama@email.com"
                      autoComplete="email"
                      className="border-white/10 bg-black/30"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="login-password">Password</Label>
                    <Input
                      id="login-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                      className="border-white/10 bg-black/30"
                    />
                  </div>
                </div>

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
                      Memeriksa...
                    </>
                  ) : (
                    <>
                      <KeyRound className="size-4" />
                      Masuk
                    </>
                  )}
                </Button>
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  Belum punya akun?{" "}
                  <button
                    type="button"
                    onClick={() => setTab("daftar")}
                    className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
                  >
                    Daftar di sini
                  </button>
                </p>
              </form>
            ) : (
              <form
                onSubmit={otpStep === "request" ? handleOtpRequest : handleOtpVerify}
                className="mt-4 rounded-2xl border border-white/10 bg-card/60 p-6 shadow-2xl shadow-black/40 backdrop-blur"
              >
                {otpStep === "request" ? (
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="otp-email">Email</Label>
                      <Input
                        id="otp-email"
                        type="email"
                        value={otpEmail}
                        onChange={(e) => setOtpEmail(e.target.value)}
                        placeholder="nama@email.com"
                        autoComplete="email"
                        className="border-white/10 bg-black/30"
                      />
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Kode 6 digit dikirim ke emailmu. Kalau akunnya belum ada,
                      akun dibuat otomatis saat kode diverifikasi — tanpa perlu
                      password.
                    </p>
                    {otpError && (
                      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-300">
                        {otpError}
                      </div>
                    )}
                    <Button
                      type="submit"
                      disabled={otpSubmitting}
                      className="w-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
                    >
                      {otpSubmitting ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Mengirim kode...
                        </>
                      ) : (
                        <>
                          <Mail className="size-4" />
                          Kirim kode ke email
                        </>
                      )}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs">
                      <span className="text-muted-foreground">
                        Kode dikirim ke{" "}
                        <span className="font-medium text-foreground">
                          {otpEmail}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setOtpStep("request")}
                        className="shrink-0 text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
                      >
                        ganti email
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="otp-code">Kode 6 digit</Label>
                      <Input
                        id="otp-code"
                        value={otpCode}
                        onChange={(e) =>
                          setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                        }
                        placeholder="123456"
                        inputMode="numeric"
                        maxLength={6}
                        className="border-white/10 bg-black/30 text-center font-mono text-lg tracking-[0.5em]"
                      />
                    </div>
                    {otpError && (
                      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-300">
                        {otpError}
                      </div>
                    )}
                    <Button
                      type="submit"
                      disabled={otpSubmitting || otpCode.length !== 6}
                      className="w-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
                    >
                      {otpSubmitting ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Memverifikasi...
                        </>
                      ) : (
                        <>
                          <KeyRound className="size-4" />
                          Verifikasi & Masuk
                        </>
                      )}
                    </Button>
                    <button
                      type="button"
                      onClick={handleOtpResend}
                      disabled={otpSubmitting}
                      className="w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-emerald-300 disabled:opacity-50"
                    >
                      Kirim ulang kode
                    </button>
                  </div>
                )}
              </form>
            )}
          </TabsContent>

          {/* ================= DAFTAR ================= */}
          <TabsContent value="daftar" className="mt-4">
            <form
              onSubmit={handleRegister}
              className="rounded-2xl border border-white/10 bg-card/60 p-6 shadow-2xl shadow-black/40 backdrop-blur"
            >
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="reg-name">Nama lengkap</Label>
                  <Input
                    id="reg-name"
                    type="text"
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    placeholder="Heru Wijaya"
                    autoComplete="name"
                    className="border-white/10 bg-black/30"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-email">Email</Label>
                  <Input
                    id="reg-email"
                    type="email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="nama@email.com"
                    autoComplete="email"
                    className="border-white/10 bg-black/30"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-password">Password</Label>
                  <Input
                    id="reg-password"
                    type="password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="minimal 8 karakter"
                    autoComplete="new-password"
                    className="border-white/10 bg-black/30"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Minimal 8 karakter. Simpan baik-baik — dipakai untuk masuk
                    lagi.
                  </p>
                </div>
              </div>

              {regError && (
                <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-300">
                  {regError}
                </div>
              )}

              <Button
                type="submit"
                disabled={regSubmitting}
                className="mt-5 w-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
              >
                {regSubmitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Membuat akun...
                  </>
                ) : (
                  <>
                    <UserPlus className="size-4" />
                    Daftar & Masuk
                  </>
                )}
              </Button>
              <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">
                Alternatif: pilih tab{" "}
                <button
                  type="button"
                  onClick={() => {
                    setLoginMethod("otp");
                    setTab("masuk");
                  }}
                  className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
                >
                  Masuk → Kode email
                </button>
                . Akun dibuat otomatis saat kode diverifikasi — tanpa perlu
                password.
              </p>
            </form>
          </TabsContent>

          {/* ================= COOKIE ARENA ================= */}
          <TabsContent value="arena" className="mt-4">
            <form
              onSubmit={handleCookieSubmit}
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
                          <code className="font-mono">arena-auth-prod-v1.0</code>{" "}
                          +{" "}
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

              {cookieError && (
                <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-300">
                  {cookieError}
                </div>
              )}

              <Button
                type="submit"
                disabled={cookieSubmitting}
                className="mt-5 w-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
              >
                {cookieSubmitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Memverifikasi sesi...
                  </>
                ) : (
                  <>
                    <KeyRound className="size-4" />
                    Verifikasi & Hubungkan
                  </>
                )}
              </Button>
            </form>

            {/* Koneksi otomatis: bookmarklet auto-connect */}
            <div className="mt-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-sm">
              <p className="mb-1 flex items-center gap-2 font-medium">
                <Zap className="size-4 text-emerald-400" />
                Koneksi otomatis: bookmarklet “ARENA AUTO-CONNECT”
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Pasang bookmarklet ini sekali — URL-nya sudah unik untuk browser
                ini (clientId terkunci). Tiap kali kamu di arena.ai/agent
                (sudah login), klik bookmark → seluruh cookie terkirim otomatis
                ke server → kembali ke sini, sesi langsung tersambung tanpa
                menempel manual.
              </p>
              <div className="mt-3 flex items-start gap-2">
                <code className="max-h-24 flex-1 overflow-y-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-emerald-300">
                  {autoConnectBookmarklet}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={copyAutoConnect}
                  className="shrink-0 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                >
                  {copiedAuto ? "Tersalin ✓" : "Salin"}
                </Button>
              </div>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-[11px] leading-relaxed text-muted-foreground">
                <li>Klik “Salin” → buat bookmark baru → tempel sebagai alamat (URL).</li>
                <li>Buka arena.ai/agent, pastikan sudah login.</li>
                <li>
                  Klik bookmark → muncul konfirmasi “Sesi arena tersambung”.
                </li>
                <li>Kembali ke aplikasi ini — dashboard langsung siap dipakai.</li>
              </ol>
            </div>

            {/* Buat akun tes otomatis */}
            <div className="mt-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 font-medium">
                    <Sparkles className="size-4 text-emerald-400" />
                    Belum punya akun arena? Buat otomatis (email sementara)
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Server membuat akun baru via email sementara (anon sign-up →
                    magic-link → set-password), sesi langsung tersimpan — kamu
                    langsung masuk dashboard. Butuh waktu ±1 menit.
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={handleRegisterTemp}
                  disabled={isRegistering || cookieSubmitting}
                  className="shrink-0 bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
                >
                  {isRegistering ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Membuat akun...
                    </>
                  ) : (
                    <>
                      <UserPlus className="size-4" />
                      Buat akun tes
                    </>
                  )}
                </Button>
              </div>
              {registerError && (
                <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs leading-relaxed text-red-300">
                  {registerError}
                </div>
              )}
            </div>

            {/* Cara ambil cookie */}
            <div className="mt-6 rounded-2xl border border-white/10 bg-card/40 p-5 text-sm">
              <p className="mb-3 flex items-center gap-2 font-medium">
                <CheckCircle2 className="size-4 text-emerald-400" />
                Cara manual ambil cookie (kalau tidak pakai bookmarklet di atas)
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
                  <code className="font-mono">_ga</code>, dst. — satu string
                  panjang dipisah titik koma).
                </li>
                <li>Tempel hasilnya di kolom di atas, lalu klik Verifikasi.</li>
              </ol>
              <p className="mt-4 border-t border-white/10 pt-3 text-xs text-muted-foreground">
                Cookie disimpan aman di server dan hanya dipakai untuk memanggil
                API arena.ai atas namamu — tidak pernah dikirim ke klien lain.
              </p>
            </div>

            {/* Bookmarklet */}
            <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-sm">
              <p className="mb-1 flex items-center gap-2 font-medium">
                <ClipboardCopy className="size-4 text-emerald-400" />
                Cara cepat: bookmarklet “ARENA AUTH COOKIES”
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Sekali klik di arena.ai → muncul overlay berisi kedua cookie
                auth, dan{" "}
                <span className="font-semibold text-foreground">semua cookie</span>{" "}
                langsung tersalin ke clipboard (format persis seperti contoh di
                atas).
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
                <li>
                  Di browser: buat bookmark baru → tempel kode sebagai alamat
                  (URL).
                </li>
                <li>
                  Buka arena.ai/agent → klik bookmark → cookie otomatis
                  tersalin.
                </li>
              </ol>
            </div>
          </TabsContent>
        </Tabs>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          <Link
            to="/"
            className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
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
