import 'dotenv/config';
import express from 'express';
import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { readdir, readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANNERS_DIR = path.join(__dirname, 'banners');
const PORT = process.env.PORT || 3000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_IP_RE = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|0\.0\.0\.0)/i;

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure banners directory exists on startup
await mkdir(BANNERS_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function isSafeUrl(url) {
  try {
    const { hostname, protocol } = new URL(url);
    if (!['http:', 'https:'].includes(protocol)) return false;
    if (PRIVATE_IP_RE.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return null;
  }
}

const GENERIC_FONT = /^(inherit|initial|unset|revert|currentcolor|sans-serif|serif|monospace|cursive|fantasy|system-ui|-apple-system|blinkmacsystemfont|ui-sans-serif|ui-serif|ui-monospace)$/i;

// Fetch stylesheets referenced by <link rel="stylesheet"> so we can extract
// fonts/colours declared in external CSS files (most modern sites do this).
async function fetchStylesheets($, baseUrl) {
  const urls = [];
  $('link[rel="stylesheet"], link[rel~="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const resolved = resolveUrl(baseUrl, href);
    if (resolved && isSafeUrl(resolved)) urls.push(resolved);
  });
  const toFetch = urls.slice(0, 8);
  const chunks = await Promise.all(toFetch.map(async (url) => {
    try {
      const r = await fetchWithTimeout(url, 6000);
      if (!r.ok) return '';
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('css') && !url.toLowerCase().includes('.css')) return '';
      const t = await r.text();
      return t.slice(0, 300_000);
    } catch {
      return '';
    }
  }));
  return chunks.filter(Boolean).join('\n');
}

// Associate font-family declarations with their selectors so headline fonts
// (h1/h2/.hero/.title) can be distinguished from body fonts (body/html/p).
function scanFontRules(css, design) {
  const stripped = css.replace(/@font-face\s*\{[^}]*\}/gi, '');
  const blockRe = /([^{}@]+)\{([^{}]*)\}/g;
  let m;
  while ((m = blockRe.exec(stripped)) !== null) {
    const selectors = m[1].trim().toLowerCase();
    const body = m[2];
    if (!selectors || !body.includes('font-family')) continue;
    const ff = body.match(/font-family\s*:\s*([^;]+)/i);
    if (!ff) continue;
    const raw = ff[1].trim();
    if (raw.startsWith('var(')) continue;
    const first = raw.split(',')[0].replace(/['"]/g, '').trim();
    if (!first || GENERIC_FONT.test(first)) continue;

    const isHeadline = /(^|[\s,>+~])(h1|h2|h3)\b/.test(selectors)
                    || /\.(heading|hero|title|display|banner)/.test(selectors);
    const isBody = !isHeadline && /(^|[\s,>+~])(body|html|p)\b/.test(selectors);

    if (isHeadline && !design.headlineFont) design.headlineFont = first;
    if (isBody && !design.bodyFont) design.bodyFont = first;
    if (!isHeadline && !isBody && !design.bodyFont) design.bodyFont = first;
  }
}

function extractDesignData($, extraCss = '') {
  const design = {
    themeColor: '',
    googleFonts: [],
    cssVars: {},
    dominantColors: [],
    bodyFont: '',
    headlineFont: '',
  };

  design.themeColor = $('meta[name="theme-color"]').attr('content') || '';

  // Google Fonts from <link> tags
  $('link[href*="fonts.googleapis.com"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const families = href.match(/family=([^&]+)/g) || [];
    families.forEach((f) => {
      const name = decodeURIComponent(f.replace('family=', '')).split(/[:;]/)[0].replace(/\+/g, ' ').trim();
      if (name && !design.googleFonts.includes(name)) design.googleFonts.push(name);
    });
  });

  const allColors = new Set();
  const cssChunks = [];
  $('style').each((_, el) => cssChunks.push($(el).text()));
  if (extraCss) cssChunks.push(extraCss);

  for (const css of cssChunks) {
    // Google Fonts via @import
    const imports = css.match(/@import[^;]+fonts\.googleapis\.com[^;]+/g) || [];
    imports.forEach((imp) => {
      const families = imp.match(/family=([^&'"]+)/g) || [];
      families.forEach((f) => {
        const name = decodeURIComponent(f.replace('family=', '')).split(/[:;]/)[0].replace(/\+/g, ' ').trim();
        if (name && !design.googleFonts.includes(name)) design.googleFonts.push(name);
      });
    });

    // :root CSS vars (colour-valued only)
    const rootBlocks = css.match(/:root\s*\{[^}]+\}/g) || [];
    rootBlocks.forEach((block) => {
      for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        const val = m[2].trim();
        if (/#[0-9a-f]{3,8}/i.test(val) || /^rgb|^hsl/i.test(val)) {
          design.cssVars[m[1]] = val;
        }
      }
    });

    // Hex colours
    (css.match(/#[0-9a-f]{6}\b/gi) || []).forEach((c) => allColors.add(c.toLowerCase()));

    // Selector-aware font detection (headline vs body)
    scanFontRules(css, design);
  }

  // Inline style colours
  $('[style]').each((_, el) => {
    ($(el).attr('style').match(/#[0-9a-f]{6}\b/gi) || []).forEach((c) => allColors.add(c.toLowerCase()));
  });

  design.dominantColors = [...allColors]
    .filter((c) => {
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      const b = parseInt(c.slice(5, 7), 16);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      return brightness > 25 && brightness < 230;
    })
    .slice(0, 20);

  return design;
}

async function extractPageData(html, baseUrl) {
  const $ = cheerio.load(html);

  // Fetch external stylesheets (so we can see fonts/colours declared outside inline <style>)
  const extraCss = await fetchStylesheets($, baseUrl);

  // Extract design data BEFORE stripping style tags
  const design = extractDesignData($, extraCss);

  $('script, style, nav, footer, header, [role="navigation"]').remove();

  const ogImage = $('meta[property="og:image"]').attr('content');
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const title = $('title').text().trim();
  const description =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';

  const headings = $('h1, h2')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 2 && t.length < 200)
    .slice(0, 6);

  const paragraphs = $('p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 30)
    .slice(0, 6);

  const images = [];

  if (ogImage) {
    const resolved = resolveUrl(baseUrl, ogImage);
    if (resolved) images.push(resolved);
  }

  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
    const w = parseInt($(el).attr('width') || '0', 10);
    const h = parseInt($(el).attr('height') || '0', 10);
    if (!src || src.startsWith('data:') || src.includes('logo') || src.includes('icon')) return;
    if ((w > 0 && w < 80) || (h > 0 && h < 80)) return;
    const resolved = resolveUrl(baseUrl, src);
    if (resolved && !images.includes(resolved)) images.push(resolved);
  });

  const textContent = [ogTitle || title, description, ...headings, ...paragraphs]
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);

  return {
    textContent,
    images: images.slice(0, 12),
    title: ogTitle || title,
    design,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Analyze a website, image URL, or just a brand hint (company + business type)
// and generate banner content via Claude.
app.post('/api/analyze', async (req, res) => {
  const { websiteUrl, imageUrl, companyName: companyNameHint, businessType } = req.body;

  if (!websiteUrl && !imageUrl && !companyNameHint && !businessType) {
    return res.status(400).json({ error: 'Provide at least one input (website URL, image URL, company name, or business type).' });
  }
  for (const [name, u] of [['websiteUrl', websiteUrl], ['imageUrl', imageUrl]]) {
    if (u && !isSafeUrl(u)) return res.status(400).json({ error: `Invalid or unsafe ${name}` });
  }

  try {
    let textContent = '';
    let images = [];
    let title = '';
    let design = { themeColor: '', googleFonts: [], cssVars: {}, dominantColors: [], bodyFont: '', headlineFont: '' };

    // Website is the primary source when present
    if (websiteUrl) {
      try {
        const response = await fetchWithTimeout(websiteUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        const page = await extractPageData(html, websiteUrl);
        textContent = page.textContent;
        images      = page.images;
        title       = page.title;
        design      = page.design;
      } catch (err) {
        return res.status(400).json({ error: `Could not fetch website: ${err.message}` });
      }
    }

    // Explicit image URL goes to the top of the selection
    if (imageUrl && !images.includes(imageUrl)) images.unshift(imageUrl);

    const combinedText = textContent.slice(0, 3000);

    // Build design context for Claude (may be empty if no website was analysed)
    const cssVarLines = Object.entries(design.cssVars).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none found)';
    const designContext = `
=== DESIGN DATA EXTRACTED FROM THE PAGE ===
Theme-color meta tag: ${design.themeColor || '(not set)'}
Google Fonts in use:  ${design.googleFonts.length ? design.googleFonts.join(', ') : '(none detected)'}
Body/primary font:    ${design.bodyFont || '(not detected)'}
Headline font:        ${design.headlineFont || '(same as body)'}
CSS brand colours (mid-range, filtered):
  ${design.dominantColors.join(', ') || '(none found)'}
CSS custom properties (colour vars only):
${cssVarLines}`.trim();

    const brandHintLines = [
      companyNameHint && `Company name: ${companyNameHint}`,
      businessType    && `Business type / industry: ${businessType}`,
    ].filter(Boolean).join('\n');

    const sourceLines = [
      websiteUrl && `Website: ${websiteUrl}`,
      imageUrl   && `Image:   ${imageUrl}`,
    ].filter(Boolean).join('\n');

    const prompt = `You are an expert UI/brand designer AND marketing copywriter who creates banners that match a brand's identity.

Your job is to return banner copy (companyName, headline, subtext, tagline, ctaText) and design tokens (colours, fontFamily, overlayOpacity).

Copywriting rules:
- If PAGE CONTENT is available, ground the copy in what the page actually says.
- If only a company name and/or business type is given, write plausible, on-brand marketing copy for that industry. The tagline and subtext should sound like real marketing that a business of that type would use — avoid generic filler like "Visit us to learn more".
- Use the language that the company name / business type is written in (e.g. Danish input → Danish copy).
- Tagline should be memorable and specific to the industry (e.g. a bakery: "Fresh from the oven, every morning"; a law firm: "Clarity when it matters most").
- Headline should be bold and concrete; subtext should state the value proposition in plain terms.

Design rules:
- Study any design data extracted from the page's CSS. Colour and font choices MUST be grounded in that data — do not invent colours or fonts that aren't present.
- When no design data is available, pick tasteful defaults that suit the industry (e.g. calm blues for legal/finance, warm earthy tones for hospitality, bold saturated colours for fitness/energy brands).

=== BRAND HINT ===
${brandHintLines || '(not provided)'}

=== SOURCES ===
${sourceLines || '(no URLs provided — rely on BRAND HINT)'}

=== PAGE CONTENT ===
${combinedText || '(no textual content available — rely on BRAND HINT)'}

${designContext}

Field rules:
- primaryColor: the colour for body/headline text on the banner. Use white (#ffffff) if the site uses dark backgrounds, or a dark colour if the site is light.
- secondaryColor: the site's accent/highlight colour (look for it in CSS vars or dominant colours).
- overlayColor: a dark colour from the palette to use as the image overlay; if none found use #000000.
- ctaColor: the site's primary action/button colour extracted from the CSS; fall back to secondaryColor.
- fontFamily: the EXACT body/primary font-family name detected from the page (Google Font name or web-safe font). If none detected, pick a Google Font that matches the brand personality.
- headlineFont: the EXACT headline font detected (from h1/h2/.hero/.title CSS rules). If none detected or same as fontFamily, return "".
- overlayOpacity: between 0.30 and 0.60 — lower if the site has a clean/minimal feel, higher for dramatic.

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "companyName": "brand name",
  "headline": "bold banner headline, max 7 words, impactful",
  "subtext": "value proposition, max 15 words",
  "tagline": "short memorable tagline, max 8 words",
  "ctaText": "CTA button text, 2-4 words",
  "primaryColor": "#hex",
  "secondaryColor": "#hex",
  "overlayColor": "#hex",
  "overlayOpacity": 0.45,
  "ctaColor": "#hex",
  "fontFamily": "Font Name",
  "headlineFont": "Font Name or empty string"
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system:
        'You are a professional marketing copywriter and designer. Always respond with valid JSON only, no markdown fences, no extra text.',
      messages: [{ role: 'user', content: prompt }],
    });

    let analysis;
    try {
      const raw = message.content[0].text
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      analysis = JSON.parse(raw);
    } catch {
      const fallbackTitle = title || companyNameHint || 'Your Brand';
      analysis = {
        companyName: fallbackTitle,
        headline: fallbackTitle.split(/\s+/).slice(0, 5).join(' '),
        subtext: 'Visit us to learn more.',
        tagline: '',
        ctaText: 'Learn More',
        primaryColor: '#ffffff',
        secondaryColor: design.dominantColors[0] || '#f0c040',
        overlayColor: '#000000',
        overlayOpacity: 0.5,
        ctaColor: design.themeColor || design.dominantColors[0] || '#6c63ff',
        fontFamily: design.googleFonts[0] || design.bodyFont || '',
        headlineFont: design.headlineFont || '',
      };
    }

    res.json({ analysis, images });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Proxy an external image URL and return base64 data URI (avoids CORS for html2canvas)
app.get('/api/image-base64', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const decoded = decodeURIComponent(url);
  if (!isSafeUrl(decoded)) {
    return res.status(400).json({ error: 'Invalid or unsafe URL' });
  }

  try {
    const response = await fetchWithTimeout(decoded, 10000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      throw new Error('URL does not point to an image');
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    res.json({ dataUrl: `data:${contentType};base64,${base64}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all saved banners
app.get('/api/banners', async (req, res) => {
  try {
    const files = await readdir(BANNERS_DIR);
    const banners = (
      await Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map(async (f) => {
            try {
              const content = await readFile(path.join(BANNERS_DIR, f), 'utf-8');
              return JSON.parse(content);
            } catch {
              return null;
            }
          })
      )
    )
      .filter(Boolean)
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    res.json(banners);
  } catch {
    res.json([]);
  }
});

// Save a new banner
app.post('/api/banners', async (req, res) => {
  const id = randomUUID();
  const banner = { ...req.body, id, savedAt: new Date().toISOString() };
  await writeFile(path.join(BANNERS_DIR, `${id}.json`), JSON.stringify(banner, null, 2));
  res.status(201).json(banner);
});

// Update an existing banner
app.put('/api/banners/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });

  const filePath = path.join(BANNERS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  const existing = JSON.parse(await readFile(filePath, 'utf-8'));
  const updated = { ...existing, ...req.body, id, updatedAt: new Date().toISOString() };
  await writeFile(filePath, JSON.stringify(updated, null, 2));
  res.json(updated);
});

// Delete a banner
app.delete('/api/banners/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });

  const filePath = path.join(BANNERS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  await unlink(filePath);
  res.status(204).end();
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Banner Generator running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
});
