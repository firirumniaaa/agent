/**
 * Mint token reCAPTCHA Enterprise ala browser, untuk origin ARENA.AI.
 *
 * Kenapa sebelumnya selalu 403 ("recaptcha validation failed")?
 *  - Token di-mint untuk origin yang salah: lmarena.ai, padahal chat terjadi
 *    di arena.ai/agent ("base arena agent").
 *  - Request anchor dilakukan TANPA cookie Google (NID/1P_JAR dll). Browser
 *    punya cookie Google yang lengkap saat grecaptcha.enterprise.execute()
 *    jalan — token hasil mint tanpa cookie itu dianggap token "ghost"/berisiko
 *    dan ditolak arena.
 *
 * Alur di sini (meniru browser):
 *   1) GET anchor  -> merge SEMUA Set-Cookie Google ke jar sendiri
 *   2) ambil token awal + nilai `c` (untuk reload) dari HTML anchor
 *   3) POST reload -> merge Set-Cookie lagi -> token segar dari respons
 *   4) kembalikan token reload kalau ada, fallback token anchor.
 *
 * Aman untuk debug: tidak pernah melog cookie/token mentah — hanya dipakai
 * internal lalu token dikirim ke create-chat.
 */
import { CookieJar, fetchWithJar } from "./cookieJar";

const RECAPTCHA_KEY = "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0";

// base64("https://arena.ai") TANPA padding — Google menolak `==`
// ("Invalid domain for site key"). Ini origin tempat chat Agent Mode terjadi.
const ORIGIN = "https://arena.ai";
const ORIGIN_B64 = "aHR0cHM6Ly9hcmVuYS5haQ";

const VERSION = "XOqlk8PL_yVx6IdpLbpXdiLy";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Cari string token reCAPTCHA di struktur JSON respons reload (rekursif). */
function findTokenInJson(value: unknown, depth = 0): string | null {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") {
    // Token reCAPTCHA: string panjang, karakter base64url + titik.
    return /^[A-Za-z0-9_\-.]{100,}$/.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTokenInJson(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const found = findTokenInJson(
        (value as Record<string, unknown>)[key],
        depth + 1,
      );
      if (found) return found;
    }
  }
  return null;
}

/**
 * Mint token reCAPTCHA Enterprise untuk origin arena.ai, dengan cookie jar
 * Google yang lengkap (anchor -> merge -> reload -> merge).
 */
export async function mintArenaRecaptchaToken(): Promise<string | null> {
  // Jar khusus Google — cookie dari anchor/reload di-merge di sini, persis
  // seperti browser yang menyimpan cookie google.com.
  const jar = CookieJar.empty();
  const cb = Math.random().toString(36).slice(2);
  const anchorUrl =
    `https://www.google.com/recaptcha/enterprise/anchor?ar=1` +
    `&k=${RECAPTCHA_KEY}` +
    `&co=${ORIGIN_B64}` +
    `&hl=en&v=${VERSION}&size=invisible&cb=${cb}`;

  const baseHeaders = {
    "User-Agent": UA,
    Origin: ORIGIN,
    Referer: ORIGIN + "/agent",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  };

  // 1) GET anchor — merge Set-Cookie Google ke jar.
  let html = "";
  try {
    const res = await fetchWithJar(jar, anchorUrl, {
      headers: {
        ...baseHeaders,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(15_000),
    });
    html = await res.text();
  } catch {
    return null;
  }

  const anchorToken =
    html.match(/id="recaptcha-token" value="([^"]+)"/)?.[1] ?? null;

  // 2) POST reload — token segar (yang dipakai grecaptcha.execute()).
  //    Nilai `c` untuk reload = token anchor itu sendiri (terverifikasi).
  let reloadToken: string | null = null;
  if (anchorToken) {
    try {
      const body = new URLSearchParams({
        v: VERSION,
        reason: "q",
        c: anchorToken,
        k: RECAPTCHA_KEY,
        co: ORIGIN_B64,
        hl: "en",
        size: "invisible",
        sa: "request",
      });
      const res = await fetchWithJar(
        jar,
        "https://www.google.com/recaptcha/enterprise/reload",
        {
          method: "POST",
          headers: {
            ...baseHeaders,
            Referer: anchorUrl,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
          signal: AbortSignal.timeout(15_000),
        },
      );
      const text = await res.text();
      try {
        // Respons punya prefix anti-XSSI ")]}'" — buang dulu.
        const cleaned = text.replace(/^\s*\)\]\}'\s*/, "");
        const parsed = JSON.parse(cleaned) as unknown;
        reloadToken = findTokenInJson(parsed);
      } catch {
        // Bukan JSON murni — coba regex string token panjang.
        const m = text.match(/"([A-Za-z0-9_\-.]{100,})"/);
        reloadToken = m?.[1] ?? null;
      }
    } catch {
      reloadToken = null;
    }
  }

  return reloadToken ?? anchorToken;
}
