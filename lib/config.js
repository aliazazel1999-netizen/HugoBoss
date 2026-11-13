export const CFG = {
  botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  adminId: (process.env.ADMIN_ID || '').trim(),
  geminiKey: (process.env.GEMINI_API_KEY || '').trim(),
  redisUrl: (process.env.UPSTASH_REDIS_REST_URL || '').trim(),
  redisToken: (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim(),
  cronSecret: (process.env.CRON_SECRET || '').trim(),
  webhookSecret: (process.env.WEBHOOK_SECRET || '').trim(),

  geminiModel: (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim(),

  maxPostsPerRun: parseInt(process.env.MAX_POSTS_PER_RUN || '6', 10) || 6,
  chainLimit: parseInt(process.env.CHAIN_LIMIT || '20', 10) || 20,

  photoAsDocument: process.env.PHOTO_AS_DOCUMENT === 'true',
  photoMaxBytes: (parseFloat(process.env.PHOTO_MAX_MB ?? '2') || 2) * 1024 * 1024,

  autoResumeDefault: process.env.AUTO_RESUME !== 'off',
  autoResumeDelayMs: parseInt(process.env.AUTO_RESUME_DELAY_MS || '300000', 10) || 300000,

  includePostLinkDefault: process.env.INCLUDE_POST_LINK === 'true',

  // سقف ارسال فایل تلگرام: ۵۰ مگابایت (با حاشیه امنیت)
  maxBytes: 49 * 1024 * 1024,
  // بودجه زمانی پردازش هر اجرا (میلی‌ثانیه) — ورسل ۶۰ ثانیه است
  timeBudgetMs: 40000,

  KEYS: {
    queue: 'r34:queue',
    sent: 'r34:sent',
    cfg: 'r34:cfg',
    errs: 'r34:errs',
    lock: 'r34:lock',
    notice: 'r34:notice',
    cap: 'r34:cap',
    resume: 'r34:resume',
    cancel: 'r34:cancel',
  },
};

// آدرس پایه دیپلوی (برای خودفراخوانی زنجیره و ست وب‌هوک)
export function baseUrl() {
  let u = (process.env.VERCEL_URL || process.env.BASE_URL || '').trim();
  if (!u) return '';
  if (!u.startsWith('http')) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}
