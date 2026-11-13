import { CFG } from './config.js';
import { fetchT, fetchJson, fetchBuffer, sleep } from './http.js';
import * as store from './store.js';

const DAPI = 'https://api.rule34.xxx/index.php?page=dapi&s=post&q=index';

// ---------- جستجوی پست‌ها (JSON) ----------
export async function searchPosts({ tags = '', limit = 20, pid = 0, sort = 'default', minScore = 0 } = {}) {
  let t = (tags || '').trim().replace(/\s+/g, ' ');
  if (sort === 'score') t = (t ? t + ' ' : '') + 'sort:score';
  if (minScore > 0) t = (t ? t + ' ' : '') + `score:>=${minScore}`;
  const url = `${DAPI}&json=1&limit=${Math.min(Math.max(limit, 1), 1000)}&pid=${Math.max(pid, 0)}${t ? `&tags=${encodeURIComponent(t)}` : ''}`;
  const r = await fetchT(url, {}, 20000);
  if (!r.ok) throw new Error(`rule34 HTTP ${r.status}`);
  const text = await r.text();
  let posts;
  try {
    posts = JSON.parse(text);
  } catch {
    posts = []; // خالی: هیچ پستی با این تگ‌ها نبود
  }
  return Array.isArray(posts) ? posts : [];
}

// ---------- پیشنهاد تگ (endpoint سایت — JSON یا XML) ----------
export async function suggestTags(q) {
  const base = 'https://api.rule34.xxx/autocomplete.php';
  for (const key of ['q', 'search']) {
    try {
      const r = await fetchT(`${base}?${key}=${encodeURIComponent(q)}&limit=10`, {}, 10000);
      if (!r.ok) continue;
      const arr = JSON.parse(await r.text());
      if (Array.isArray(arr)) return arr.map((x) => (typeof x === 'string' ? x : x.value || x.label)).filter(Boolean);
    } catch {
      /* try next */
    }
  }
  return [];
}

// ---------- پارس تگ‌ها: JSON یا XML (پاسخ تگ سایت XML است) ----------
export function parseAnyTags(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  // ۱) تلاش JSON
  try {
    const j = JSON.parse(trimmed);
    if (Array.isArray(j)) return j;
  } catch {
    /* XML */
  }
  // ۲) پارس XML با regex attribute (بدون وابستگی)
  const out = [];
  const re = /<tag\b([^>]*?)\/?>(?:[^<]*<\/tag>)?/g;
  let m;
  while ((m = re.exec(trimmed))) {
    const attrs = {};
    const ar = /([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]*)"/g;
    let a;
    while ((a = ar.exec(m[1]))) attrs[a[1]] = a[2];
    if (attrs.name) out.push(attrs);
  }
  return out;
}

// ---------- اطلاعات یک تگ با کش (کش ۳۰ روز؛ miss فقط ۱۰ دقیقه) ----------
export async function fetchTagInfoOne(name) {
  const key = `r34:tag:v2:${String(name).toLowerCase()}`;
  try {
    const cached = await store.redis('GET', key);
    if (cached !== null && cached !== undefined) {
      return cached === 'MISS' ? null : JSON.parse(cached);
    }
  } catch {
    /* کش خراب؟ ادامه به API */
  }
  let info = null;
  try {
    const url = `https://api.rule34.xxx/index.php?page=dapi&s=tag&q=index&names=${encodeURIComponent(name)}`;
    const r = await fetchT(url, {}, 15000);
    if (r.ok) {
      const arr = parseAnyTags(await r.text());
      if (arr.length) {
        const t = arr[0];
        info = {
          name: t.name,
          type: t.type,
          postCount: parseInt(t.post_count || t.count || '0', 10) || 0,
        };
      }
    }
  } catch {
    /* info null می‌ماند */
  }
  try {
    await store.redis('SET', key, info ? JSON.stringify(info) : 'MISS', 'EX', info ? 30 * 86400 : 600);
  } catch {
    /* ignore */
  }
  return info;
}

// ---------- اطلاعات گروهی تگ‌ها (چانک ۸تایی برای جلوگیری از URL طولانی) ----------
export async function getTagInfos(names = []) {
  const uniq = [...new Set(names.filter(Boolean).map((n) => String(n).toLowerCase()))].slice(0, 40);
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 8) chunks.push(uniq.slice(i, i + 8));
  const results = {};
  for (const chunk of chunks) {
    const key = 'r34:tags:v2:' + chunk.join('|');
    try {
      const cached = await store.redis('GET', key);
      if (cached) {
        Object.assign(results, JSON.parse(cached));
        continue;
      }
    } catch {
      /* ignore */
    }
    const url = `https://api.rule34.xxx/index.php?page=dapi&s=tag&q=index&names=${encodeURIComponent(chunk.join(' '))}`;
    try {
      const r = await fetchT(url, {}, 15000);
      if (r.ok) {
        const arr = parseAnyTags(await r.text());
        const map = {};
        for (const t of arr) {
          const n = String(t.name || '').toLowerCase();
          if (!n) continue;
          map[n] = { name: t.name, type: t.type, postCount: parseInt(t.post_count || t.count || '0', 10) || 0 };
        }
        for (const n of chunk) if (!map[n]) map[n] = null; // فقط برای کش گروهی
        Object.assign(results, map);
        await store.redis('SET', key, JSON.stringify(map), 'EX', 7 * 86400).catch(() => {});
      }
    } catch {
      /* ادامه */
    }
    await sleep(150);
  }
  return results;
}

// ---------- دسته‌بندی تگ‌ها از روی type (قاعده‌ای؛ لایه دوم بعد از AI) ----------
export function classifyByType(info) {
  if (!info) return null;
  const t = String(info.type ?? '').toLowerCase();
  if (t === '1' || t === 'artist' || t === 'general artist') return 'artist';
  if (t === '3' || t === 'copyright') return 'copyright';
  if (t === '4' || t === 'character') return 'character';
  if (t === '0' || t === 'general' || t === '2' || t === 'system') return 'general';
  return null;
}

// قاعده پرانتز: در rule34 هر تگ حاوی «(…)» معمولاً شخصیت/فرنچایز است
function guessByParen(name) {
  return /\(/.test(name) ? 'character' : null;
}

export const mediaType = (post) => {
  const u = String(post?.file_url || post?.preview_url || '').toLowerCase();
  const ext = u.split('?')[0].split('.').pop();
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'photo';
  if (ext === 'gif') return 'gif';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  return 'other';
};

export const downloadMedia = (url) => fetchBuffer(url, 45000);

// ابزار دیباگ: خام XML تگ را برمی‌گرداند تا فرمت پاسخ سایت مشخص شود
export async function debugTagProbe(name = 'kasumi') {
  const url = `https://api.rule34.xxx/index.php?page=dapi&s=tag&q=index&names=${encodeURIComponent(name)}`;
  const r = await fetchT(url, {}, 15000);
  const text = await r.text();
  return { status: r.status, contentType: r.headers.get('content-type') || '', sample: text.slice(0, 600), parsed: parseAnyTags(text) };
}
