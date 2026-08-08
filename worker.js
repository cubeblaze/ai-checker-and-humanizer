/**
 * Klarity.ai backend proxy — Cloudflare Worker
 *
 * Holds the Gemini API key as a Cloudflare secret (set by the site owner via
 * `wrangler secret put GEMINI_API_KEY` — never hardcoded here) and proxies
 * AI-generation requests from the frontend so students never see or enter a
 * key. Also fetches pasted article URLs server-side (browsers block this via
 * CORS).
 *
 * Deploy: see DEPLOY.md in this folder.
 */

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const MAX_PROMPT_CHARS = 200000;   // ~50k tokens guardrail
const MAX_OUTPUT_TOKENS = 8192;
const RATE_LIMIT_PER_HOUR = 40;    // per-IP, generous for one student, caps abuse

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const headers = corsHeaders(request.headers.get('Origin'));

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    const url = new URL(request.url);

    // Optional per-IP rate limiting — only active if a KV namespace named
    // RATE_LIMIT is bound. Deployment works fine without it.
    if (env.RATE_LIMIT) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const bucket = Math.floor(Date.now() / 3600000);
      const key = `rl:${ip}:${bucket}`;
      const count = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
      if (count >= RATE_LIMIT_PER_HOUR) {
        return json({ error: 'Rate limit exceeded. Try again in a bit.' }, 429, headers);
      }
      ctx.waitUntil(env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 3700 }));
    }

    if (url.pathname === '/api/generate' && request.method === 'POST') {
      return handleGenerate(request, env, headers);
    }
    if (url.pathname === '/api/fetch-url' && request.method === 'POST') {
      return handleFetchUrl(request, headers);
    }
    return json({ error: 'Not found' }, 404, headers);
  },
};

async function handleGenerate(request, env, headers) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'Server is not configured with an API key yet.' }, 500, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400, headers);
  }

  const { system, prompt, json: wantsJson, maxOutputTokens } = body;
  if (!prompt || typeof prompt !== 'string') {
    return json({ error: 'Missing "prompt" string.' }, 400, headers);
  }
  const totalChars = (system || '').length + prompt.length;
  if (totalChars > MAX_PROMPT_CHARS) {
    return json({ error: 'Input is too large for this endpoint.' }, 400, headers);
  }

  const payload = {
    model: GEMINI_MODEL,
    input: prompt,
    generation_config: {
      max_output_tokens: Math.min(maxOutputTokens || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
    },
  };
  var systemText = system || '';
  if (wantsJson) {
    systemText += (systemText ? ' ' : '') + 'Respond with ONLY the raw JSON described above — no markdown code fences, no commentary before or after it.';
  }
  if (systemText) {
    payload.system_instruction = systemText;
  }

  let resp;
  try {
    resp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('generate: network error reaching Gemini', { endpoint: GEMINI_URL, model: GEMINI_MODEL, error: String(e.message || e) });
    return json({ error: 'Could not reach the AI provider: ' + String(e.message || e) }, 502, headers);
  }

  const rawText = await resp.text();
  let data;
  try { data = JSON.parse(rawText); } catch { data = null; }
  if (!resp.ok) {
    const reason = data?.error?.details?.find((d) => d.reason)?.reason || null;
    console.error('generate: upstream error', {
      endpoint: GEMINI_URL,
      model: GEMINI_MODEL,
      httpStatus: resp.status,
      googleErrorStatus: data?.error?.status || null,
      googleErrorReason: reason,
    });
    const msg = data?.error?.message || `Upstream error (${resp.status})`;
    return json({ error: msg }, resp.status >= 400 && resp.status < 600 ? resp.status : 502, headers);
  }

  // The Interactions API returns a `steps` array mixing "thought" steps and
  // a "model_output" step; the model_output step's content array carries the
  // actual text blocks. (Verified against a live response — the docs implied
  // a flat {output_text} shape that isn't what the API actually returns.)
  const outputStep = (data.steps || []).find((s) => s.type === 'model_output');
  const text = (outputStep?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('') || data.output_text || '';

  if (!text) {
    console.error('generate: no text extracted from response', { stepsTypes: (data.steps || []).map((s) => s.type) });
    return json({ error: 'The AI returned an empty response. Try again.' }, 502, headers);
  }

  return json({ text }, 200, headers);
}

async function handleFetchUrl(request, headers) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400, headers);
  }

  const { url: targetUrl } = body;
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return json({ error: 'Invalid URL.' }, 400, headers);
  }

  let resp;
  try {
    resp = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KlarityAI-Bot/1.0)' },
      redirect: 'follow',
    });
  } catch (e) {
    return json({ error: 'Could not fetch that URL: ' + String(e.message || e) }, 502, headers);
  }

  if (!resp.ok) {
    return json({ error: `That page returned an error (status ${resp.status}).` }, 502, headers);
  }

  const contentType = resp.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
    return json({ error: 'That URL does not appear to be a readable web page.' }, 400, headers);
  }

  const html = await resp.text();
  const text = extractReadableText(html);
  if (!text || text.length < 50) {
    return json({ error: 'Could not extract readable text from that page.' }, 422, headers);
  }

  return json({ text, url: targetUrl }, 200, headers);
}

function extractReadableText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const articleMatch = s.match(/<article[\s\S]*?<\/article>/i) || s.match(/<main[\s\S]*?<\/main>/i);
  if (articleMatch) s = articleMatch[0];

  s = s
    .replace(/<\/(p|div|br|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s.slice(0, 60000);
}
