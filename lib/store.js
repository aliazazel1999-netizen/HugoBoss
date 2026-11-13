import { CFG } from './config.js';
import { fetchT } from './http.js';

async function rest(commands) {
  const r = await fetchT(CFG.redisUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CFG.redisToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  }, 15000);
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
  const j = await r.json();
  if (commands.length === 1) return j[0]?.result;
  return j.map((x) => x?.result);
}

export const redis = (...args) => rest([args]);

export const queuePush = (items) =>
  rest(items.map((i) => ['RPUSH', CFG.KEYS.queue, JSON.stringify(i)]));

export const queueLen = () => redis('LLEN', CFG.KEYS.queue);

export const queuePop = () => redis('LPOP', CFG.KEYS.queue);

export const queueClear = () => redis('DEL', CFG.KEYS.queue);

export const queuePeekAll = (n = 5) => redis('LRANGE', CFG.KEYS.queue, '0', String(n - 1));

export const markSent = (id) => redis('SADD', CFG.KEYS.sent, String(id));

export const isSent = async (id) => (await redis('SISMEMBER', CFG.KEYS.sent, String(id))) === 1;

export const sentCount = () => redis('SCARD', CFG.KEYS.sent);

export async function getCfg() {
  try {
    const raw = await redis('GET', CFG.KEYS.cfg);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function setCfg(patch) {
  const cur = await getCfg();
  const merged = { ...cur, ...patch };
  await redis('SET', CFG.KEYS.cfg, JSON.stringify(merged));
  return merged;
}

export async function getLock() {
  return (await redis('SET', CFG.KEYS.lock, '1', 'NX', 'EX', '300')) === 'OK';
}

export const releaseLock = () => redis('DEL', CFG.KEYS.lock);

// اعلان‌های تکراری نباید هر بار اسپم شوند؛ هر اعلان ۱۵ دقیقه یک‌بار
export async function noticeOnce(key) {
  const k = CFG.KEYS.notice + ':' + key;
  const ok = (await redis('SET', k, '1', 'NX', 'EX', '900')) === 'OK';
  return ok;
}

export async function appendErr(line) {
  try {
    await redis('RPUSH', CFG.KEYS.errs, `[${new Date().toISOString()}] ${line}`);
    await redis('LTRIM', CFG.KEYS.errs, '-50', '-1');
  } catch {
    /* ignore */
  }
}

export const getErrs = (n = 20) => redis('LRANGE', CFG.KEYS.errs, `-${n}`, '-1');

export const setResumeAt = (ms) => redis('SET', CFG.KEYS.resume, String(Math.floor(ms)));

export const getResumeAt = async () => {
  const v = await redis('GET', CFG.KEYS.resume);
  const n = parseInt(v || '0', 10);
  return Number.isFinite(n) ? n : 0;
};

export const clearResumeAt = () => redis('DEL', CFG.KEYS.resume);

export const setCancel = () => redis('SET', CFG.KEYS.cancel, '1', 'EX', '600');

export async function popCancel() {
  try {
    return (await redis('GETDEL', CFG.KEYS.cancel)) === '1';
  } catch {
    // Redis قدیمی بدون GETDEL
    const v = await redis('GET', CFG.KEYS.cancel);
    await redis('DEL', CFG.KEYS.cancel);
    return v === '1';
  }
}
