# Slate · make it stick

Turn any lecture, chapter or video into a worksheet you solve by hand.

Slate is part of a small family of learning tools: **Litmus** (check what you read), **Slate** (work it out on paper) and **Dais** (teach it to an AI student).

## How it works

- `index.html` is the whole app: the form, the worksheet renderer, PDF / LaTeX / Overleaf exports.
- `api/generate.js` is a Vercel function that holds the Anthropic API key and streams the model's reply back to the page. The key never reaches the browser.

## Deploy on Vercel

1. Import this repo at vercel.com/new (framework preset: **Other**, no build command).
2. In **Settings → Environment Variables**, add `ANTHROPIC_API_KEY`.
3. Deploy. Then set `ALLOWED_ORIGINS` to your site's URL (e.g. `https://slate-xyz.vercel.app`) and redeploy.

Set a **monthly spend limit** in the Anthropic Console. That is the real cost ceiling; the per-hour limit in the function is best-effort.

## Run locally

```bash
npm i -g vercel
vercel dev
```

with `ANTHROPIC_API_KEY` in a local `.env` file (see `.env.example`).
