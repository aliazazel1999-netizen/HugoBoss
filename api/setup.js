import { CFG, baseUrl } from '../lib/config.js';
import * as tg from '../lib/telegram.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const key = req.query.key || '';
  if (CFG.cronSecret && key !== CFG.cronSecret) {
    res.status(401).send('unauthorized');
    return;
  }
  const base = baseUrl();
  if (!base) {
    res.status(500).send('VERCEL_URL تنظیم نشده است.');
    return;
  }
  const url = `${base}/api/webhook`;
  const set = await tg.api('setWebhook', {
    url,
    secret_token: CFG.webhookSecret || undefined,
    drop_pending_updates: true,
    allowed_updates: ['message', 'edited_message', 'channel_post'],
  });
  const cmds = await tg.api('setMyCommands', {
    commands: [
      { command: 'start', description: 'شروع و راهنما' },
      { command: 'help', description: 'راهنمای کامل' },
      { command: 'dest', description: 'تنظیم مقصد ارسال' },
      { command: 'status', description: 'وضعیت ربات و صف' },
      { command: 'fetch', description: 'دانلود: /fetch تگ تعداد' },
      { command: 'mode', description: 'قالب کپشن: /mode 1..4' },
      { command: 'link', description: 'لینک پست: /link on|off' },
      { command: 'auto', description: 'ادامه خودکار: /auto on|off' },
      { command: 'cancel', description: 'لغو صف' },
    ],
  });
  const info = await tg.api('getWebhookInfo');
  res.status(200).json({ webhookUrl: url, set, cmds, info });
}
