// Slate: server-side proxy to the model.
// Keeps the API key on the server, fixes the model and token budget, and streams the reply back
// in one simple event format the page understands, whichever provider is behind it.
//
// PROVIDER=gemini (default, free tier) needs GEMINI_API_KEY.
// PROVIDER=anthropic needs ANTHROPIC_API_KEY.

const PROVIDER = (process.env.PROVIDER || 'gemini').toLowerCase();
const MODELS = {
  gemini: { default: process.env.SLATE_MODEL || 'gemini-3.8-flash', complex: process.env.SLATE_MODEL_COMPLEX || process.env.SLATE_MODEL || 'gemini-3.8-flash' },
  anthropic: { default: process.env.SLATE_MODEL || 'claude-sonnet-5-5', complex: process.env.SLATE_MODEL_COMPLEX || 'claude-opus-5-5' },
};
const GEMINI_FALLBACKS = (process.env.SLATE_FALLBACK_MODELS || 'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',').map((m) => m.trim()).filter(Boolean);
const MAX_TOKENS = parseInt(process.env.SLATE_MAX_TOKENS || '32000', 10);
const MAX_PROMPT_CHARS = 400_000;
const MAX_IMAGES = 6;
const PER_HOUR = parseInt(process.env.SLATE_PER_HOUR || '12', 10);
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Best-effort limit per warm instance. The real ceilings are the provider's own quotas or spend limits.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (list.length >= PER_HOUR) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  return false;
}

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const enc = new TextEncoder();
const sse = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const textEvent = (text) => sse({ type: 'content_block_delta', delta: { type: 'text_delta', text } });

function upstreamStatus(status) {
  if (status === 429 || status === 529 || status === 503) return 429;
  if (status === 413) return 413;
  return 502;
}

// Reads an SSE stream line by line and hands each parsed `data:` JSON object to onEvent.
async function readSSE(body, onEvent) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { onEvent(JSON.parse(data)); } catch { /* skip malformed line */ }
    }
  }
}

async function callGemini({ prompt, images, tier }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: 'Server is missing GEMINI_API_KEY.' });
  const parts = images.map((im) => ({ inline_data: { mime_type: im.type, data: im.data } }));
  parts.push({ text: prompt });
  const body = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.7 },
  });

  // Free-tier models get overloaded at times, so try the next one on "busy" or "not found".
  const first = tier === 'complex' ? MODELS.gemini.complex : MODELS.gemini.default;
  const chain = [first, ...GEMINI_FALLBACKS.filter((m) => m !== first)];
  let upstream = null, lastStatus = 502, reason = '', used = '', busy = null;
  // One full pass over the models, then one more after a short pause if they were only busy.
  const attempts = [...chain, ...chain];
  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i];
    if (i === chain.length) {
      if (!busy) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body },
    );
    if (upstream.ok && upstream.body) { used = model; console.log('Gemini model used:', model); break; }
    const detail = await upstream.text().catch(() => '');
    console.error('Gemini error', model, upstream.status, detail.slice(0, 600));
    lastStatus = upstream.status;
    try { const e = JSON.parse(detail).error || {}; reason = [model, e.status, e.message].filter(Boolean).join(': ').slice(0, 300); } catch { reason = model + ': ' + upstream.status; }
    upstream = null;
    if (lastStatus === 503 || lastStatus === 500) busy = { status: lastStatus, reason };
    if (![429, 500, 503, 404].includes(lastStatus)) break; // auth or request errors won't be fixed by another model
  }
  if (!upstream) {
    if (lastStatus === 404 && busy) ({ status: lastStatus, reason } = busy); // report the busy model, not a missing fallback
    return json(upstreamStatus(lastStatus), { error: 'The model could not be reached.', upstream: lastStatus, reason });
  }

  const stream = new ReadableStream({
    async start(controller) {
      let truncated = false;
      try {
        await readSSE(upstream.body, (ev) => {
          if (ev.error) { controller.enqueue(sse({ type: 'error', error: { type: ev.error.status === 'RESOURCE_EXHAUSTED' ? 'overloaded_error' : 'api_error' } })); return; }
          const cand = ev.candidates && ev.candidates[0];
          if (!cand) return;
          for (const p of (cand.content && cand.content.parts) || []) {
            if (p.thought || typeof p.text !== 'string' || !p.text) continue; // skip model's private reasoning
            controller.enqueue(textEvent(p.text));
          }
          if (cand.finishReason === 'MAX_TOKENS') truncated = true;
        });
        if (truncated) controller.enqueue(sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }));
        controller.enqueue(sse({ type: 'message_stop' }));
      } catch (e) {
        console.error('Gemini stream error', e);
        controller.enqueue(sse({ type: 'error', error: { type: 'api_error' } }));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-slate-model': used } });
}

async function callAnthropic({ prompt, images, tier }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { error: 'Server is missing ANTHROPIC_API_KEY.' });
  const content = images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } }));
  content.push({ type: 'text', text: prompt });
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: tier === 'complex' ? MODELS.anthropic.complex : MODELS.anthropic.default,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    console.error('Anthropic error', upstream.status, detail.slice(0, 800));
    return json(upstreamStatus(upstream.status), { error: 'The model could not be reached.' });
  }
  // Anthropic's stream already uses the event format the page reads.
  return new Response(upstream.body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' } });
}

export async function POST(request) {
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

  const images = (Array.isArray(body.images) ? body.images : [])
    .slice(0, MAX_IMAGES)
    .filter((im) => im && IMAGE_TYPES.includes(im.type) && typeof im.data === 'string');
  const tier = body.tier === 'complex' ? 'complex' : 'default';

  try {
    return PROVIDER === 'anthropic' ? await callAnthropic({ prompt, images, tier }) : await callGemini({ prompt, images, tier });
  } catch (e) {
    console.error('Proxy failure', e);
    return json(502, { error: 'The model could not be reached.' });
  }
}
