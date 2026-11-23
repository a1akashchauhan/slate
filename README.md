# Slate · make it stick

Turn any lecture, chapter or video into a worksheet you solve by hand.

Slate is part of a small family of learning tools: **Litmus** (check what you read), **Slate** (work it out on paper) and **Dais** (teach it to an AI student).

## How it works

- `index.html` is the whole app: the form, the worksheet renderer, PDF / LaTeX / Overleaf exports.
- `api/generate.js` is a Vercel function that holds the API key (Gemini by default, Claude optional) and streams the model's reply back to the page. The key never reaches the browser.

## Deploy on Vercel

1. Get a free Gemini API key at [aistudio.google.com](https://aistudio.google.com) → **Get API key** (no card needed).
2. Import this repo at vercel.com/new (framework preset: **Other**, no build command).
3. In **Settings → Environment Variables**, add `GEMINI_API_KEY`.
4. Deploy. Then set `ALLOWED_ORIGINS` to your site's URL (e.g. `https://slate-xyz.vercel.app`) and redeploy.

The free Gemini tier has daily limits shared by all visitors, and Google may use free-tier prompts to improve its models. To switch to Claude later, set `PROVIDER=anthropic` and `ANTHROPIC_API_KEY` (with a spend limit set in the Anthropic Console). Nothing else changes.

## Run locally

```bash
npm i -g vercel
vercel dev
```

with `GEMINI_API_KEY` in a local `.env` file (see `.env.example`).
