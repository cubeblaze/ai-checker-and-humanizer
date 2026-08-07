# Deploying the Clarity.ai backend (one-time, free)

The 4 AI-powered features (Rubric Analyzer, Essay Coach, Research Assistant, Study
Generator) need a tiny server to hold an API key. Students never see this key or
enter anything — it's a one-time setup for you, the site owner, and it's free.

## 1. Get a free Gemini API key

1. Go to https://aistudio.google.com/apikey
2. Sign in with a Google account, click "Create API key"
3. Copy the key (starts with `AIza...`)

This is a genuinely free tier — no credit card required. Rate limits (per Google,
subject to change): 15 requests/minute, 1,500 requests/day, 1M tokens/day on
`gemini-2.0-flash`. Plenty for a student project.

## 2. Install the Cloudflare CLI (`wrangler`)

```bash
npm install -g wrangler
wrangler login
```

This opens a browser to sign in / create a free Cloudflare account (also no
credit card required for the Workers free tier: 100,000 requests/day).

## 3. Deploy the worker

From this folder:

```bash
wrangler deploy worker.js --name clarity-ai-backend --compatibility-date 2026-01-01
wrangler secret put GEMINI_API_KEY
```

When prompted by `secret put`, paste the API key from step 1.

`wrangler deploy` prints a URL like:

```
https://clarity-ai-backend.YOUR-SUBDOMAIN.workers.dev
```

## 4. Point the frontend at it

Open `index.html`, find the line near the top of the `<script>` block:

```js
var BACKEND_URL = ''; // <-- paste your Cloudflare Worker URL here
```

Paste your Worker URL (no trailing slash), commit, and push. The 4 AI features
will now work for every visitor — no key, no signup, nothing for them to do.

## Optional: rate limiting

Without extra setup, abuse protection relies on Google's own per-key rate limits.
For basic per-visitor rate limiting, create a free Cloudflare KV namespace and
bind it as `RATE_LIMIT`:

```bash
wrangler kv namespace create RATE_LIMIT
```

Add the returned `id` to a `wrangler.toml` in this folder:

```toml
name = "clarity-ai-backend"
main = "worker.js"
compatibility_date = "2026-01-01"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "PASTE_ID_HERE"
```

Then redeploy with `wrangler deploy`. This is optional — the worker runs fine
without it.
