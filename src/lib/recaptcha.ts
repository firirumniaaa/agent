/**
 * reCAPTCHA Enterprise — arena.ai mewajibkan token reCAPTCHA asli untuk
 * endpoint chat biasa (/nextjs-api/stream/create-chat). Token di-mint di
 * browser dengan sitekey publik arena.ai + action yang sama persis dengan
 * frontend mereka ("agentic_chat_submit"), lalu dikirim server-side.
 */
const ARENA_SITE_KEY = "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0";
const ARENA_ACTION = "agentic_chat_submit";

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

/** Mint token reCAPTCHA Enterprise V3 untuk create-chat arena.ai. */
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
