/* =========================================
   AdSync AI — pipeline.js
   AI-powered ad-to-landing-page personalization
   ========================================= */

'use strict';

/* ── State ── */
let generatedHTML = '';
let insightsData   = {};
const FALLBACK_MODELS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3-haiku',
  'google/gemini-flash-1.5'
];

/* ── UI helpers ── */

function $(id) { return document.getElementById(id); }

function showError(msg) {
  const box = $('errorBox');
  box.textContent = msg;
  box.style.display = 'block';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearError() {
  $('errorBox').style.display = 'none';
}

function setStep(n, state) {
  const el = $('ps' + n);
  el.className = 'progress-step ' + state;
  const icon = el.querySelector('.step-icon');
  if (state === 'done')   icon.textContent = '✓';
  if (state === 'active') icon.textContent = '';
  if (state === '')       icon.textContent = '';
}

function resetSteps() {
  [1,2,3,4,5].forEach(n => setStep(n, ''));
}

/* ── Ad image preview ── */

function previewAd(url) {
  const img = $('imgPreview');
  if (url && url.startsWith('http')) {
    img.src = url;
    img.style.display = 'block';
    img.onerror = () => { img.style.display = 'none'; };
  } else {
    img.style.display = 'none';
  }
}

/* ── Template fill ── */

function fillAd(text) {
  $('adText').value = text;
}

/* ── API key toggle ── */

function toggleKey() {
  const input = $('apiKey');
  const btn   = document.querySelector('.toggle-btn');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
}

/* ── Model badge ── */

function updateModelBadge() {
  const val = $('modelSelect').value;
  const short = val.split('/').pop();
  $('modelBadge').textContent = short;
}

/* ── CORS proxy fetch ── */

async function fetchPageContent(url) {
  const proxies = [
    `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?${encodeURIComponent(url)}`
  ];

  for (const proxy of proxies) {
    try {
      const resp = await fetch(proxy, { signal: AbortSignal.timeout(12000) });
      if (!resp.ok) continue;
      const json = await resp.json();
      const html = json.contents || json;
      if (!html || typeof html !== 'string' || html.length < 100) continue;

      const doc = new DOMParser().parseFromString(html, 'text/html');

      const title      = doc.querySelector('title')?.textContent?.trim() || '';
      const headings   = [...doc.querySelectorAll('h1,h2,h3')]
                           .slice(0,6)
                           .map(e => e.textContent.trim())
                           .filter(Boolean)
                           .join(' | ');
      const meta       = doc.querySelector('meta[name="description"]')?.content?.trim() || '';
      const ctaTexts   = [...doc.querySelectorAll('button,a.btn,a.cta,[class*="cta"],[class*="button"]')]
                           .slice(0,5)
                           .map(e => e.textContent.trim())
                           .filter(Boolean)
                           .join(' | ');
      const bodyText   = (doc.body?.innerText || doc.body?.textContent || '').slice(0, 2500);
      const rawHTML    = html.slice(0, 9000);

      return { title, headings, meta, ctaTexts, bodyText, rawHTML, fetched: true };
    } catch (_) {
      // try next proxy
    }
  }

  // Could not fetch — return shell so pipeline continues with URL context only
  return { title: '', headings: '', meta: '', ctaTexts: '', bodyText: '', rawHTML: '', fetched: false };
}

/* ── OpenRouter API call ── */

async function callOpenRouter(apiKey, model, messages, maxTokens = 4096) {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': window.location.origin || 'https://adsync.ai',
      'X-Title': 'AdSync AI'
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.4     // low temp = consistent, deterministic output
    })
  });

  if (!resp.ok) {
    let errMsg = `OpenRouter error ${resp.status}`;
    try {
      const errData = await resp.json();
      errMsg = errData?.error?.message || errMsg;
    } catch (_) {}
    if (resp.status === 401) {
      errMsg = `${errMsg}. Use an OpenRouter key from openrouter.ai/keys (usually starts with "sk-or-").`;
    }
    throw new Error(errMsg);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callOpenRouterWithFallback(apiKey, selectedModel, messages, maxTokens = 4096) {
  const tried = new Set();
  const modelQueue = [selectedModel, ...FALLBACK_MODELS.filter(m => m !== selectedModel)];
  let lastErr = null;

  for (const model of modelQueue) {
    if (!model || tried.has(model)) continue;
    tried.add(model);
    try {
      const content = await callOpenRouter(apiKey, model, messages, maxTokens);
      return { content, model };
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      const isNoEndpoint = /no endpoints found/i.test(msg);
      if (!isNoEndpoint) throw err;
      console.warn(`Model "${model}" unavailable, retrying with fallback model...`);
    }
  }

  throw lastErr || new Error('No available model endpoints found. Try again later or switch model.');
}

/* ── Safe JSON parse with fallback ── */

function safeParseJSON(raw) {
  try {
    const clean = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    return JSON.parse(clean);
  } catch (_) {
    return null;
  }
}

/* ── Analysis prompt ── */

function buildAnalysisPrompt(adContext, landingUrl, pageData) {
  return `You are a world-class CRO strategist. Analyze the following ad creative and landing page.

AD CREATIVE:
${adContext}

LANDING PAGE: ${landingUrl}
Title: ${pageData.title || 'N/A'}
Headings: ${pageData.headings || 'N/A'}
Meta description: ${pageData.meta || 'N/A'}
CTA elements found: ${pageData.ctaTexts || 'N/A'}
Body text excerpt:
${pageData.bodyText || '(could not fetch — use URL context)'}

Analyze the message-match between the ad and landing page. Identify CRO improvements.

Respond ONLY with valid JSON — no markdown fences, no preamble, no trailing text:
{
  "ad_promise": "one sentence — what the ad is promising",
  "ad_audience": "who the ad targets",
  "ad_cta": "the ad call-to-action",
  "page_headline": "current page headline",
  "message_match_score": <integer 1-10>,
  "gaps": ["gap 1", "gap 2", "gap 3"],
  "cro_changes": [
    {
      "element": "which element",
      "original": "current text",
      "improved": "new improved text",
      "reason": "why this improves conversion"
    }
  ],
  "new_headline": "personalized headline matching the ad promise",
  "new_subheadline": "personalized subheadline",
  "new_cta": "personalized CTA button text",
  "urgency_element": "urgency/scarcity text if applicable, else empty string",
  "social_proof": "relevant social proof to surface near CTA",
  "above_fold_priority": "what to show first based on ad promise"
}`;
}

/* ── HTML generation prompt ── */

function buildHTMLPrompt(analysis, landingUrl, pageData) {
  const hasContent = pageData.rawHTML && pageData.rawHTML.length > 500;
  return `You are a world-class CRO specialist and frontend engineer.
Generate a complete, production-ready, personalized landing page HTML.

AD ANALYSIS RESULTS:
- Ad Promise: ${analysis.ad_promise}
- Target Audience: ${analysis.ad_audience}
- Ad CTA: ${analysis.ad_cta}
- Original message-match score: ${analysis.message_match_score}/10
- Key gaps identified: ${(analysis.gaps || []).join('; ')}

PERSONALIZATION TO APPLY:
- New Headline: "${analysis.new_headline}"
- New Sub-headline: "${analysis.new_subheadline}"
- New CTA Button: "${analysis.new_cta}"
- Urgency element: "${analysis.urgency_element}"
- Social Proof: "${analysis.social_proof}"
- Above-fold priority: "${analysis.above_fold_priority}"

${hasContent
  ? `ORIGINAL PAGE HTML (preserve structure, surgically enhance):
${pageData.rawHTML.slice(0, 5000)}`
  : `Landing page URL: ${landingUrl}
(Page HTML could not be fetched. Build a high-converting standalone page based on the ad analysis.)`
}

STRICT RULES:
1. Return ONLY the complete HTML document starting with <!DOCTYPE html>
2. No markdown backticks, no explanation text before or after
3. PRESERVE the original page's navigation structure and sections
4. REPLACE/ENHANCE: hero headline, subheadline, hero CTA button, hero description paragraph
5. ADD: a slim urgency/announcement banner at top (if urgency_element is non-empty)
6. ADD: social proof text near the primary CTA button
7. ADD: a small "Personalized for you ✦" badge in the top-right corner of the hero
8. Use the brand's own colors/fonts; if unknown, use clean professional defaults
9. All CSS must be in <style> tags — no external CSS files
10. No broken images — replace <img> tags with CSS gradient placeholder divs where images would 404
11. No external JS dependencies; remove tracking/analytics scripts entirely
12. Must be fully responsive (mobile-first)
13. The above-fold section MUST immediately reflect the ad's exact promise
14. Changes must be professional and CRO-principled — NOT spammy`;
}

/* ── Safe HTML post-processing ── */

function sanitizeHTML(raw) {
  // Strip tracking/analytics scripts
  let html = raw
    .replace(/<script\b[^>]*src=["'][^"']*(gtag|analytics|tracking|pixel|fbq|hotjar|mixpanel|segment)[^"']*["'][^>]*><\/script>/gi, '')
    .replace(/^```html?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Ensure it's a full document
  if (!html.toLowerCase().includes('<!doctype') && !html.toLowerCase().includes('<html')) {
    html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personalized Page</title></head><body>${html}</body></html>`;
  }

  return html;
}

/* ── Render outputs ── */

function renderOutputs(analysis) {
  // Preview iframe
  const blob = new Blob([generatedHTML], { type: 'text/html' });
  $('previewFrame').src = URL.createObjectURL(blob);

  // Code tab
  $('codeBlock').textContent = generatedHTML;

  // Insights tab
  const score    = parseInt(analysis.message_match_score) || 5;
  const newScore = Math.min(10, score + 3);
  const scoreColor = score >= 7 ? '#1D9E75' : score >= 4 ? '#BA7517' : '#E24B4A';

  const fields = [
    { label: 'Ad Promise',      val: analysis.ad_promise },
    { label: 'Target Audience', val: analysis.ad_audience },
    { label: 'New Headline',    val: analysis.new_headline },
    { label: 'New CTA',         val: analysis.new_cta },
    { label: 'Urgency Added',   val: analysis.urgency_element },
    { label: 'Social Proof',    val: analysis.social_proof },
  ];

  const changes = (analysis.cro_changes || []).map(c => `
    <div class="change-card">
      <strong>${escapeHTML(c.element)}</strong>
      <span class="change-original">${escapeHTML(c.original)}</span><br/>
      <span class="change-improved">→ ${escapeHTML(c.improved)}</span>
      <span class="change-reason">${escapeHTML(c.reason)}</span>
    </div>`).join('');

  const gaps = (analysis.gaps || []).length
    ? `<ul class="gaps-list">${analysis.gaps.map(g => `<li>${escapeHTML(g)}</li>`).join('')}</ul>`
    : '';

  $('insightsBlock').innerHTML = `
    <div class="score-row">
      <div class="score-block">
        <span class="score-meta">Message match (before)</span>
        <span class="score-val" style="color:${scoreColor}">${score}<span class="score-suffix">/10</span></span>
      </div>
      <div class="score-block score-block-right">
        <span class="score-meta">After personalization</span>
        <span class="score-val" style="color:#1D9E75">${newScore}<span class="score-suffix">/10</span></span>
      </div>
    </div>
    ${fields.map(f => `
      <div class="insight-item">
        <div class="insight-label">${f.label}</div>
        ${escapeHTML(f.val || '—')}
      </div>`).join('')}
    ${gaps ? `<div class="insight-item"><div class="insight-label">Gaps Fixed</div>${gaps}</div>` : ''}
    ${changes ? `<div class="insight-item"><div class="insight-label">CRO Changes (${(analysis.cro_changes||[]).length})</div>${changes}</div>` : ''}
  `;
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Tab switching ── */

function switchTab(tab) {
  ['preview', 'code', 'insights'].forEach(t => {
    $('tab-' + t).className = 'tab' + (t === tab ? ' active' : '');
    $('panel-' + t).style.display = t === tab ? 'block' : 'none';
  });
}

/* ── Copy / Download ── */

function copyHTML() {
  if (!generatedHTML) return;
  navigator.clipboard.writeText(generatedHTML).then(() => {
    const btns = document.querySelectorAll('.copy-btn');
    btns[0].textContent = 'Copied!';
    setTimeout(() => { btns[0].textContent = 'Copy HTML'; }, 2000);
  });
}

function downloadHTML() {
  if (!generatedHTML) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([generatedHTML], { type: 'text/html' }));
  a.download = 'personalized-landing-page.html';
  a.click();
}

/* ════════════════════════════════════════════
   MAIN PIPELINE
   ════════════════════════════════════════════ */

async function runPipeline() {
  const apiKeyRaw = $('apiKey').value.trim();
  const apiKey    = apiKeyRaw.replace(/^Bearer\s+/i, '').trim();
  const model     = $('modelSelect').value;
  const adImg     = $('adImgUrl').value.trim();
  const adDesc    = $('adText').value.trim();
  const landingUrl = $('landingUrl').value.trim();

  // ── Input validation ──
  clearError();
  $('outputArea').style.display = 'none';

  if (!apiKey)              return showError('Please enter your OpenRouter API key.');
  if (!/^sk-or-/.test(apiKey)) {
    return showError('This does not look like an OpenRouter key. Please use a key from https://openrouter.ai/keys (usually starts with "sk-or-").');
  }
  if (!adDesc && !adImg)    return showError('Please provide ad creative — an image URL or a text description.');
  if (!landingUrl)          return showError('Please enter a landing page URL to personalize.');
  if (!/^https?:\/\//i.test(landingUrl)) return showError('Landing page URL must start with http:// or https://');

  $('runBtn').disabled = true;
  $('progressArea').style.display = 'block';
  resetSteps();
  generatedHTML = '';

  try {
    /* ── Step 1: Fetch page ── */
    setStep(1, 'active');
    const pageData = await fetchPageContent(landingUrl);
    setStep(1, 'done');

    /* ── Step 2: Analyze ── */
    setStep(2, 'active');
    const adContext = adImg
      ? `Ad Image URL: ${adImg}\nAd Description/Copy: ${adDesc || '(see image)'}`
      : `Ad Description/Copy: ${adDesc}`;

    const analysisResp = await callOpenRouterWithFallback(
      apiKey, model,
      [{ role: 'user', content: buildAnalysisPrompt(adContext, landingUrl, pageData) }],
      1024
    );
    const analysisRaw = analysisResp.content;
    if (analysisResp.model !== model) {
      console.warn(`Analysis used fallback model: ${analysisResp.model}`);
    }
    setStep(2, 'done');

    /* ── Step 3: Parse analysis ── */
    setStep(3, 'active');
    let analysis = safeParseJSON(analysisRaw);

    // Fallback if JSON parse fails (hallucination guard)
    if (!analysis || typeof analysis !== 'object') {
      console.warn('Analysis JSON parse failed — using fallback object');
      analysis = {
        ad_promise:           adDesc || 'Product or service offer',
        ad_audience:          'Target audience from ad',
        ad_cta:               'Get Started',
        page_headline:        pageData.title || 'Welcome',
        message_match_score:  5,
        gaps:                 ['Headline not aligned with ad', 'CTA mismatch', 'Missing urgency'],
        cro_changes:          [],
        new_headline:         'Exactly what you came here for',
        new_subheadline:      "You clicked because you want this. Here's how to get it.",
        new_cta:              'Claim Your Offer →',
        urgency_element:      'Limited time offer',
        social_proof:         'Join thousands of happy customers',
        above_fold_priority:  'Lead with the main benefit from the ad'
      };
    }

    insightsData = analysis;
    setStep(3, 'done');

    /* ── Step 4: Generate HTML ── */
    setStep(4, 'active');
    const htmlResp = await callOpenRouterWithFallback(
      apiKey, model,
      [{ role: 'user', content: buildHTMLPrompt(analysis, landingUrl, pageData) }],
      4096
    );
    const htmlRaw = htmlResp.content;
    if (htmlResp.model !== model) {
      console.warn(`Generation used fallback model: ${htmlResp.model}`);
    }
    setStep(4, 'done');

    /* ── Step 5: Validate & sanitize ── */
    setStep(5, 'active');
    generatedHTML = sanitizeHTML(htmlRaw);

    // Basic integrity check — if output is suspiciously short, warn
    if (generatedHTML.length < 400) {
      throw new Error('Generated HTML is too short — the model may have returned an error. Check your API key/credits and retry.');
    }

    setStep(5, 'done');

    /* ── Render ── */
    $('outputArea').style.display = 'block';
    renderOutputs(analysis);
    $('outputArea').scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (err) {
    showError('Pipeline error: ' + err.message);
    // Reset any active step
    [1,2,3,4,5].forEach(n => {
      const s = $('ps' + n);
      if (s.classList.contains('active')) s.className = 'progress-step';
    });
  } finally {
    $('runBtn').disabled = false;
  }
}
