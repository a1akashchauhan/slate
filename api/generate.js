// Slate: server-side proxy to the Anthropic Messages API.
// Keeps the API key on the server, fixes the model and token budget, and streams the reply back.

const MODELS = {
  default: process.env.SLATE_MODEL || 'claude-sonnet-5-5',
  complex: process.env.SLATE_MODEL_COMPLEX || 'claude-opus-5-5',
};
const MAX_TOKENS = parseInt(process.env.SLATE_MAX_TOKENS || '32000', 10);
const MAX_PROMPT_CHARS = 400_000;
const MAX_IMAGES = 6;
const PER_HOUR = parseInt(process.env.SLATE_PER_HOUR || '12', 10);

// Best-effort limit per warm instance. The real ceiling is the monthly spend limit in the Anthropic Console.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (list.length >= PER_HOUR) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  return false;
}

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export async function POST(request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { error: 'Server is missing ANTHROPIC_API_KEY.' });

  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('origin') || '';
  if (allowed.length && !allowed.includes(origin)) return json(403, { error: 'Origin not allowed.' });

  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return json(429, { error: 'Too many worksheets this hour. Try again later.' });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'Bad JSON.' }); }
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) return json(400, { error: 'Empty prompt.' });
  if (prompt.length > MAX_PROMPT_CHARS) return json(413, { error: 'Source material is too long.' });

  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  const content = [];
  for (const im of images) {
    const type = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(im && im.type) ? im.type : null;
    if (type && typeof im.data === 'string') content.push({ type: 'image', source: { type: 'base64', media_type: type, data: im.data } });
  }
  content.push({ type: 'text', text: prompt });

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: body.tier === 'complex' ? MODELS.complex : MODELS.default,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    console.error('Anthropic error', upstream.status, detail.slice(0, 500));
    const status = upstream.status === 429 || upstream.status === 529 ? 429 : upstream.status === 413 ? 413 : 502;
    return json(status, { error: 'The model could not be reached.' });
  }

  return new Response(upstream.body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' },
  });
}
