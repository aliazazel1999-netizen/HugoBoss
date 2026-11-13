import { waitUntil } from '@vercel/functions';
import { CFG } from '../lib/config.js';
import * as store from '../lib/store.js';
import * as tg from '../lib/telegram.js';
import { parseCommand, explainError } from '../lib/gemini.js';
import { queueJob, runQueue } from '../lib/queue.js';

export const config = { maxDuration: 60 };

const HELP = `<b>راهنمای ربات rule34</b>

<b>دستورها</b>
/start — شروع و راهنما
/dest @channel یا -100… — تنظیم مقصد ارسال
/status — وضعیت ربات و صف
/fetch تگ تعداد — مثال: <code>/fetch kasumi 5</code>
/mode 1..4 — قالب کپشن:
   1️⃣ کامل (آرتیست، فرنچایز، شخصیت، تگ‌ها، امتیاز، حجم، آیدی)
   2️⃣ تگ‌های جستجو + آرتیست + حجم/آیدی + لینک + تایم ویدیو
   3️⃣ فقط تگ‌های جستجو + آرتیست
   4️⃣ خالی
/link on|off — نمایش لینک پست در کپشن (فعلاً خاموش)
/auto on|off — ادامه خودکار صف پس از ~۵ دقیقه (فعلاً روشن)
/cancel — لغو صف و ادامه خودکار

<b>زبان طبیعی (با هوش مصنوعی Gemini)</b>
«۵ تا عکس کاسومی با بالاترین امتیاز بفرست»
«مقصد رو بذار @mychannel»
«کپشن رو حالت ۳ کن»
«لینک رو خاموش کن»
«وضعیت چطوره؟»

نکته: اگر پیامی از یک کانال به ربات فوروارد کنید، همان کانال مقصد می‌شود.`;

function sendStatus(cfg, queueLen) {
  const dest = cfg.destination || '<i>تنظیم نشده</i>';
  const mode = Number(cfg.captionMode ?? 1);
  const link = cfg.includeLink ? 'روشن' : 'خاموش';
  const auto = cfg.autoResume === false ? 'خاموش' : 'روشن';
  return [
    '<b>وضعیت ربات</b>',
    `📥 مقصد: <code>${dest}</code>`,
    `🗂 صف: ${queueLen} پست`,
    `✍️ قالب کپشن: ${mode} ${['(کامل)', '(جستجو+آرتیست+لینک)', '(جستجو+آرتیست)', '(خالی)'][mode - 1] || ''}`,
    `🔗 لینک پست: ${link}`,
    `♻️ ادامه خودکار: ${auto}`,
  ].join('\n');
}

async function handle(msg) {
  const chatId = String(msg.chat?.id || '');
  const text = (msg.text || '').trim();
  const fromId = String(msg.from?.id || '');

  // فقط ادمین
  if (CFG.adminId && fromId !== CFG.adminId) {
    await tg.api('sendMessage', { chat_id: chatId, text: '⛔️ فقط ادمین می‌تواند از من استفاده کند.' });
    return;
  }

  // فوروارد از کانال → تنظیم مقصد
  const fwd = msg.forward_from_chat || msg.sender_chat;
  if (fwd && fwd.type === 'channel' && !text.startsWith('/')) {
    const dest = fwd.username ? '@' + fwd.username : String(fwd.id);
    await store.setCfg({ destination: dest });
    await tg.api('sendMessage', { chat_id: chatId, text: `✅ مقصد روی <code>${dest}</code> تنظیم شد.`, parse_mode: 'HTML' });
    return;
  }

  const cfg = await store.getCfg();
  const qLen = await store.queueLen();

  // ---------- دستورهای مستقیم ----------
  if (/^\/start|^\/help/i.test(text)) {
    await tg.api('sendMessage', { chat_id: chatId, text: HELP, parse_mode: 'HTML' });
    return;
  }
  if (/^\/dest/i.test(text)) {
    const d = text.split(/\s+/)[1];
    if (!d) {
      await tg.api('sendMessage', { chat_id: chatId, text: '❓ مثال: <code>/dest @mychannel</code> یا <code>/dest -1001234567890</code>', parse_mode: 'HTML' });
      return;
    }
    const merged = await store.setCfg({ destination: d });
    await tg.api('sendMessage', { chat_id: chatId, text: `✅ مقصد: <code>${d}</code>\n\n${sendStatus(merged, await store.queueLen())}`, parse_mode: 'HTML' });
    return;
  }
  if (/^\/status/i.test(text)) {
    await tg.api('sendMessage', { chat_id: chatId, text: sendStatus(cfg, qLen), parse_mode: 'HTML' });
    return;
  }
  if (/^\/link/i.test(text)) {
    const v = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!/^(on|off)$/i.test(v)) {
      await tg.api('sendMessage', { chat_id: chatId, text: '❓ مثال: <code>/link on</code> یا <code>/link off</code>', parse_mode: 'HTML' });
      return;
    }
    const merged = await store.setCfg({ includeLink: v === 'on' });
    await tg.api('sendMessage', { chat_id: chatId, text: `🔗 لینک پست: ${merged.includeLink ? 'روشن' : 'خاموش'}\n\n${sendStatus(merged, await store.queueLen())}`, parse_mode: 'HTML' });
    return;
  }
  if (/^\/mode/i.test(text)) {
    const m = parseInt(text.split(/\s+/)[1] || '0', 10);
    if (!m || m < 1 || m > 4) {
      await tg.api('sendMessage', { chat_id: chatId, text: '❓ مثال: <code>/mode 2</code> (قالب‌ها: 1 کامل، 2 جستجو+آرتیست+لینک، 3 فقط جستجو+آرتیست، 4 خالی)', parse_mode: 'HTML' });
      return;
    }
    const merged = await store.setCfg({ captionMode: m });
    await tg.api('sendMessage', { chat_id: chatId, text: `✍️ قالب کپشن: ${m}\n\n${sendStatus(merged, await store.queueLen())}`, parse_mode: 'HTML' });
    return;
  }
  if (/^\/auto/i.test(text)) {
    const v = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!/^(on|off)$/i.test(v)) {
      await tg.api('sendMessage', { chat_id: chatId, text: '❓ مثال: <code>/auto on</code> یا <code>/auto off</code>', parse_mode: 'HTML' });
      return;
    }
    const merged = await store.setCfg({ autoResume: v === 'on' });
    await tg.api('sendMessage', { chat_id: chatId, text: `♻️ ادامه خودکار: ${merged.autoResume === false ? 'خاموش' : 'روشن'}`, parse_mode: 'HTML' });
    return;
  }
  if (/^\/cancel/i.test(text)) {
    await store.setCancel();
    await store.queueClear();
    await store.clearResumeAt();
    await tg.api('sendMessage', { chat_id: chatId, text: '✅ صف و ادامه خودکار لغو شد.' });
    return;
  }
  if (/^\/fetch/i.test(text)) {
    const parts = text.split(/\s+/).slice(1);
    const count = Math.min(Math.max(parseInt(parts[parts.length - 1] || '3', 10) || 3, 1), 50);
    const tagsRaw = parts.slice(0, /\d+$/.test(parts[parts.length - 1] || '') ? -1 : parts.length);
    const tags = tagsRaw.map((t) => t.toLowerCase().replace(/^#/, '').replace(/\s+/g, '_')).filter(Boolean);
    if (!tags.length) {
      await tg.api('sendMessage', { chat_id: chatId, text: '❓ مثال: <code>/fetch kasumi 5</code>', parse_mode: 'HTML' });
      return;
    }
    const r = await queueJob({ tags, count, media: 'any', sort: 'default' }, chatId);
    await tg.api('sendMessage', {
      chat_id: chatId,
      text: `📥 ${r.enqueued} پست به صف اضافه شد (از ${r.total} نتیجه). شروع ارسال…`,
    });
    return;
  }

  // ---------- زبان طبیعی با Gemini ----------
  const intent = await parseCommand(text, { destination: cfg.destination, queueLen: qLen });
  if (!intent) {
    await tg.api('sendMessage', { chat_id: chatId, text: '🤔 متوجه منظورت نشدم. با /help راهنما را ببین.' });
    return;
  }
  let extra = '';
  try {
    switch (intent.action) {
      case 'queue': {
        const r = await queueJob(intent, chatId);
        if (r.enqueued === 0) extra = `⚠️ هیچ پست تازه‌ای برای «${intent.tags.join(', ')}» پیدا نشد.`;
        else extra = `📥 ${r.enqueued} پست به صف اضافه شد. شروع ارسال…`;
        break;
      }
      case 'set_destination': {
        let d = (intent.destination || intent.value || '').trim();
        if (!d || /^(اینجا|این چت|here)$/i.test(d)) d = chatId.startsWith('-100') || chatId.startsWith('-') ? chatId : '@' + (msg.chat?.username || '');
        if (!d || d === '@') {
          extra = '⚠️ نام یا شناسه کانال/گروه را مشخص کن (مثال: @mychannel).';
          break;
        }
        const merged = await store.setCfg({ destination: d });
        extra = `✅ مقصد: <code>${merged.destination}</code>`;
        break;
      }
      case 'status':
        extra = sendStatus(cfg, await store.queueLen());
        break;
      case 'clear_queue':
        await store.setCancel();
        await store.queueClear();
        await store.clearResumeAt();
        extra = '✅ صف پاک شد.';
        break;
      case 'resume':
        await store.clearResumeAt();
        extra = '▶️ در حال ادامه صف…';
        break;
      case 'toggle_link': {
        const on = /on|روشن|فعال|بذار|بگذار|بزار/i.test(intent.value || intent.reply || '');
        const merged = await store.setCfg({ includeLink: on });
        extra = `🔗 لینک پست: ${merged.includeLink ? 'روشن' : 'خاموش'}`;
        break;
      }
      case 'set_caption_mode': {
        const m = Math.min(Math.max(parseInt(intent.mode || '0', 10) || 0, 1), 4);
        if (!m) {
          extra = '⚠️ شماره قالب را بگو: 1 تا 4.';
          break;
        }
        await store.setCfg({ captionMode: m });
        extra = `✍️ قالب کپشن: ${m}`;
        break;
      }
      case 'toggle_auto': {
        const on = /on|روشن|فعال/i.test(intent.value || '');
        const merged = await store.setCfg({ autoResume: on });
        extra = `♻️ ادامه خودکار: ${merged.autoResume === false ? 'خاموش' : 'روشن'}`;
        break;
      }
      case 'help':
        extra = HELP;
        break;
      case 'chat':
      default:
        break;
    }
  } catch (e) {
    const raw = String(e?.message || e);
    const hint = (await explainError(raw)) || '';
    extra = `⚠️ خطا: <code>${raw.slice(0, 200)}</code>${hint ? `\n💡 ${hint}` : ''}`;
  }

  await tg.api('sendMessage', {
    chat_id: chatId,
    text: `${intent.reply || 'انجام شد.'}${extra ? '\n\n' + extra : ''}`,
    parse_mode: 'HTML',
  });

  // بعد از صف‌گذاری یا resume، اجرای صف را شروع کن
  if (intent.action === 'queue' || intent.action === 'resume') {
    const url = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '';
    if (url) {
      fetch(`${url}/api/cron?key=${encodeURIComponent(CFG.cronSecret)}&chain=0`, {
        headers: { 'x-cron-key': CFG.cronSecret },
      }).catch(() => {});
    }
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.status(200).send('running ✅');
    return;
  }
  // پاسخ سریع ۲۰۰؛ پردازش در پس‌زمینه
  res.status(200).json({ ok: true });

  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const msg = update?.message || update?.edited_message || update?.channel_post;
    if (!msg) return;

    // بررسی توکن محرمیت وب‌هوک
    if (CFG.webhookSecret) {
      const got = String(req.headers['x-telegram-bot-api-secret-token'] || '');
      if (got !== CFG.webhookSecret) return;
    }

    waitUntil(handle(msg)).catch(async (e) => {
      console.error('handle error:', e);
      if (CFG.adminId) {
        await tg.api('sendMessage', { chat_id: CFG.adminId, text: `⚠️ خطای داخلی: <code>${String(e?.message || e).slice(0, 300)}</code>`, parse_mode: 'HTML' }).catch(() => {});
      }
    });
  } catch (e) {
    console.error('webhook parse error:', e);
  }
}
