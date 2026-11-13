//(endpoint مستقل تشخیصی — بدون هیچ import استاتیک؛ حتی وقتی بقیه کد کرش می‌کند هم جواب می‌دهد)
export const config = { maxDuration: 60 };

const MSG = (e) => (e && e.message ? String(e.message) : String(e));

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.query.key !== process.env.CRON_SECRET) {
    res.status(401).send('unauthorized');
    return;
  }

  const out = { time: new Date().toISOString(), node: process.version };
  const mods = {};

  // ۱) بارگذاری پویا همه ماژول‌ها — هر خطا ضبط می‌شود، کرش نمی‌کند
  const targets = [
    ['lib/config.js', '../lib/config.js'],
    ['lib/http.js', '../lib/http.js'],
    ['lib/store.js', '../lib/store.js'],
    ['lib/rule34.js', '../lib/rule34.js'],
    ['lib/telegram.js', '../lib/telegram.js'],
    ['lib/gemini.js', '../lib/gemini.js'],
    ['lib/queue.js', '../lib/queue.js'],
    ['@vercel/functions', '@vercel/functions'],
  ];
  out.modules = {};
  for (const [name, path] of targets) {
    try {
      mods[name] = await import(path);
      out.modules[name] = 'ok';
    } catch (e) {
      out.modules[name] = 'FAIL: ' + MSG(e);
      mods[name] = null;
    }
  }

  // ۲) تشخیص علت رایج از روی متن خطاها
  const fails = Object.entries(out.modules).filter(([, v]) => v !== 'ok');
  if (fails.length) {
    const joined = fails.map(([n, v]) => `${n}: ${v}`).join(' | ');
    out.fails = joined;
    out.diagnosis = /Cannot find package/i.test(joined)
      ? 'وابستگی پیدا نشد: package.json باید در ریشه ریپو باشد و @vercel/functions داخل dependencies باشد. بعد از اصلاح ری‌دپلوی بگیرید.'
      : /Cannot find module/i.test(joined)
        ? 'فایل یا مسیر پیدا نشد: ساختار پوشه‌ها باید دقیقاً api/ و lib/ با فایل‌های داخلش باشد. آپلود دستی با وب گیت‌هاب معمولاً پوشه‌ها را خراب می‌کند — با git push آپلود کنید.'
        : /Cannot use import statement outside a module/i.test(joined)
          ? 'package.json فاقد "type":"module" است یا اصلاً در ریپو نیست.'
          : /SyntaxError|Unexpected/i.test(joined)
            ? 'خطای سینتکس در یکی از فایل‌ها (مثلاً فایل ناقص یا با پسوند اشتباه).'
            : 'خطای نامشخص — متن out.fails را کپی کنید.';
  } else {
    out.diagnosis = 'همه ماژول‌ها سالم بارگذاری شدند ✅';
  }

  // ۳) متغیرهای محیطی (مستقیم از process.env)
  out.env = {
    TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
    ADMIN_ID: !!process.env.ADMIN_ID,
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    CRON_SECRET: !!process.env.CRON_SECRET,
    WEBHOOK_SECRET: !!process.env.WEBHOOK_SECRET,
    VERCEL_URL: !!process.env.VERCEL_URL,
  };

  // ۴) تست‌های عمیق فقط اگر ماژول مربوطه سالم لود شده باشد
  if (mods['lib/store.js']) {
    try {
      await mods['lib/store.js'].redis('SET', 'r34:doctor:pulse', String(Date.now()), 'EX', 60);
      const v = await mods['lib/store.js'].redis('GET', 'r34:doctor:pulse');
      out.redis = { ok: !!v };
    } catch (e) {
      out.redis = { ok: false, error: MSG(e).slice(0, 200) };
    }
  }

  if (mods['lib/telegram.js']) {
    try {
      const me = await mods['lib/telegram.js'].api('getMe');
      out.bot = me.ok ? { ok: true, username: me.result.username } : { ok: false, error: me.description };
    } catch (e) {
      out.bot = { ok: false, error: MSG(e).slice(0, 200) };
    }
    try {
      const wh = await mods['lib/telegram.js'].api('getWebhookInfo');
      const r = wh.result || {};
      out.webhook = {
        url: r.url || '(خالی!)',
        pending: r.pending_update_count || 0,
        lastError: r.last_error_message ? `${r.last_error_message}` : null,
      };
    } catch (e) {
      out.webhook = { error: MSG(e).slice(0, 200) };
    }
  }

  res.status(200).json(out);
}
