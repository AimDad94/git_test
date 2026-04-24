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

// ── Asset extraction helpers ─────────────────────────────────────────────────

// Pick the highest-resolution URL from a srcset attribute.
// Format: "img.jpg 1x, img@2x.jpg 2x" or "img-400.jpg 400w, img-800.jpg 800w".
function parseSrcset(srcset) {
  if (!srcset) return null;
  const candidates = srcset
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(/\s+/);
      const url = parts[0];
      let weight = 1;
      const descriptor = parts[1];
      if (descriptor) {
        const m = descriptor.match(/^(\d+(?:\.\d+)?)([wx])$/);
        if (m) weight = parseFloat(m[1]) * (m[2] === 'w' ? 1 : 1000);
      }
      return { url, weight };
    });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0].url;
}

// Pull the best image URL from an <img> — honours srcset + common lazy-load attrs.
function bestImgSrc($el) {
  const srcset = $el.attr('srcset') || $el.attr('data-srcset');
  if (srcset) {
    const best = parseSrcset(srcset);
    if (best) return best;
  }
  return (
    $el.attr('src') ||
    $el.attr('data-src') ||
    $el.attr('data-lazy-src') ||
    $el.attr('data-original') ||
    $el.attr('data-hi-res-src') ||
    $el.attr('data-image') ||
    null
  );
}

// Pull all url(...) targets from a block of CSS text.
function extractCssBackgroundImages(css) {
  if (!css) return [];
  const urls = new Set();
  const re = /background(?:-image)?\s*:[^;{}]*?url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  let m;
  while ((m = re.exec(css)) !== null) {
    const url = m[1].trim();
    if (url && !url.startsWith('data:')) urls.add(url);
  }
  return [...urls];
}

// Walk JSON-LD structured data for Organization.logo and *.image fields.
function extractJsonLd($) {
  const out = { logos: [], images: [] };
  $('script[type="application/ld+json"]').each((_, el) => {
    let parsed;
    try { parsed = JSON.parse($(el).text() || $(el).html() || ''); } catch { return; }
    const visit = (node) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (typeof node !== 'object') return;
      if (node.logo) {
        const url = typeof node.logo === 'string' ? node.logo : node.logo.url;
        if (typeof url === 'string') out.logos.push(url);
      }
      if (node.image) {
        const arr = Array.isArray(node.image) ? node.image : [node.image];
        arr.forEach((i) => {
          const url = typeof i === 'string' ? i : i?.url;
          if (typeof url === 'string') out.images.push(url);
        });
      }
      if (node['@graph']) visit(node['@graph']);
    };
    visit(parsed);
  });
  return out;
}

// Collect logo candidates with priority scoring. Higher score = more likely.
function extractLogos($, baseUrl, jsonLdLogos) {
  const scored = new Map();
  const add = (url, score) => {
    if (!url || url.startsWith('data:')) return;
    const resolved = resolveUrl(baseUrl, url);
    if (!resolved) return;
    const prev = scored.get(resolved);
    if (!prev || prev < score) scored.set(resolved, score);
  };

  // JSON-LD Organization logo is the strongest signal — publishers declare this intentionally.
  jsonLdLogos.forEach((url) => add(url, 300));

  // og:logo / meta logo fallbacks
  const ogLogo = $('meta[property="og:logo"], meta[name="og:logo"]').attr('content');
  if (ogLogo) add(ogLogo, 260);

  // apple-touch-icon (usually 180×180 PNG, high quality) and <link rel="icon">
  $('link[rel]').each((_, el) => {
    const $el = $(el);
    const rel = ($el.attr('rel') || '').toLowerCase();
    if (!/icon/.test(rel)) return;
    const href = $el.attr('href');
    if (!href) return;
    const sizes = $el.attr('sizes') || '';
    const sizeN = parseInt((sizes.match(/\d+/) || [0])[0], 10);
    const isApple = rel.includes('apple-touch-icon');
    const isMask = rel.includes('mask-icon');
    // Prefer larger icons and apple-touch variants; mask-icons are SVG → high quality.
    add(href, 100 + Math.min(sizeN, 512) + (isApple ? 40 : 0) + (isMask ? 30 : 0));
  });

  // Header/nav/logo-class <img> elements — strong DOM signal for the site's main mark.
  const logoSelector = [
    'header img', '.header img', '#header img',
    '.navbar img', '.nav img', '.nav-bar img',
    'img.logo', '.logo img', '#logo img',
    '[class*="logo"] img', '[id*="logo"] img',
    '[class*="brand"] img', '[id*="brand"] img',
    'img[alt*="logo" i]',
  ].join(', ');
  $(logoSelector).each((_, el) => {
    const $el = $(el);
    const src = bestImgSrc($el);
    if (!src) return;
    const isSvg = /\.svg(\?|$)/i.test(src);
    const w = parseInt($el.attr('width') || '0', 10);
    const h = parseInt($el.attr('height') || '0', 10);
    // Skip hero banners that happen to be inside <header> — logos are typically < 400px wide.
    if (w > 600 || h > 400) return;
    add(src, 200 + (isSvg ? 60 : 0));
  });

  // Inline SVG with logo-ish class/id — can't be downloaded as-is but worth noting.
  // (Skipped for now: rendering inline SVG requires extracting + serialising.)

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url)
    .slice(0, 8);
}

// Rank-aware image extractor: pulls from <img>/srcset, <picture>, meta tags,
// JSON-LD, inline style backgrounds, and stylesheet background-images.
function extractImages($, baseUrl, css, jsonLdImages) {
  const scored = new Map();
  const add = (url, score) => {
    if (!url || url.startsWith('data:')) return;
    const resolved = resolveUrl(baseUrl, url);
    if (!resolved) return;
    const prev = scored.get(resolved) || 0;
    if (score > prev) scored.set(resolved, score);
  };

  // Meta tag hero images — curated by the site for social sharing.
  const og = $('meta[property="og:image"], meta[property="og:image:secure_url"]').attr('content');
  if (og) add(og, 240);
  const tw = $('meta[name="twitter:image"], meta[property="twitter:image"]').attr('content');
  if (tw) add(tw, 220);
  const itemprop = $('meta[itemprop="image"]').attr('content');
  if (itemprop) add(itemprop, 200);

  // JSON-LD product/article images
  jsonLdImages.forEach((url) => add(url, 180));

  // <img> elements (srcset-aware)
  $('img').each((_, el) => {
    const $el = $(el);
    const src = bestImgSrc($el);
    if (!src) return;
    const w = parseInt($el.attr('width') || '0', 10);
    const h = parseInt($el.attr('height') || '0', 10);
    if ((w > 0 && w < 80) || (h > 0 && h < 80)) return;

    let score = 60;
    if (w > 0) score += Math.min(w, 2000) / 20;        // bigger → better
    if ($el.attr('alt')) score += 15;                   // alt text → likely content
    const cls = ($el.attr('class') || '').toLowerCase();
    if (/\b(hero|banner|feature|cover|main-image)\b/.test(cls)) score += 40;
    if (/\b(icon|avatar|sprite|thumb)\b/.test(cls)) score -= 30;
    add(src, score);
  });

  // <picture><source srcset> — responsive images
  $('picture source').each((_, el) => {
    const best = parseSrcset($(el).attr('srcset'));
    if (best) add(best, 90);
  });

  // Inline style="background-image: url(...)" — common for hero divs
  $('[style*="background"]').each((_, el) => {
    extractCssBackgroundImages($(el).attr('style') || '').forEach((url) => add(url, 120));
  });

  // Stylesheet background-images (hero sections often declared in CSS)
  extractCssBackgroundImages(css).forEach((url) => add(url, 50));

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url);
}

async function extractPageData(html, baseUrl) {
  const $ = cheerio.load(html);

  // Fetch external stylesheets — needed for fonts, colours, AND background-images.
  const extraCss = await fetchStylesheets($, baseUrl);

  // Collect inline <style> blocks so we can mine them for background-images too.
  const inlineStyleChunks = [];
  $('style').each((_, el) => inlineStyleChunks.push($(el).text()));
  const allCss = [extraCss, ...inlineStyleChunks].join('\n');

  // Extract design data BEFORE any DOM pruning.
  const design = extractDesignData($, extraCss);

  // JSON-LD is structured data, read it once — used by both logo and image paths.
  const jsonLd = extractJsonLd($);

  // Logos come from the FULL DOM (header/nav is where they live).
  const logos = extractLogos($, baseUrl, jsonLd.logos);

  // Now strip chrome so textContent/images come from body/main content only.
  $('script, style, nav, footer, header, [role="navigation"]').remove();

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

  const images = extractImages($, baseUrl, allCss, jsonLd.images);

  const textContent = [ogTitle || title, description, ...headings, ...paragraphs]
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);

  return {
    textContent,
    images: images.slice(0, 20),
    logos,
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
    let logos = [];
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
        logos       = page.logos || [];
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

    res.json({ analysis, images, logos });
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

// Pixabay image search proxy — keeps the API key server-side.
// Docs: https://pixabay.com/api/docs/
app.get('/api/pixabay-search', async (req, res) => {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return res.status(500).json({ error: 'PIXABAY_API_KEY not configured' });

  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  if (q.length > 100) return res.status(400).json({ error: 'q too long' });

  const page = Math.max(1, Math.min(50, parseInt(req.query.page, 10) || 1));
  const perPage = Math.max(3, Math.min(50, parseInt(req.query.per_page, 10) || 24));
  const orientation = ['horizontal', 'vertical', 'all'].includes(req.query.orientation)
    ? req.query.orientation : 'horizontal';

  const url = 'https://pixabay.com/api/?' + new URLSearchParams({
    key,
    q,
    image_type: 'photo',
    orientation,
    safesearch: 'true',
    per_page: String(perPage),
    page: String(page),
  }).toString();

  try {
    const r = await fetchWithTimeout(url, 10000);
    if (!r.ok) throw new Error(`Pixabay HTTP ${r.status}`);
    const data = await r.json();
    // Only return fields we need — keeps response small and avoids leaking internals.
    const hits = (data.hits || []).map((h) => ({
      id: h.id,
      previewURL: h.previewURL,        // small thumbnail (~150px)
      webformatURL: h.webformatURL,    // medium (~640px) — good for banner use
      largeImageURL: h.largeImageURL,  // large (~1280px)
      imageWidth: h.imageWidth,
      imageHeight: h.imageHeight,
      tags: h.tags,
      user: h.user,
      pageURL: h.pageURL,
    }));
    res.json({ total: data.totalHits || 0, hits });
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
