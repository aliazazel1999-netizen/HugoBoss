import { CFG } from './config.js';
import { fetchT, sleep } from './http.js';

const API = () => `https://api.telegram.org/bot${CFG.botToken}`;

export async function api(method, params = {}, attempt = 1) {
  try {
    const r = await fetchT(`${API()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }, 30000);
    const j = await r.json().catch(() => ({ ok: false, error_code: r.status, description: `HTTP ${r.status}` }));
    // 429: احترام به retry_after و یک بار تلاش مجدد
    if (j.error_code === 429 && attempt < 3) {
      const wait = Math.min((j.parameters?.retry_after || 2) * 1000, 8000);
      await sleep(wait);
      return api(method, params, attempt + 1);
    }
    return j;
  } catch (e) {
    if (attempt < 3 && (e.name === 'AbortError' || /fetch|network/i.test(String(e.message)))) {
      await sleep(1500);
      return api(method, params, attempt + 1);
    }
    return { ok: false, description: String(e?.message || e) };
  }
}

/**
 * ارسال بافر (فایل/عکس/ویدیو) با multipart
 * thumbBuf: تامبنیل ویدیو (append به عنوان 'thumbnail')
 */
export async function sendBuffer(chatId, method, buffer, filename, caption, extra = {}, thumbBuf = null, attempt = 1) {
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) {
      fd.append('caption', caption);
      fd.append('parse_mode', 'HTML');
    }
    for (const [k, v] of Object.entries(extra || {})) {
      if (v === undefined || v === null) continue;
      fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    fd.append(method === 'sendPhoto' ? 'photo' : 'document', new Blob([buffer]), filename);
    if (thumbBuf) fd.append('thumbnail', new Blob([thumbBuf]), 'thumb.jpg');
    const r = await fetchT(`${API()}/${method}`, { method: 'POST', body: fd }, 50000);
    const j = await r.json().catch(() => ({ ok: false, error_code: r.status, description: `HTTP ${r.status}` }));
    if (j.error_code === 429 && attempt < 3) {
      const wait = Math.min((j.parameters?.retry_after || 2) * 1000, 8000);
      await sleep(wait);
      return sendBuffer(chatId, method, buffer, filename, caption, extra, thumbBuf, attempt + 1);
    }
    return j;
  } catch (e) {
    if (attempt < 2 && /fetch|network|abort/i.test(String(e?.message || ''))) {
      return sendBuffer(chatId, method, buffer, filename, caption, extra, thumbBuf, attempt + 1);
    }
    return { ok: false, description: String(e?.message || e) };
  }
}
