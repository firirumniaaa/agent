/**
 * CookieJar — utility untuk menangkap SEMUA Set-Cookie dari respons HTTP dan
 * mengirimnya kembali pada request berikutnya.
 *
 * Kenapa tidak pakai `response.headers.get("set-cookie")` secara naif?
 * - Header "set-cookie" sering berisi BANYAK cookie yang digabung jadi satu
 *   string dengan pemisah koma — dan koma juga muncul di atribut Expires
 *   ("Wed, 21 Oct 2015 ..."), jadi split naif pakai koma bakal rusak.
 * - `getSetCookie()` (Node 18+ / runtime Convex) mengembalikan satu string
 *   PER cookie — itu sumber utama. `headers.raw()["set-cookie"]` (undici)
 *   dipakai sebagai cadangan. Fallback terakhir: split aman dari
 *   `headers.get("set-cookie")`.
 *
 * Aturan pakai:
 *   const jar = CookieJar.empty();
 *   const res = await fetchWithJar(jar, url, init);        // auto merge
 *   const { response } = await followRedirectsWithJar(jar, url, init);
 *   jar.header(); // untuk header Cookie request berikutnya
 *
 * Panggil mergeResponse/fetchWithJar setelah TIAP request penting (signup,
 * magic-link, callback, set-password, /me, chat). Jangan pernah log cookie
 * mentah — hanya nama-namanya (jar.names()).
 */

/** Atribut Set-Cookie yang dipahami (selain name/value). */
export type SetCookieAttributes = {
  expires?: string;
  maxAge?: number;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
};

/** Hasil parse satu header Set-Cookie. */
export type ParsedSetCookie = {
  name: string;
  value: string;
  attributes: SetCookieAttributes;
};

/**
 * Pecah string Set-Cookie gabungan jadi array per-cookie dengan aman.
 * Koma hanya dianggap pemisah kalau BUKAN bagian dari atribut Expires=
 * ("Wed, 21 Oct ..." — RFC 6265). Ini meniru set-cookie-parser.splitCookiesString.
 */
export function splitSetCookieString(input: string): string[] {
  if (!input) return [];
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ",") {
      // Segmen sejak titik koma terakhir — kalau diawali "expires=", koma ini
      // ada di dalam nilai Expires, bukan pemisah antar cookie.
      const tail = current.slice(current.lastIndexOf(";") + 1).trim();
      if (!/^expires=/i.test(tail)) {
        parts.push(current.trim());
        current = "";
        i++;
        continue;
      }
    }
    current += ch;
    i++;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Ambil SEMUA header Set-Cookie dari objek Headers, dalam urutan prioritas:
 *   1. headers.getSetCookie()  — API benar (satu string per cookie)
 *   2. headers.raw()["set-cookie"] — undici/Node (array string)
 *   3. headers.get("set-cookie") — string gabungan, di-split aman
 */
export function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };
  if (typeof h.getSetCookie === "function") {
    const list = h.getSetCookie();
    if (Array.isArray(list)) return list;
  }
  if (typeof h.raw === "function") {
    try {
      const raw = h.raw()["set-cookie"];
      if (Array.isArray(raw) && raw.length > 0) return raw;
    } catch {
      // raw() tidak tersedia — lanjut ke fallback
    }
  }
  const single = headers.get("set-cookie");
  return single ? splitSetCookieString(single) : [];
}

/**
 * Parse satu header Set-Cookie menjadi { name, value, attributes }.
 * Mengembalikan null kalau formatnya bukan "name=value".
 */
export function parseSetCookie(setCookie: string): ParsedSetCookie | null {
  const firstSemi = setCookie.indexOf(";");
  const pair = (firstSemi === -1 ? setCookie : setCookie.slice(0, firstSemi)).trim();
  const eq = pair.indexOf("=");
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  const attributes: SetCookieAttributes = {};
  if (firstSemi !== -1) {
    for (const part of setCookie.slice(firstSemi + 1).split(";")) {
      const attr = part.trim();
      if (!attr) continue;
      const eqIdx = attr.indexOf("=");
      const key = (eqIdx === -1 ? attr : attr.slice(0, eqIdx)).trim().toLowerCase();
      const val = eqIdx === -1 ? "" : attr.slice(eqIdx + 1).trim();
      switch (key) {
        case "expires":
          attributes.expires = val;
          break;
        case "max-age": {
          const n = Number(val);
          attributes.maxAge = Number.isFinite(n) ? n : undefined;
          break;
        }
        case "domain":
          attributes.domain = val;
          break;
        case "path":
          attributes.path = val;
          break;
        case "secure":
          attributes.secure = true;
          break;
        case "httponly":
          attributes.httpOnly = true;
          break;
        case "samesite":
          attributes.sameSite = val;
          break;
        default:
          break;
      }
    }
  }
  return { name, value, attributes };
}

/**
 * Kumpulan cookie (Map name -> value, name terakhir menang). Dipakai untuk
 * seluruh flow yang butuh sesi berkelanjutan.
 */
export class CookieJar {
  private cookies = new Map<string, string>();

  /** Jar kosong. */
  static empty(): CookieJar {
    return new CookieJar();
  }

  /** Set satu cookie (menimpa kalau sudah ada). */
  set(name: string, value: string): this {
    if (name) this.cookies.set(name, value);
    return this;
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }

  /** Nama-nama cookie (AMAN untuk debug — tanpa nilai). */
  names(): string[] {
    return Array.from(this.cookies.keys());
  }

  size(): number {
    return this.cookies.size;
  }

  /** Merge hasil parseSetCookie. */
  mergeParsed(parsed: ParsedSetCookie[]): this {
    for (const c of parsed) {
      this.cookies.set(c.name, c.value);
    }
    return this;
  }

  /** Merge SEMUA Set-Cookie dari objek Headers. */
  mergeHeaders(headers: Headers): this {
    for (const raw of getSetCookies(headers)) {
      const parsed = parseSetCookie(raw);
      if (parsed) this.cookies.set(parsed.name, parsed.value);
    }
    return this;
  }

  /** Merge SEMUA Set-Cookie dari respons — panggil setelah tiap request. */
  mergeResponse(response: Response): this {
    return this.mergeHeaders(response.headers);
  }

  /** Header `Cookie: a=1; b=2` untuk request berikutnya ("" kalau kosong). */
  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

/**
 * fetch + jar sekaligus: header Cookie diambil dari jar, lalu SEMUA
 * Set-Cookie dari respons di-merge balik ke jar. Redirect TIDAK diikuti
 * otomatis (redirect:"manual") supaya tidak ada Set-Cookie yang hilang di
 * tengah rantai — kalau request bisa redirect, pakai followRedirectsWithJar.
 */
export async function fetchWithJar(
  jar: CookieJar,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = jar.header();
  if (cookie && !headers.has("cookie")) {
    headers.set("Cookie", cookie);
  }
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  jar.mergeResponse(res);
  return res;
}

export type RedirectHop = {
  hop: number;
  status: number;
  location: string | null;
};

export type FollowResult = {
  response: Response;
  finalUrl: string;
  hops: RedirectHop[];
};

/**
 * Ikuti rantai redirect SECARA MANUAL (redirect:"manual" + baca Location
 * sendiri), sambil merge Set-Cookie dari SETIAP hop ke jar. Ini penting untuk
 * magic-link / auth callback: browser menyimpan cookie di tiap lompatan, dan
 * fetch bawaan tidak melakukannya.
 */
export async function followRedirectsWithJar(
  jar: CookieJar,
  url: string,
  init: RequestInit = {},
  maxHops = 6,
): Promise<FollowResult> {
  const REDIRECT_STATUS = [301, 302, 303, 307, 308];

  const doFetch = async (target: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = jar.header();
    if (cookie && !headers.has("cookie")) {
      headers.set("Cookie", cookie);
    }
    const res = await fetch(target, { ...init, headers, redirect: "manual" });
    jar.mergeResponse(res);
    return res;
  };

  const hops: RedirectHop[] = [];
  let current = url;

  for (let hop = 0; hop < maxHops; hop++) {
    const res = await doFetch(current);
    const location = res.headers.get("location");
    hops.push({ hop, status: res.status, location });
    if (!location || !REDIRECT_STATUS.includes(res.status)) {
      return { response: res, finalUrl: current, hops };
    }
    current = new URL(location, current).toString();
  }

  // Hop habis: fetch terakhir pada URL terakhir.
  const res = await doFetch(current);
  hops.push({
    hop: maxHops,
    status: res.status,
    location: res.headers.get("location"),
  });
  return { response: res, finalUrl: current, hops };
}
