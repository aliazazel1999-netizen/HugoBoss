import { CFG } from '../lib/config.js';
import { runQueue, autoResumeTick } from '../lib/queue.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // احراز: پارامتر key یا هدر x-cron-key (فراخوانی داخلی زنجیره هر دو را می‌فرستد)
  const key = req.query.key || req.headers['x-cron-key'] || '';
  if (CFG.cronSecret && key !== CFG.cronSecret) {
    res.status(401).send('unauthorized');
    return;
  }

  const chain = Math.max(0, parseInt(req.query.chain || '0', 10) || 0);

  if (req.query.wait === '1') {
    const r = await autoResumeTick(chain);
    res.status(200).json({ mode: 'wait', ...r });
    return;
  }

  const r = await runQueue(chain, 'cron');
  res.status(200).json({ mode: 'run', ...r });
}
