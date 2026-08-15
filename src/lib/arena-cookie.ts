/**
 * Helper cookie arena.ai.
 *
 * Aturan penting: cookie yang ditempel user harus LENGKAP — seluruh hasil
 * `document.cookie` (arena-auth-prod-v1.0, arena-auth-prod-v1.1, arena_visit_id,
 * user_country_code, _ga, dst.), persis seperti output bookmarklet
 * "ARENA AUTH COOKIES" / "[ALL COOKIES]". Jangan cuma 2 cookie auth.
 */

/** Cookie auth wajib ada di string yang lengkap. */
export const REQUIRED_AUTH_COOKIES = [
  "arena-auth-prod-v1.0",
  "arena-auth-prod-v1.1",
] as const;

/** Contoh format cookie LENGKAP (semua cookie dari document.cookie). */
export const SAMPLE_COOKIE = `_dd_s=aid=a96f4309-81a4-4a94-95fb-0f3f3d002216&rum=2&id=2e9aaf04-9b5b-41d5-8f5f-19b5d4e4a379; arena_visit_id=%7B%22id%22%3A%2201a0063a-651f-77fd-95df-f740280fa8ff%22%7D; arena-auth-prod-v1.0=base64-eyJHy2Nlc3NfdG9kG9rZW4wIjIuUp0YkdjaU9pSkZVekkxTmljOltdHBBaQ0I; arena-auth-prod-v1.1=mh0dHBz0i8vbGgzLmdvb2dsZdsZXVVzXXJjbjJb250ZW5W50LmNvbnVbS9hL0FDZzZl; user_country_code=ID; _ga=GA1.1.1489341618.1784909184; _ga_DB32ZN1WHB=GS2.1.s1786810885`;

/** Ubah string cookie ("a=1; b=2") jadi object {a: "1", b: "2"}. */
export function parseCookieString(cookie: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) result[name] = value;
  }
  return result;
}

/** Ambil nilai cookie tertentu (case-insensitive). */
export function getCookieValue(
  cookie: string,
  name: string,
): string | undefined {
  const parsed = parseCookieString(cookie);
  const key = Object.keys(parsed).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  return key ? parsed[key] : undefined;
}

/** Nama-nama cookie yang terdeteksi di string yang ditempel. */
export function detectedCookieNames(cookie: string): string[] {
  return Object.keys(parseCookieString(cookie));
}

/** Cookie auth wajib yang TIDAK ada di string. */
export function missingAuthCookies(cookie: string): string[] {
  return REQUIRED_AUTH_COOKIES.filter(
    (name) => !getCookieValue(cookie, name),
  );
}

/** true kalau kedua cookie auth ada (syarat minimum "cookie lengkap"). */
export function isArenaCookieComplete(cookie: string): boolean {
  return missingAuthCookies(cookie).length === 0;
}

/**
 * Bookmarklet ala "ARENA AUTH COOKIES": tampilkan overlay (header abu-abu +
 * konten terminal hijau) yang memajang kedua cookie auth, lalu menyalin
 * SELURUH document.cookie ke clipboard. Cara pakai: buat bookmark baru di
 * browser → tempel URL ini sebagai alamatnya → buka arena.ai/agent → klik
 * bookmark.
 */
export const ARENA_COOKIE_BOOKMARKLET = `javascript:(()=>{const c=document.cookie;const g=n=>{const m=c.match(new RegExp('(?:^|; )'+n+'=([^;]*)'));return m?m[1]:null};const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');const v10=esc(g('arena-auth-prod-v1.0')||'(tidak ada)');const v11=esc(g('arena-auth-prod-v1.1')||'(tidak ada)');const o=document.createElement('div');o.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace';o.innerHTML='<div style="width:min(92vw,760px);max-height:86vh;display:flex;flex-direction:column;background:#1c1c1e;border:1px solid #3a3a3c;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;background:#2c2c2e;color:#fff;font-size:13px;font-weight:600"><span>Arena AI: Auth Cookies</span><span id="acb-close" style="cursor:pointer;background:#3a3a3c;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff" title="Tutup">✕</span></div><div style="padding:14px 16px;background:#000;color:#4ade80;font-size:11px;line-height:1.6;white-space:pre-wrap;overflow:auto">ARENA AUTH COOKIES:\\n\\narena-auth-prod-v1.0='+v10+'\\n\\narena-auth-prod-v1.1='+v11+'\\n\\n[ALL COOKIES]\\n\\n'+esc(c)+'\\n\\n[COPIED - semua cookie ke clipboard]</div></div>';o.addEventListener('click',e=>{if(e.target===o)o.remove()});const x=o.querySelector('#acb-close');if(x)x.addEventListener('click',()=>o.remove());document.body.appendChild(o);const copy=()=>{const t=document.createElement('textarea');t.value=c;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove()};navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(c).catch(copy):copy()})()`;
