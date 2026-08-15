/**
 * reCAPTCHA Enterprise — arena.ai mewajibkan token reCAPTCHA asli untuk
 * endpoint chat biasa (/nextjs-api/stream/create-chat).
 *
 * Aturan praktis yang sudah terbukti lewat tes:
 *  - Token yang di-mint di browser arena.ai (bookmarklet) → create-chat 200 ✅
 *  - Token yang di-mint server-side (anchor) → 403 "recaptcha validation failed" ❌
 *  - Token dipakai SATU KALI dan kedaluwarsa ±2 menit — kalau dipakai ulang
 *    (mis. dikirim 2x) pasti 403.
 *
 * Karena itu aplikasi mencoba mint token di browser kita dulu, dan kalau
 * ditolak arena, user diminta ambil token FRESH dari arena.ai via bookmarklet
 * lalu menempelnya di kolom manual.
 */
const ARENA_SITE_KEY = "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0";
const ARENA_ACTION = "agentic_chat_submit";

/**
 * Bookmarklet "ARENA RECAPTCHA TOKEN": jalankan DI HALAMAN arena.ai/agent,
 * token reCAPTCHA Enterprise langsung tersalin ke clipboard. Berlaku ±2 menit
 * dan hanya bisa dipakai sekali — buat token baru tiap mau kirim pesan.
 *
 * Cara pakai: buat bookmark baru di browser → tempel kode ini sebagai alamat →
 * buka arena.ai/agent (sudah login) → klik bookmark → tempel token di aplikasi.
 */
export const ARENA_RECAPTCHA_BOOKMARKLET = `javascript:(async()=>{const t=await grecaptcha.enterprise.execute("${ARENA_SITE_KEY}",{action:"${ARENA_ACTION}"});const c=async()=>{try{await navigator.clipboard.writeText(t)}catch(e){const a=document.createElement("textarea");a.value=t;document.body.appendChild(a);a.select();document.execCommand("copy");a.remove()}};await c();alert("Token reCAPTCHA tersalin! Berlaku ~2 menit — langsung tempel di web app.")})()`;

let scriptPromise: Promise<void> | null = null;

function loadRecaptchaScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    if (document.getElementById("arena-recaptcha-script")) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.id = "arena-recaptcha-script";
    script.src = `https://www.google.com/recaptcha/enterprise.js?render=${ARENA_SITE_KEY}`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(
        new Error(
          "Gagal memuat reCAPTCHA arena.ai. Periksa koneksi atau coba muat ulang halaman.",
        ),
      );
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/**
 * Mint token reCAPTCHA Enterprise V3 untuk create-chat arena.ai.
 *
 * Catatan: token ini di-mint di domain aplikasi kita. Kalau arena.ai
 * memvalidasi hostname asal token, hasilnya akan 403 — kalau begitu, gunakan
 * token manual dari bookmarklet (ARENA_RECAPTCHA_BOOKMARKLET) yang di-mint di
 * arena.ai dan sudah terbukti diterima.
 */
export async function getArenaRecaptchaToken(): Promise<string> {
  await loadRecaptchaScript();
  const enterprise = window.grecaptcha?.enterprise;
  if (!enterprise?.execute) {
    throw new Error("reCAPTCHA Enterprise tidak tersedia di browser ini.");
  }
  return new Promise<string>((resolve, reject) => {
    enterprise.ready?.(() => {
      enterprise
        .execute!(ARENA_SITE_KEY, { action: ARENA_ACTION })
        .then(resolve)
        .catch((err: unknown) =>
          reject(
            err instanceof Error
              ? err
              : new Error("Gagal mendapatkan token reCAPTCHA."),
          ),
        );
    });
  });
}

/** true kalau pesan error arena menunjukkan token reCAPTCHA ditolak. */
export function isRecaptchaError(message: string): boolean {
  return /recaptcha|403/i.test(message);
}
