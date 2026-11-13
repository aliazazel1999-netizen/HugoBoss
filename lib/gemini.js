import { CFG } from './config.js';
import { fetchT, sleep } from './http.js';

// زنجیره مدل‌ها: پیش‌فرض شروع با اولین، و روی 404/429/500/503 خودکار جلو می‌رود
export const MODEL_CANDIDATES = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash',
];

let cachedModel = CFG.geminiModel;
let lastFailAt = 0;

const SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

function modelBroken(status, text) {
  if ([404, 429, 500, 503].includes(status)) return true;
  if (/not found|NOT_FOUND|unsupported|quota|exhausted|overload|high demand|rate|unavailable/i.test(text)) return true;
  return false;
}

/**
 * تولید متن/JSON با failover خودکار روی مدل‌ها
 * opts: { prompt, system, schema, temperature, maxTokens }
 */
export async function generate(opts = {}) {
  if (!CFG.geminiKey) throw new Error('GEMINI_API_KEY تنظیم نشده است');
  const body = {
    contents: [{ role: 'user', parts: [{ text: opts.prompt || 'ping' }] }],
    safetySettings: SAFETY,
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxTokens ?? 2048,
      ...(opts.schema ? { responseMimeType: 'application/json', responseSchema: opts.schema } : {}),
    },
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

  // ترتیب تلاش: مدل کش‌شده → مدل env → بقیه لیست
  const order = [...new Set([cachedModel, CFG.geminiModel, ...MODEL_CANDIDATES])].filter(Boolean);
  const errs = [];
  for (const model of order) {
    // اگر چند بار پشت‌سرهم خطا گرفتیم، بین مدل‌ها کمی صبر
    if (Date.now() - lastFailAt < 800) await sleep(800);
    try {
      const r = await fetchT(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${CFG.geminiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        45000
      );
      const text = await r.text();
      if (!r.ok) {
        errs.push(`${model}: HTTP ${r.status}`);
        if (modelBroken(r.status, text)) {
          lastFailAt = Date.now();
          continue; // مدل بعدی
        }
        throw new Error(`Gemini HTTP ${r.status}: ${text.slice(0, 300)}`);
      }
      const j = JSON.parse(text);
      const t = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      if (!t.trim()) {
        errs.push(`${model}: پاسخ خالی`);
        lastFailAt = Date.now();
        continue;
      }
      cachedModel = model; // مدل سالم را نگه دار
      return { model, text: t.trim() };
    } catch (e) {
      errs.push(`${model}: ${String(e?.message || e).slice(0, 120)}`);
      lastFailAt = Date.now();
    }
  }
  throw new Error('همه مدل‌های Gemini شکست خوردند: ' + errs.join(' | '));
}

async function genJSON(opts) {
  const { text } = await generate({ ...opts, schema: opts.schema });
  let t = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/) || t.match(/\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
    throw new Error('پاسخ Gemini قابل پارس نبود: ' + t.slice(0, 200));
  }
}

// ---------- دسته‌بندی معنایی تگ‌ها (لایه اصلی) ----------
export async function classifyTagsAI(names = []) {
  if (!names.length) return {};
  const schema = {
    type: 'object',
    properties: {
      artists: { type: 'array', items: { type: 'string' } },
      copyrights: { type: 'array', items: { type: 'string' } },
      characters: { type: 'array', items: { type: 'string' } },
    },
    required: ['artists', 'copyrights', 'characters'],
  };
  const system =
    'You classify booru-style tags for rule34.xxx. ' +
    '"artists" = creator/artist/studio tags (e.g. fellatrix, fellatrix_art). ' +
    '"copyrights" = franchise/series/game/movie the characters belong to (e.g. dead or alive, naruto, kantai collection). ' +
    '"characters" = fictional characters (person names, often with parentheses like kasumi_(dead_or_alive)). ' +
    'A tag must appear in exactly one list; ignore anything that does not fit. ' +
    'Match the original spelling of each input tag in the output.';
  const prompt = `Classify these tags:\n${names.join('\n')}`;
  try {
    const out = await genJSON({ prompt, system, schema, temperature: 0.1 });
    const norm = (a) => (Array.isArray(a) ? a.map((x) => String(x).toLowerCase()).filter(Boolean) : []);
    return {
      artists: norm(out.artists),
      copyrights: norm(out.copyrights),
      characters: norm(out.characters),
    };
  } catch {
    return null; // لایه‌های بعدی (API سایت + قاعده پرانتز) کار را کامل می‌کنند
  }
}

// ---------- تفسیر زبان طبیعی فارسی → دستور ----------
const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['queue', 'set_destination', 'status', 'clear_queue', 'resume', 'help', 'toggle_link', 'set_caption_mode', 'toggle_auto', 'chat'],
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'rule34 search tags, underscore style, in English' },
    count: { type: 'integer', description: 'how many posts to enqueue (1-50)' },
    destination: { type: 'string', description: 'channel/group id like @name or -100123...' },
    media: { type: 'string', enum: ['any', 'image', 'video', 'animation'] },
    sort: { type: 'string', enum: ['default', 'score', 'random'] },
    min_score: { type: 'integer' },
    value: { type: 'string', description: 'on/off or free text' },
    mode: { type: 'integer', description: 'caption mode 1-4' },
    reply: { type: 'string', description: 'کوتاه و دوستانه، به فارسی' },
  },
  required: ['action', 'reply'],
};

export async function parseCommand(text, context = {}) {
  const system = `You convert Persian (and English) Telegram messages for a rule34.xxx downloader bot into one action.

Actions:
- "queue": user wants to fetch & post content. Extract English rule34 tags (translate Persian words to English booru tags, spaces→underscores, e.g. «کسومی» → kasumi, «دِد یا لایو» → dead_or_alive). count defaults to 3. media: image/video/animation/any. sort: score if user wants بهترین/بالاترین امتیاز. min_score if a threshold mentioned.
- "set_destination": user sets target channel/group (a @username or numeric -100 id, or "اینجا/این چت" meaning the current chat).
- "status": وضعیت/وضعیت صف/چقدر مونده
- "clear_queue": لغو/پاک کردن/بیخیال صف
- "resume": ادامه/شروع دوباره ارسال صف
- "help": راهنما/چطور
- "toggle_link": خاموش/روشن کردن لینک پست در کپشن (value = on/off)
- "set_caption_mode": تغییر قالب کپشن به 1/2/3/4 (mode number). حالت‌ها: 1=کامل، 2=تگ‌های جستجو+آرتیست+حجم/آیدی+لینک+تایم ویدیو، 3=فقط تگ‌های جستجو+آرتیست، 4=خالی
- "toggle_auto": خاموش/روشن ادامه خودکار صف (value = on/off)
- "chat": anything else (greetings, questions)

"reply" must be a short friendly Persian sentence confirming what you will do. Context: ${JSON.stringify(context)}`;
  try {
    const out = await genJSON({ prompt: text, system, schema: INTENT_SCHEMA, temperature: 0.2 });
    if (!out || !out.action) return null;
    out.tags = Array.isArray(out.tags)
      ? out.tags.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_():-]/g, '')).filter(Boolean)
      : [];
    out.count = Math.min(Math.max(parseInt(out.count || '3', 10) || 3, 1), 50);
    out.media = ['any', 'image', 'video', 'animation'].includes(out.media) ? out.media : 'any';
    out.sort = ['default', 'score', 'random'].includes(out.sort) ? out.sort : 'default';
    out.mode = parseInt(out.mode || '0', 10);
    return out;
  } catch {
    return null;
  }
}

// ---------- توضیح خودکار خطاها به فارسی ----------
export async function explainError(rawError) {
  const system =
    'You are a helpful assistant explaining Telegram bot errors in Persian (Farsi). ' +
    'Given a raw error, explain in 1-2 short friendly Persian sentences what went wrong and what the admin should do. No markdown headers.';
  try {
    const { text } = await generate({ prompt: String(rawError).slice(0, 1500), system, temperature: 0.3, maxTokens: 300 });
    return text;
  } catch {
    return null;
  }
}

// ---------- تست سلامت ----------
export async function selfTest() {
  const { text, model } = await generate({ prompt: 'Reply with exactly: OK', temperature: 0, maxTokens: 10 });
  return { ok: /ok/i.test(text), model, text };
}

// ---------- (منسوخ) کپشن با AI — برای سازگاری نگه داشته شده ----------
export async function geminiCaption(post) {
  const system = 'Write a short English caption for a booru post using its tags. Max 2 lines.';
  try {
    const { text } = await generate({
      prompt: JSON.stringify({ tags: post?.tags, artist: post?.artist, character: post?.character }),
      system,
      temperature: 0.5,
      maxTokens: 120,
    });
    return text;
  } catch {
    return '';
  }
}
