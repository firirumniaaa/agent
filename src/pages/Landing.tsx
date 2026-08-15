import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  Cookie,
  KeyRound,
  Radio,
  ShieldCheck,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { motion } from "framer-motion";
import { Link } from "react-router";

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.5, ease: "easeOut" as const },
};

const STEPS = [
  {
    icon: KeyRound,
    title: "Login / Daftar",
    body: "Masuk pakai password atau kode email (akun otomatis dibuat saat kode diverifikasi), atau langsung pakai cookie arena.ai.",
  },
  {
    icon: Cookie,
    title: "Hubungkan sesi arena",
    body: "Tempel SELURUH document.cookie dari arena.ai/agent — sesi divalidasi ke /api/me sebelum disimpan.",
  },
  {
    icon: TerminalSquare,
    title: "Kirim pesan",
    body: "Chat dibuat lewat create-chat — tanpa GitHub — lalu jawaban agent dibuka di halaman arena.ai-mu.",
  },
];

const FEATURES = [
  {
    icon: Radio,
    title: "Streaming real-time",
    body: "Respons agent mengalir per-chunk via SSE — tanpa nunggu selesai dulu.",
  },
  {
    icon: ShieldCheck,
    title: "Cookie aman di server",
    body: "Cookie hanya dipakai server-side untuk memanggil API arena.ai, tidak pernah bocor ke klien.",
  },
  {
    icon: Zap,
    title: "Tanpa GitHub",
    body: "Mode chat biasa (create-chat) tidak butuh repo atau koneksi GitHub — cukup cookie arena.ai.",
  },
];

function TerminalMock() {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-black/50 shadow-2xl shadow-emerald-950/30">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-red-500/80" />
        <span className="size-2.5 rounded-full bg-amber-500/80" />
        <span className="size-2.5 rounded-full bg-emerald-500/80" />
        <span className="ml-2 font-mono text-[11px] text-muted-foreground">
          arena_agent_test.py — live
        </span>
      </div>
      <div className="space-y-2 p-4 font-mono text-[12px] leading-relaxed sm:p-5 sm:text-[13px]">
        <p className="text-muted-foreground">
          <span className="text-emerald-400">$</span> python3 arena_agent_test.py
          &quot;halo tes&quot;
        </p>
        <p className="text-muted-foreground">
          ============================================================
        </p>
        <p>
          1) Cek session{" "}
          <span className="text-muted-foreground">(/api/me)</span>
        </p>
        <p className="text-emerald-400">   HTTP 200 — Session valid ✅</p>
        <p className="pt-1">
          2) Kirim chat ke Agent Mode{" "}
          <span className="text-muted-foreground">
            (/api/coding-agent/sessions)
          </span>
        </p>
        <p className="text-muted-foreground">   message: &apos;halo tes&apos;</p>
        <p className="text-emerald-400">
          ✅ HTTP 200 — Session dibuat: 019f…a46b
        </p>
        <p className="text-muted-foreground">
          🎬 Buka jawabannya: arena.ai/agent/019f…a46b
        </p>
      </div>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="dark min-h-screen bg-background text-foreground antialiased">
      {/* Latar: grid terminal halus */}
      <div
        className="pointer-events-none fixed inset-0 opacity-40"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage:
            "radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)",
        }}
      />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.1),transparent_55%)]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4">
        {/* Nav */}
        <nav className="flex items-center justify-between py-5">
          <Link to="/" className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
              <TerminalSquare className="size-5" />
            </div>
            <span className="font-mono text-sm font-semibold tracking-tight">
              arena://agent
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Button
              asChild
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
            >
              <Link to="/auth">Masuk</Link>
            </Button>
            <Button
              asChild
              className="bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
            >
              <Link to="/auth">
                Buka Chat
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </nav>

        {/* Hero */}
        <section className="flex flex-1 flex-col items-center justify-center py-16 text-center">
          <motion.p
            {...fadeUp}
            className="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 font-mono text-xs text-emerald-400"
          >
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
            </span>
            Agent Mode — sekarang bisa dari browser
          </motion.p>

          <motion.h1
            {...fadeUp}
            transition={{ duration: 0.55, ease: "easeOut", delay: 0.05 }}
            className="max-w-3xl text-4xl font-bold leading-[1.1] tracking-tight sm:text-6xl"
          >
            Chat dengan{" "}
            <span className="text-emerald-400">Arena Coding Agent</span> tanpa
            Python
          </motion.h1>

          <motion.p
            {...fadeUp}
            transition={{ duration: 0.55, ease: "easeOut", delay: 0.12 }}
            className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg"
          >
            Login pakai password, kode email, atau cookie arena.ai — lalu
            kirim pesan ke Agent Mode dan chat dibuat otomatis tanpa GitHub,
            persis seperti menjalankan{" "}
            <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[13px] text-emerald-300">
              arena_agent_test.py
            </code>
            .
          </motion.p>

          <motion.div
            {...fadeUp}
            transition={{ duration: 0.55, ease: "easeOut", delay: 0.2 }}
            className="mt-8 flex flex-wrap items-center justify-center gap-3"
          >
            <Button
              asChild
              size="lg"
              className="h-11 bg-emerald-500 px-6 text-zinc-950 hover:bg-emerald-400"
            >
              <Link to="/auth">
                Login / Daftar
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-11 px-6">
              <a href="#cara-kerja">Cara pakai</a>
            </Button>
          </motion.div>

          <motion.div
            {...fadeUp}
            transition={{ duration: 0.6, ease: "easeOut", delay: 0.3 }}
            className="mt-12 w-full max-w-2xl"
          >
            <TerminalMock />
          </motion.div>
        </section>

        {/* Cara kerja */}
        <section id="cara-kerja" className="scroll-mt-10 py-20">
          <motion.div {...fadeUp} className="mb-10 text-center">
            <p className="font-mono text-xs text-emerald-500">
              // cara_kerja
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight">
              Tiga langkah, langsung jalan
            </h2>
          </motion.div>
          <div className="grid gap-4 sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <motion.div
                key={step.title}
                {...fadeUp}
                transition={{ duration: 0.5, ease: "easeOut", delay: index * 0.08 }}
                className="rounded-2xl border border-white/10 bg-card/50 p-6 transition-colors hover:border-emerald-500/30"
              >
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                    <step.icon className="size-5" />
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">
                    0{index + 1}
                  </span>
                </div>
                <h3 className="font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Fitur */}
        <section className="py-20">
          <motion.div {...fadeUp} className="mb-10 text-center">
            <p className="font-mono text-xs text-emerald-500">
              // fitur_v1
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight">
              Ringan, fokus, dan aman
            </h2>
          </motion.div>
          <div className="grid gap-4 sm:grid-cols-3">
            {FEATURES.map((feature, index) => (
              <motion.div
                key={feature.title}
                {...fadeUp}
                transition={{ duration: 0.5, ease: "easeOut", delay: index * 0.08 }}
                className="rounded-2xl border border-white/10 bg-card/50 p-6"
              >
                <feature.icon className="mb-4 size-6 text-emerald-400" />
                <h3 className="font-semibold">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {feature.body}
                </p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* CTA akhir */}
        <section className="py-20">
          <motion.div
            {...fadeUp}
            className="relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-card/50 to-transparent p-10 text-center sm:p-14"
          >
            <h2 className="text-3xl font-bold tracking-tight">
              Siap mencoba?
            </h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
              Buat akun dengan email + password atau kode email, lalu hubungkan
              cookie arena.ai-mu — dan kirim pesan pertamamu dalam hitungan
              detik.
            </p>
            <Button
              asChild
              size="lg"
              className="mt-7 h-11 bg-emerald-500 px-6 text-zinc-950 hover:bg-emerald-400"
            >
              <Link to="/auth">
                Masuk ke Dashboard
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </motion.div>
        </section>

        {/* Footer */}
        <footer className="flex flex-col items-center justify-between gap-3 border-t border-white/10 py-6 text-xs text-muted-foreground sm:flex-row">
          <p className="font-mono">arena://agent — web client</p>
          <p>
            Dibuat untuk dipakai dengan akun arena.ai milikmu sendiri.
          </p>
        </footer>
      </div>
    </div>
  );
}
