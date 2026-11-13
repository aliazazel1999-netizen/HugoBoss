const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 r34-tg-bot/1.0';

export async function fetchT(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(url, opts = {}, timeoutMs = 20000) {
  const r = await fetchT(url, opts, timeoutMs);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

export async function fetchBuffer(url, timeoutMs = 45000) {
  const r = await fetchT(url, {}, timeoutMs);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
