# Deploying the Klarity.ai backend (one-time, free, no API key)

The 4 AI-powered features (Rubric Analyzer, Essay Coach, Research Assistant, Study
Generator) need a tiny server. Unlike most AI integrations, **there is no API key
anywhere in this setup** — not for students, not for you. The AI model runs on
Cloudflare's own infrastructure (Workers AI) and authenticates automatically
through your Cloudflare login, so there's nothing to copy, paste, or keep secret.

## 1. Create a free Cloudflare account

Go to https://dash.cloudflare.com/sign-up and sign up (email + password — no
credit card). This gives you the free tiers used below:
- **Workers**: 100,000 requests/day free
- **Workers AI**: 10,000 "neurons" (compute units) per day free — plenty for a
  student project

## 2. Install the Cloudflare CLI (`wrangler`)

```bash
npm install -g wrangler
wrangler login
```

This opens your browser to log in to the account from step 1 — no key or token
to type anywhere.

## 3. Create `wrangler.toml` in this folder

```toml
name = "klarity-ai-backend"
main = "worker.js"
compatibility_date = "2026-01-01"

[ai]
binding = "AI"
```

That `[ai]` block is the entire "credential" — it tells Cloudflare to attach
its AI service to this Worker under your account. No key field, because there
is no key.

## 4. Deploy

```bash
wrangler deploy
```

This prints a URL like:

```
https://klarity-ai-backend.YOUR-SUBDOMAIN.workers.dev
```

## 5. Point the frontend at it

Open `index.html`, find the line near the top of the `<script>` block:

```js
var BACKEND_URL = ''; // <-- paste your Cloudflare Worker URL here
```

Paste your Worker URL (no trailing slash), commit, and push. The 4 AI features
will now work for every visitor — no key, no signup, no setup screen, for
anyone, ever.

## Optional: rate limiting

Without extra setup, abuse protection relies on Cloudflare's own daily Workers
AI allocation. For basic per-visitor rate limiting, create a free Cloudflare KV
namespace and bind it as `RATE_LIMIT`:

```bash
wrangler kv namespace create RATE_LIMIT
```

Add the returned `id` to `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "PASTE_ID_HERE"
```

Then redeploy with `wrangler deploy`. This is optional — the worker runs fine
without it.

## Swapping the model

`worker.js` uses `@cf/meta/llama-3.1-8b-instruct` by default — a solid,
free-tier-friendly open model. Cloudflare offers other Workers AI models (some
larger/more capable, some faster) if you want to try a different balance of
quality and speed; just change the `AI_MODEL` constant at the top of
`worker.js` and redeploy. No key changes needed either way.
