import { CFG, baseUrl } from './config.js';
import * as store from './store.js';
import * as r34 from './rule34.js';
import * as tg from './telegram.js';
import { classifyTagsAI } from './gemini.js';
import { fetchBuffer, sleep } from './http.js';

// ---------- ابزارهای کوچک ----------
export function hashtag(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[()]/g, '') // پرانتز در هشتگ تلگرامی معتبر نیست
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function postLink(id) {
  return `https://rule34.xxx/index.php?page=post&s=view&id=${id}`;
}

// ---------- تایم mp4 از باکس mvhd (بدون ffmpeg) ----------
export function parseMp4Duration(buf) {
  try {
    const idx = buf.indexOf(Buffer.from('mvhd'));
    if (idx < 0) return 0;
    const base = idx + 4; // بعد از 'mvhd'
    const version = buf[base];
    let timescale, duration;
    if (version === 1) {
      timescale = buf.readUInt32BE(base + 20);
      duration = Number(buf.readBigUInt64BE(base + 24));
    } else {
      timescale = buf.readUInt32BE(base + 12);
      duration = buf.readUInt32BE(base + 16);
    }
    if (!timescale) return 0;
    return duration / timescale;
  } catch {
    return 0;
  }
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + 'MB';
  return Math.round(bytes / 1024) + 'KB';
}

// ---------- دسته‌بندی تگ‌ها: کش → AI → API سایت → قاعده پرانتز → general ----------
async function classifyAll(tags) {
  const names = String(tags || '').split(/\s+/).filter(Boolean).slice(0, 40);
  if (!names.length) return { artists: [], copyrights: [], characters: [], general: [] };

  const out = { artists: [], copyrights: [], characters: [], general: [] };
  const unknown = [];
  for (const n of names) {
    try {
      const c = await store.redis('GET', CFG.KEYS.cap + n);
      if (c) {
        (out[c] || out.general).push(n);
        continue;
      }
    } catch {
      /* ignore */
    }
    unknown.push(n);
  }

  if (unknown.length) {
    // ۱) لایه AI
    const ai = await classifyTagsAI(unknown);
    const sets = {
      artists: new Set(ai?.artists || []),
      copyrights: new Set(ai?.copyrights || []),
      characters: new Set(ai?.characters || []),
    };
    // ۲) لایه API سایت (برای تگ‌هایی که AI نتوانست)
    const missed = unknown.filter((n) => !sets.artists.has(n) && !sets.copyrights.has(n) && !sets.characters.has(n));
    let infos = {};
    if (missed.length) {
      infos = await r34.getTagInfos(missed);
    }
    const remain = [];
    for (const n of unknown) {
      let cat = sets.artists.has(n) ? 'artists' : sets.copyrights.has(n) ? 'copyrights' : sets.characters.has(n) ? 'characters' : null;
      if (!cat) cat = r34.classifyByType(infos[n] || null);
      if (!cat) cat = guessByParenCache(n, infos);
      if (!cat) {
        remain.push(n);
        continue;
      }
      out[cat].push(n);
      store.redis('SET', CFG.KEYS.cap + n, cat, 'EX', 30 * 86400).catch(() => {});
    }
    // ۳) قاعده پرانتز → character، بقیه general
    for (const n of remain) {
      const cat = /\(/.test(n) ? 'characters' : 'general';
      out[cat].push(n);
      store.redis('SET', CFG.KEYS.cap + n, cat, 'EX', 30 * 86400).catch(() => {});
    }
  }
  return out;
}

function guessByParenCache(n, infos) {
  // «kasumi (dead_or_alive)» و مشابهش معمولاً شخصیت است
  return /\(/.test(n) ? 'characters' : null;
}

// ---------- ساخت کپشن (۴ حالت) ----------
export async function buildCaption(item, sizeBytes, kind, cfg) {
  const mode = Number(cfg?.captionMode ?? 1);
  if (mode === 4) return '';

  const searchTags = (item?.searchTags || []).map(hashtag).filter(Boolean);
  const artists = (item?.artists || []).map(hashtag).filter(Boolean);
  const lines = [];
  const videoDur = kind === 'video' && item?.duration ? `\n⏱ ${fmtDuration(item.duration)}` : '';
  const linkLine = cfg?.includeLink && item?.id ? `\n🔗 ${postLink(item.id)}` : '';

  if (mode === 1) {
    const cls = await classifyAll(item?.tags || '');
    const ht = (arr) => arr.map((t) => '#' + hashtag(t)).join(' ');
    const caps = (arr, prefix) => (arr.length ? `${prefix} ${ht(arr)}` : '');
    lines.push(
      [
        cls.artists.length ? `🎨 ${ht(cls.artists)}` : '',
        caps(cls.copyrights, '©️'),
        caps(cls.characters, '👤'),
        cls.general.length ? `#️⃣ ${ht(cls.general)}` : '',
        `⭐ ${item?.score ?? 0}  📦 ${fmtSize(sizeBytes)}  🆔 ${item?.id ?? '?'}`,
      ]
        .filter(Boolean)
        .join('\n'),
      linkLine,
      videoDur
    );
    return lines.join('').replace(/\n{3,}/g, '\n\n').trim();
  }

  // حالت ۲: تگ‌های جستجو + آرتیست + حجم/آیدی + لینک + تایم ویدیو
  if (mode === 2) {
    const tags = [...new Set([...searchTags, ...artists])].map((t) => '#' + t).join(' ');
    lines.push(tags || `#${hashtag(item?.id || '')}`);
    lines.push(`📦 ${fmtSize(sizeBytes)}  🆔 ${item?.id ?? '?'}`);
    lines.push(linkLine, videoDur);
    return lines.join('').replace(/\n{3,}/g, '\n\n').trim();
  }

  // حالت ۳: فقط تگ‌های جستجو + آرتیست
  const tags = [...new Set([...searchTags, ...artists])].map((t) => '#' + t).join(' ');
  return tags;
}

// ---------- افزودن به صف ----------
export async function queueJob(intent, chatId) {
  const tags = (intent.tags || []).join(' ');
  const count = Math.min(intent.count || CFG.maxPostsPerRun, 50);
  const media = intent.media || 'any';
  const sort = intent.sort || 'default';
  const minScore = Math.max(0, parseInt(intent.min_score || '0', 10) || 0);

  let posts = await r34.searchPosts({ tags, limit: 60, sort, minScore });
  if (sort === 'random') posts = posts.sort(() => Math.random() - 0.5);
  if (media !== 'any') {
    const want = { image: ['photo'], video: ['video'], animation: ['gif'] }[media];
    posts = posts.filter((p) => want.includes(r34.mediaType(p)));
  }
  // حذف ارسال‌شده‌ها
  const fresh = [];
  for (const p of posts) {
    if (fresh.length >= count) break;
    if (!(await store.isSent(p.id))) fresh.push(p);
  }
  if (!fresh.length) return { enqueued: 0, total: posts.length };

  const items = fresh.map((p) => ({
    id: p.id,
    fileUrl: p.file_url,
    previewUrl: p.preview_url || '',
    kind: r34.mediaType(p),
    score: p.score,
    tags: String(p.tags || ''),
    searchTags: intent.tags || [],
    sizeBytes: parseInt(p.file_size || '0', 10) || 0,
    attempts: 0,
  }));
  await store.queuePush(items);
  return { enqueued: items.length, total: posts.length };
}

// ---------- پردازش یک آیتم ----------
async function processItem(item, cfg) {
  const buf = await r34.downloadMedia(item.fileUrl);
  if (!buf || !buf.length) throw new Error('EMPTY_DOWNLOAD');

  if (buf.length > CFG.maxBytes) return { ok: false, code: 'TOO_LARGE', desc: `حجم ${fmtSize(buf.length)} از سقف تلگرام بیشتر است` };

  const caption = await buildCaption(item, buf.length, item.kind, cfg);
  const chatId = cfg.destination;

  if (item.kind === 'photo' && !CFG.photoAsDocument && buf.length <= CFG.photoMaxBytes) {
    const r = await tg.sendBuffer(chatId, 'sendPhoto', buf, `r34_${item.id}.jpg`, caption, {}, null);
    if (r.ok) return { ok: true };
    // اگر sendPhoto به هر دلیلی رد شد، با فایل امتحان کن
    const r2 = await tg.sendBuffer(chatId, 'sendDocument', buf, `r34_${item.id}.jpg`, caption, {}, null);
    if (r2.ok) return { ok: true };
    return { ok: false, code: errCode(r2), desc: r2.description };
  }

  if (item.kind === 'photo') {
    const r = await tg.sendBuffer(chatId, 'sendDocument', buf, `r34_${item.id}.jpg`, caption, {}, null);
    if (r.ok) return { ok: true };
    return { ok: false, code: errCode(r), desc: r.description };
  }

  if (item.kind === 'gif') {
    const r = await tg.sendBuffer(chatId, 'sendAnimation', buf, `r34_${item.id}.gif`, caption, {}, null);
    if (r.ok) return { ok: true };
    const r2 = await tg.sendBuffer(chatId, 'sendDocument', buf, `r34_${item.id}.gif`, caption, {}, null);
    if (r2.ok) return { ok: true };
    return { ok: false, code: errCode(r2), desc: r2.description };
  }

  if (item.kind === 'video' && buf.length <= CFG.maxBytes) {
    const duration = parseMp4Duration(buf) || undefined;
    let thumbBuf = null;
    if (item.previewUrl) {
      thumbBuf = await fetchBuffer(item.previewUrl.replace(/\.mp4$/, '.jpg').replace(/\.webm$/, '.jpg'), 15000).catch(() => null);
      if (thumbBuf && thumbBuf.length > 200 * 1024) thumbBuf = null;
    }
    const r = await tg.sendBuffer(chatId, 'sendVideo', buf, `r34_${item.id}.mp4`, caption, { duration }, thumbBuf);
    if (r.ok) return { ok: true };
    const r2 = await tg.sendBuffer(chatId, 'sendDocument', buf, `r34_${item.id}.mp4`, caption, {}, null);
    if (r2.ok) return { ok: true };
    return { ok: false, code: errCode(r2), desc: r2.description };
  }

  // هر چیز دیگری → فایل
  const ext = (item.fileUrl.split('?')[0].split('.').pop() || 'bin').slice(0, 5);
  const r = await tg.sendBuffer(chatId, 'sendDocument', buf, `r34_${item.id}.${ext}`, caption, {}, null);
  if (r.ok) return { ok: true };
  return { ok: false, code: errCode(r), desc: r.description };
}

function errCode(res) {
  const d = String(res?.description || '');
  if (res?.error_code === 403 || /chat not found|bot was blocked|kicked|upgraded/i.test(d)) return 'CHAT_BROKEN';
  if (res?.error_code === 413 || /too large|media empty|invalid file/i.test(d)) return 'PERMANENT';
  return 'RETRY';
}

async function notify(text, once = false) {
  if (!CFG.adminId) return;
  if (once && !(await store.noticeOnce(String(text).slice(0, 40)))) return;
  await tg.api('sendMessage', { chat_id: CFG.adminId, text, parse_mode: 'HTML' });
}

// ---------- مدیریت خطای آیتم ----------
async function handleFailure(item, code, desc, cfg) {
  if (code === 'CHAT_BROKEN') {
    await store.queueClear();
    await store.clearResumeAt();
    await notify(`⚠️ <b>ارسال متوقف شد — مقصد در دسترس نیست.</b>\n<code>${esc(desc).slice(0, 200)}</code>\nصف پاک شد. مقصد را با /dest دوباره تنظیم کنید.`);
    return 'clear';
  }
  if (code === 'PERMANENT' || item.attempts >= 2) {
    await store.markSent(item.id); // دیگر تلاش نکن
    await notify(`🗑 پست <code>${item.id}</code> کنار گذاشته شد: <code>${esc(desc).slice(0, 160)}</code>`, true);
    return 'drop';
  }
  // قابل تلاش مجدد: به انتهای صف برگرد
  item.attempts += 1;
  await store.queuePush([item]);
  await notify(`↩️ پست <code>${item.id}</code> موقتاً نشد (${esc(desc).slice(0, 120)}) — دوباره در صف.`, true);
  return 'retry';
}

// ---------- اجرای صف ----------
export async function runQueue(chain = 0, reason = '') {
  if (!CFG.botToken || !CFG.redisUrl) return { skipped: 'no-env' };

  const cfg = await store.getCfg();
  if (!cfg.destination) return { skipped: 'no-destination' };

  if (await store.popCancel()) {
    await store.queueClear();
    await store.clearResumeAt();
    await notify('✅ صف و ادامه خودکار لغو شد.');
    return { cancelled: true };
  }

  if (!(await store.getLock())) return { skipped: 'lock' };
  try {
    const start = Date.now();
    let sent = 0;
    let lastItem = null;

    while (Date.now() - start < CFG.timeBudgetMs) {
      if (await store.popCancel()) {
        await store.queueClear();
        await store.clearResumeAt();
        await notify('✅ صف و ادامه خودکار لغو شد.');
        return { cancelled: true };
      }
      const raw = await store.queuePop();
      if (!raw) break;
      let item;
      try {
        item = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        await notify(`🗑 آیتم مسموم از صف کنار گذاشته شد.`, true);
        continue;
      }
      if (!item || !item.id || !item.fileUrl) continue;
      if (await store.isSent(item.id)) continue;
      lastItem = item;

      try {
        const res = await processItem(item, cfg);
        if (res.ok) {
          await store.markSent(item.id);
          sent++;
          continue;
        }
        const act = await handleFailure(item, res.code, res.desc, cfg);
        if (act === 'clear') return { cleared: true };
        if (act === 'retry') break; // در این اجرا ادامه نده
      } catch (e) {
        const msg = String(e?.message || e);
        const code = msg.includes('TOO_LARGE') || msg.includes('HTTP 413') ? 'PERMANENT' : msg === 'EMPTY_DOWNLOAD' ? 'PERMANENT' : 'RETRY';
        const act = await handleFailure(item, code, msg, cfg);
        if (act === 'clear') return { cleared: true };
        if (act === 'retry') break;
      }
      await sleep(300); // مکث کوتاه بین ارسال‌ها (ضد فلود)
    }

    const remaining = await store.queueLen();

    if (sent > 0 || (remaining === 0 && lastItem)) {
      // گزارش فقط وقتی کاری انجام شد
    }
    if (sent > 0 && remaining > 0) await notify(`📤 ${sent} پست ارسال شد؛ ${remaining} پست در صف مانده.`, true);
    if (sent > 0 && remaining === 0) await notify(`✅ ${sent} پست ارسال شد و صف تمام شد.`);

    // ---------- ادامه: زنجیره یا استراحت و ادامه خودکار ----------
    if (remaining > 0 && chain < CFG.chainLimit) {
      const url = baseUrl();
      if (url) {
        fetch(`${url}/api/cron?key=${encodeURIComponent(CFG.cronSecret)}&chain=${chain + 1}`, {
          headers: { 'x-cron-key': CFG.cronSecret },
        }).catch(() => {});
      }
      return { sent, remaining, chained: true };
    }

    if (remaining > 0 && cfg.autoResume !== false) {
      const resumeAt = Date.now() + CFG.autoResumeDelayMs;
      await store.setResumeAt(resumeAt);
      const url = baseUrl();
      if (url) {
        fetch(`${url}/api/cron?key=${encodeURIComponent(CFG.cronSecret)}&wait=1&chain=0`, {
          headers: { 'x-cron-key': CFG.cronSecret },
        }).catch(() => {});
      }
      await notify(`⏳ ${remaining} پست در صف ماند؛ حدود ${Math.round(CFG.autoResumeDelayMs / 60000)} دقیقه بعد خودکار ادامه می‌دهم.`, true);
      return { sent, remaining, resumeAt };
    }

    return { sent, remaining };
  } finally {
    await store.releaseLock();
  }
}

// ---------- تیک انتظار ادامه خودکار (هاپ‌های ۴۰ ثانیه‌ای) ----------
export async function autoResumeTick(chain = 0) {
  if (!CFG.botToken || !CFG.redisUrl) return { skipped: 'no-env' };
  const resumeAt = await store.getResumeAt();
  if (!resumeAt) return { idle: true };

  const cfg = await store.getCfg();
  if (cfg.autoResume === false) {
    await store.clearResumeAt();
    return { disabled: true };
  }

  const remaining = await store.queueLen();
  if (remaining === 0) {
    await store.clearResumeAt();
    return { idle: true };
  }

  if (Date.now() >= resumeAt) {
    await store.clearResumeAt();
    const url = baseUrl();
    if (url) {
      fetch(`${url}/api/cron?key=${encodeURIComponent(CFG.cronSecret)}&chain=0`, {
        headers: { 'x-cron-key': CFG.cronSecret },
      }).catch(() => {});
    }
    return { resumed: true };
  }

  // هنوز زمان نرسیده: تا سقف ~۵۰ ثانیه در همین فراخوانی انتظار بکش
  const start = Date.now();
  while (Date.now() - start < 50000) {
    await sleep(5000);
    if (Date.now() >= resumeAt) break;
  }
  if (Date.now() >= resumeAt) {
    await store.clearResumeAt();
    const url = baseUrl();
    if (url) {
      fetch(`${url}/api/cron?key=${encodeURIComponent(CFG.cronSecret)}&chain=0`, {
        headers: { 'x-cron-key': CFG.cronSecret },
      }).catch(() => {});
    }
    return { resumed: true };
  }

  // هاپ بعدی
  if (chain < CFG.chainLimit) {
    const url = baseUrl();
    if (url) {
      fetch(`${url}/api/cron?key=${encodeURIComponent(CFG.cronSecret)}&wait=1&chain=${chain + 1}`, {
        headers: { 'x-cron-key': CFG.cronSecret },
      }).catch(() => {});
    }
  }
  return { waiting: true, resumeAt };
}
