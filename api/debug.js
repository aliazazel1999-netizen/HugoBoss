import { CFG } from '../lib/config.js';
import * as store from '../lib/store.js';
import * as tg from '../lib/telegram.js';
import * as r34 from '../lib/rule34.js';
import { selfTest, classifyTagsAI } from '../lib/gemini.js';
import { queueLen, getCfg } from '../lib/store.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const key = req.query.key || '';
  if (CFG.cronSecret && key !== CFG.cronSecret) {
    res.status(401).send('unauthorized');
    return;
  }

  const out = {};

  // ۱) متغیرهای محیطی
  out.env = {
    TELEGRAM_BOT_TOKEN: !!CFG.botToken,
    ADMIN_ID: !!CFG.adminId,
    GEMINI_API_KEY: !!CFG.geminiKey,
    UPSTASH_REDIS_REST_URL: !!CFG.redisUrl,
    UPSTASH_REDIS_REST_TOKEN: !!CFG.redisToken,
    CRON_SECRET: !!CFG.cronSecret,
    WEBHOOK_SECRET: !!CFG.webhookSecret,
    VERCEL_URL: !!process.env.VERCEL_URL,
  };

  // ۲) Redis
  try {
    await store.redis('SET', 'r34:debug:pulse', String(Date.now()), 'EX', 60);
    const v = await store.redis('GET', 'r34:debug:pulse');
    out.redis = { ok: !!v };
  } catch (e) {
    out.redis = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }

  // ۳) ربات
  try {
    const me = await tg.api('getMe');
    out.bot = me.ok ? { ok: true, username: me.result.username } : { ok: false, error: me.description };
  } catch (e) {
    out.bot = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }

  // ۴) وب‌هوک
  try {
    const wh = await tg.api('getWebhookInfo');
    const r = wh.result || {};
    out.webhook = {
      url: r.url || '(خالی!)',
      pending: r.pending_update_count || 0,
      lastError: r.last_error_message ? `${r.last_error_message} (${r.last_error_date})` : null,
      hint:
        r.last_error_message && /500/i.test(r.last_error_message)
          ? 'کد کرش استارتاپ دارد؛ لاگ‌های دیپلوی ورسل را ببین (معمولاً import جاافتاده).'
          : r.last_error_message && /401|Unauthorized/i.test(r.last_error_message)
            ? 'WEBHOOK_SECRET مغایرت دارد؛ مقدار env و setup را چک کن.'
            : r.url
              ? 'به نظر سالم است.'
              : 'وب‌هوک ست نشده؛ /api/setup?key=... را صدا بزن.',
    };
  } catch (e) {
    out.webhook = { error: String(e?.message || e).slice(0, 200) };
  }

  // ۵) rule34
  try {
    const posts = await r34.searchPosts({ tags: 'kasumi', limit: 1 });
    out.rule34 = { ok: posts.length > 0, sampleId: posts[0]?.id, type: posts[0] ? r34.mediaType(posts[0]) : null };
  } catch (e) {
    out.rule34 = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
  try {
    const probe = await r34.debugTagProbe('kasumi');
    out.tagProbe = { status: probe.status, contentType: probe.contentType, parsedCount: probe.parsed.length, sample: probe.sample.slice(0, 200) };
  } catch (e) {
    out.tagProbe = { error: String(e?.message || e).slice(0, 200) };
  }

  // ۶) Gemini
  try {
    const st = await selfTest();
    out.gemini = { ok: st.ok, model: st.model, reply: st.text.slice(0, 50) };
  } catch (e) {
    out.gemini = { ok: false, error: String(e?.message || e).slice(0, 300) };
  }

  // ۷) دسته‌بندی تگ با AI
  try {
    const c = await classifyTagsAI(['fellatrix', 'dead_or_alive', 'kasumi_(dead_or_alive)']);
    out.aiClassify = c || { note: 'AI در دسترس نبود؛ لایه API سایت جایگزین می‌شود' };
  } catch (e) {
    out.aiClassify = { error: String(e?.message || e).slice(0, 200) };
  }

  // ۸) صف و پیکربندی
  try {
    out.state = { queueLen: await queueLen(), cfg: await getCfg() };
  } catch (e) {
    out.state = { error: String(e?.message || e).slice(0, 200) };
  }

  res.status(200).json(out);
}
