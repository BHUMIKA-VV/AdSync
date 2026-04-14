# AdSync AI — CRO Personalization Engine

A browser-based AI tool that takes an ad creative + landing page URL and generates a
personalized, CRO-optimized version of that landing page — same structure, better message match.

---

## How to run

1. Open `index.html` in any modern browser (Chrome, Firefox, Edge, Safari).
   No build step, no server required. It runs entirely client-side.

2. Enter your **OpenRouter API key** (get one free at https://openrouter.ai).

3. Provide your ad creative (image URL or text description) + landing page URL.

4. Click **Generate** and watch the 5-step pipeline run.

---

## Project structure

```
adsync-ai/
├── index.html      ← App shell & markup
├── style.css       ← All styles (dark-mode aware, responsive)
├── pipeline.js     ← Full AI pipeline logic
└── README.md       ← This file
```

---

## How the pipeline works

```
User Input
    │
    ▼
[Step 1] Fetch landing page via CORS proxy
         → Extracts: title, headings, meta description, CTA elements, body text
    │
    ▼
[Step 2] Analysis Agent (LLM call #1)
         → Returns structured JSON:
           - ad_promise, ad_audience, ad_cta
           - message_match_score (1-10)
           - gaps[] between ad and page
           - cro_changes[] with before/after
           - new_headline, new_cta, urgency_element, social_proof
    │
    ▼
[Step 3] Parse & validate JSON (with safe fallback)
    │
    ▼
[Step 4] Generation Agent (LLM call #2)
         → Uses analysis JSON + original page HTML as grounding
         → Returns complete, personalized HTML document
    │
    ▼
[Step 5] Sanitize output
         → Strip tracking scripts
         → Validate HTML structure
         → Wrap if incomplete
    │
    ▼
Output: Preview / HTML Code / CRO Insights tabs
```

---

## Key design decisions & edge-case handling

### Random/inconsistent changes
- Temperature set to **0.4** (low entropy) for both LLM calls
- The generation prompt explicitly lists which elements to change and which to preserve
- Analysis JSON acts as a grounding contract — the generator can't invent new CTAs because it's given exact strings

### Broken UI
- All `<img>` tags without valid src are replaced by CSS gradient placeholders
- External tracking/analytics scripts (`gtag`, `fbq`, `hotjar`, etc.) are stripped
- A fallback HTML wrapper is applied if the model returns incomplete HTML
- The iframe uses `sandbox="allow-scripts allow-same-origin"` to contain any errors

### Hallucinations
- **Two-pass architecture**: Analysis → JSON → Generation
  The model cannot hallucinate freely in Step 2 because it must conform to a strict JSON schema
  Step 4 is grounded by the already-validated JSON from Step 3
- If JSON parse fails, a safe deterministic fallback object is used (no pipeline crash)
- Output length check: if generated HTML < 400 chars, the pipeline throws a clear error

### Inconsistent outputs
- `safeParseJSON()` strips markdown fences before parsing
- The generation prompt repeats "Return ONLY the HTML document" twice
- `sanitizeHTML()` normalizes the output regardless of model quirks
- Both CORS proxy URLs are tried in sequence — if one fails, the other takes over

---

## Models supported (via OpenRouter)

| Model | Notes |
|---|---|
| `anthropic/claude-3.5-sonnet` | Best quality, recommended |
| `anthropic/claude-3-haiku` | Fastest, good for testing |
| `openai/gpt-4o` | Strong alternative |
| `google/gemini-flash-1.5` | Cost-efficient |

---

## Assumptions made

1. "Personalization" = surgical enhancement of existing page (headline, CTA, urgency, social proof) — not a full redesign.
2. Ad creative can be a URL to an image OR a text description (image analysis not available in this version without vision-capable model being selected).
3. Landing page content is fetched client-side via public CORS proxies (`allorigins.win`, `corsproxy.io`). Pages behind auth walls won't fetch — the pipeline continues with URL-context only.
4. API key is stored in-memory only (never persisted, never sent anywhere except OpenRouter).
5. Output is a self-contained HTML file — no CMS integration in this version.

---

## Tech stack

- Vanilla HTML + CSS + JS (zero dependencies, zero build tools)
- Google Fonts (Syne + DM Sans)
- OpenRouter API (model-agnostic LLM access)
- CORS proxies for page fetching: allorigins.win, corsproxy.io
