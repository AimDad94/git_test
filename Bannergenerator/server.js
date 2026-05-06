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

// Walk CSS blocks once. Yields { selectors, body } for every rule we find.
// Skips @font-face/@keyframes/@media wrappers — at-rules are handled by
// stripping the wrapper and re-yielding their contents.
function* walkCssRules(css) {
  if (!css) return;
  // Strip @font-face / @keyframes — useless for design tokens, and their
  // bodies often contain values that confuse our property scanners.
  const stripped = css
    .replace(/@font-face\s*\{[^}]*\}/gi, '')
    .replace(/@keyframes[^{]+\{(?:[^{}]|\{[^}]*\})*\}/gi, '');
  // Naive but effective: match selector-block pairs at top level + inside
  // @media wrappers (we don't care which media query the rule is in).
  const blockRe = /([^{}@]+)\{([^{}]*)\}/g;
  let m;
  while ((m = blockRe.exec(stripped)) !== null) {
    const selectors = m[1].trim();
    const body = m[2];
    if (!selectors || !body) continue;
    yield { selectors, body };
  }
}

function readDecl(body, prop) {
  const re = new RegExp(`(?:^|[;{])\\s*${prop}\\s*:\\s*([^;}]+)`, 'i');
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

// Extract concrete CTA/button style tokens from CSS. We look at button-ish
// selectors and capture their declared styles — far more reliable than asking
// Claude to guess "what radius would Stripe use".
function extractCtaStyle(css) {
  if (!css) return null;
  // Selectors ranked from most-specific (likely the brand's primary button)
  // to least. First match wins per property.
  const patterns = [
    /(?:^|[\s,>+~])\.btn-primary\b/i,
    /(?:^|[\s,>+~])\.button-primary\b/i,
    /(?:^|[\s,>+~])\.btn--primary\b/i,
    /(?:^|[\s,>+~])\.cta\b/i,
    /(?:^|[\s,>+~])\.cta-button\b/i,
    /(?:^|[\s,>+~])\.button\b/i,
    /(?:^|[\s,>+~])\.btn\b/i,
    /(?:^|[\s,>+~])button(?:\s|,|$|\.|\[|:)/i,
  ];
  const result = {};
  const props = ['background-color', 'background', 'color', 'border-radius',
                 'font-weight', 'text-transform', 'letter-spacing', 'padding'];
  for (const pattern of patterns) {
    for (const { selectors, body } of walkCssRules(css)) {
      if (!pattern.test(selectors)) continue;
      // Skip pseudo-state declarations — they describe interaction, not the
      // canonical brand button.
      if (/:(hover|focus|active|disabled|focus-visible|focus-within)/.test(selectors)) continue;
      for (const prop of props) {
        const key = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (result[key]) continue;
        const val = readDecl(body, prop);
        if (!val) continue;
        // For background, only keep if it's a plain colour (skip gradients/images for now)
        if (prop === 'background' && !/^(#|rgb|hsl|[a-z]+$)/i.test(val)) continue;
        result[key] = val;
      }
    }
  }
  // Promote `background` to `backgroundColor` if the latter wasn't found and
  // background looks like a plain colour.
  if (!result.backgroundColor && result.background && /^#|^rgb|^hsl/i.test(result.background)) {
    result.backgroundColor = result.background;
  }
  return Object.keys(result).length ? result : null;
}

// Heading style signature — brands have characteristic h1/h2 typography
// (think: Apple's tight tracking, Stripe's heavy weight, MailChimp's caps).
function extractHeadingStyle(css) {
  if (!css) return null;
  const result = {};
  const props = ['font-weight', 'text-transform', 'letter-spacing', 'font-style', 'line-height'];
  const headingSelector = /(?:^|[\s,>+~])(h1|h2)\b|\.(hero[\w-]*title|hero[\w-]*heading|display|headline|banner-?title|page-?title)\b/i;
  for (const { selectors, body } of walkCssRules(css)) {
    if (!headingSelector.test(selectors)) continue;
    if (/:(hover|focus|active|disabled)/.test(selectors)) continue;
    for (const prop of props) {
      const key = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (result[key]) continue;
      const val = readDecl(body, prop);
      if (val) result[key] = val;
    }
  }
  return Object.keys(result).length ? result : null;
}

// Weighted colour palette — counts each colour's appearances and tags whether
// it shows up as background / text / border / accent. Far better than the
// raw "set of all hex codes that appear in the CSS" approach.
function extractWeightedPalette(css) {
  if (!css) return [];
  const stats = new Map(); // hex → { count, bg, text, border, accent }
  const bump = (hex, role) => {
    const k = hex.toLowerCase();
    const r = stats.get(k) || { count: 0, bg: 0, text: 0, border: 0, accent: 0 };
    r.count++;
    r[role]++;
    stats.set(k, r);
  };

  for (const { body } of walkCssRules(css)) {
    // background / background-color
    for (const m of body.matchAll(/background(?:-color)?\s*:[^;}]*?(#[0-9a-f]{6})\b/gi)) bump(m[1], 'bg');
    // color (text)
    for (const m of body.matchAll(/(?:^|[;{])\s*color\s*:[^;}]*?(#[0-9a-f]{6})\b/gi)) bump(m[1], 'text');
    // border / outline
    for (const m of body.matchAll(/(?:border|outline)(?:-(?:top|right|bottom|left|color))?\s*:[^;}]*?(#[0-9a-f]{6})\b/gi)) bump(m[1], 'border');
    // accent-color, fill, stroke
    for (const m of body.matchAll(/(?:accent-color|fill|stroke)\s*:[^;}]*?(#[0-9a-f]{6})\b/gi)) bump(m[1], 'accent');
  }

  return [...stats.entries()]
    .filter(([hex]) => {
      if (hex === '#ffffff' || hex === '#000000') return false;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      return brightness > 18 && brightness < 240;
    })
    .map(([hex, m]) => ({ hex, ...m }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

// Detect site theme (light vs dark) from body/html background.
function detectThemeBg(css) {
  for (const { selectors, body } of walkCssRules(css)) {
    if (!/^(body|html)\b|(?:^|[\s,>+~])(body|html)\b/.test(selectors.toLowerCase())) continue;
    const bg = readDecl(body, 'background-color') || readDecl(body, 'background');
    if (bg && /^#[0-9a-f]{6}\b/i.test(bg)) {
      const m = bg.match(/^#[0-9a-f]{6}\b/i);
      if (m) return m[0].toLowerCase();
    }
  }
  return null;
}

function extractDesignData($, extraCss = '') {
  const design = {
    themeColor: '',
    googleFonts: [],
    cssVars: {},
    dominantColors: [],
    bodyFont: '',
    headlineFont: '',
    ctaStyle: null,           // { backgroundColor, color, borderRadius, fontWeight, textTransform, letterSpacing, padding }
    headingStyle: null,       // { fontWeight, textTransform, letterSpacing, fontStyle, lineHeight }
    palette: [],              // [{ hex, count, bg, text, border, accent }]
    themeBg: null,            // hex of body background, if detected
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

  // Concrete style tokens — bypass Claude's guesswork by reading the site's
  // actual button/heading rules and ranking colours by usage.
  const allCssJoined = [...cssChunks].join('\n');
  design.ctaStyle = extractCtaStyle(allCssJoined);
  design.headingStyle = extractHeadingStyle(allCssJoined);
  design.palette = extractWeightedPalette(allCssJoined);
  design.themeBg = detectThemeBg(allCssJoined);

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

// Skip emails that are obviously not the brand's contact address — common
// noise from CMS templates, support boilerplate, and asset-bundle paths.
const EMAIL_BLOCKLIST = /(?:^|@)(?:no-?reply|mailer-daemon|postmaster|abuse|donotreply|webmaster@(?:google|wordpress|joomla))/i;
const EMAIL_VENDOR_DOMAINS = /@(?:wixpress|wordpress|sentry|googletagmanager|cloudflare|gstatic|fontawesome|cdn\.|w3\.org)/i;

// Free-text phone matcher. Captures Danish 8-digit numbers (the dominant
// format on .dk pages) and international +CC-prefixed numbers. We require
// some structure (spaces / dashes / leading +) to avoid grabbing random
// number runs from VAT IDs or product codes.
const PHONE_TEXT_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/g;

function looksLikeDanishPhone(s) {
  const digits = s.replace(/\D/g, '');
  // 8 digits (DK national) or 10-11 with country code
  return digits.length >= 8 && digits.length <= 13;
}

function pickBestEmail(candidates) {
  // Prefer the shortest non-blocked email, on the assumption that
  // "info@brand.dk" beats "marketing.team.lead@brand.dk".
  return candidates
    .filter((e) => !EMAIL_BLOCKLIST.test(e) && !EMAIL_VENDOR_DOMAINS.test(e))
    .sort((a, b) => a.length - b.length)[0] || '';
}

// Decode common HTML-entity-obfuscated emails that anti-spam plugins use:
//   user&#64;example&#46;com  →  user@example.com
function decodeEntityEmail(s) {
  return s
    .replace(/&#0*64;/g, '@')
    .replace(/&#0*46;/g, '.')
    .replace(/\s*\[\s*at\s*\]\s*/gi, '@')
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/\s*\[\s*dot\s*\]\s*/gi, '.')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.');
}

// Scrape contact info — phone numbers, address, email, and social profile
// URLs. These appear in nearly every brand banner and are easy to extract
// reliably: tel:/mailto: links and schema.org PostalAddress give us
// structured data straight from the page without needing Claude to infer.
function extractContactInfo($, baseUrl) {
  const out = { phone: '', email: '', address: '', facebookUrl: '', instagramUrl: '' };

  // ── Phone ────────────────────────────────────────────────────────────
  // 1) tel: href is the strongest signal — always machine-readable.
  const tel = $('a[href^="tel:"]').first();
  if (tel.length) {
    const num = (tel.attr('href') || '').replace(/^tel:/, '').trim();
    if (num) out.phone = num;
  }

  // ── Email ────────────────────────────────────────────────────────────
  // mailto: hrefs first
  const mailtoCandidates = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const href = ($(el).attr('href') || '').replace(/^mailto:/, '').split('?')[0].trim();
    if (href && /\S+@\S+\.\S+/.test(href)) mailtoCandidates.push(href.toLowerCase());
  });
  out.email = pickBestEmail(mailtoCandidates);

  // ── Address ──────────────────────────────────────────────────────────
  // Microdata / <address> / common contact classes
  const $addr = $('[itemtype*="PostalAddress"], address, .address, .vcard .adr, footer .contact').first();
  if ($addr.length) {
    const raw = $addr.text().replace(/\s+/g, ' ').trim();
    if (raw.length > 0 && raw.length < 200) out.address = raw;
  }

  // JSON-LD — second pass for structured PostalAddress / telephone / email
  $('script[type="application/ld+json"]').each((_, el) => {
    let parsed;
    try { parsed = JSON.parse($(el).text() || $(el).html() || ''); } catch { return; }
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node['@type'] && /PostalAddress/i.test(String(node['@type']))) {
        const parts = [
          node.streetAddress,
          [node.postalCode, node.addressLocality].filter(Boolean).join(' '),
        ].filter(Boolean);
        if (parts.length && !out.address) out.address = parts.join('\n');
      }
      if (node.address && typeof node.address === 'object') visit(node.address);
      if (node.telephone && !out.phone) out.phone = String(node.telephone);
      if (node.email && !out.email) out.email = String(node.email).toLowerCase().replace(/^mailto:/, '');
      if (node['@graph']) visit(node['@graph']);
    };
    visit(parsed);
  });

  // ── Free-text fallbacks ──────────────────────────────────────────────
  // Many sites bury contact info in plain footer text. We only run text
  // scans if structured/href extraction failed, to avoid false positives.
  if (!out.phone || !out.email) {
    // Restrict the text scan to footer-ish areas to keep noise down.
    const contactScope = $('footer, .footer, [class*="contact"], [class*="kontakt"], #contact, #kontakt').text();
    const textPool = (contactScope || $('body').text()).slice(0, 20_000);

    if (!out.email) {
      const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
      const decoded = decodeEntityEmail(textPool);
      const matches = (decoded.match(emailRe) || []).map((s) => s.toLowerCase());
      out.email = pickBestEmail([...new Set(matches)]);
    }

    if (!out.phone) {
      const candidates = (textPool.match(PHONE_TEXT_RE) || [])
        .map((s) => s.trim())
        .filter(looksLikeDanishPhone);
      // Prefer the candidate that looks most "phone-shaped": has spaces or
      // a leading + (raw digit runs are usually not phone numbers).
      const structured = candidates.find((s) => /[+\s.-]/.test(s));
      out.phone = structured || candidates[0] || '';
    }
  }

  // ── Social profile URLs ──────────────────────────────────────────────
  const socialHosts = {
    facebookUrl: /(?:^|\.)facebook\.com\b/i,
    instagramUrl: /(?:^|\.)instagram\.com\b/i,
  };
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || /\bshare(?:r)?\.php|sharer\b/i.test(href)) return;
    const resolved = resolveUrl(baseUrl, href);
    if (!resolved) return;
    for (const [key, host] of Object.entries(socialHosts)) {
      if (out[key]) continue;
      try {
        const u = new URL(resolved);
        if (host.test(u.hostname) && u.pathname.length > 1) out[key] = resolved;
      } catch { /* ignore */ }
    }
  });

  return out;
}

// Find a link to the brand's contact page so we can scrape it for fields
// the homepage didn't surface. Most Danish sites use /kontakt; English
// sites use /contact. We prefer header/footer links since they're more
// likely to point at the canonical contact page.
function findContactPageUrl($, baseUrl) {
  const matchers = [/\bkontakt(?:-os|-info)?\b/i, /\bcontact(?:-us)?\b/i, /\bom-os\b/i, /\babout-us\b/i];
  // Score: header/footer + canonical path > body link > deep link
  let best = null;
  let bestScore = 0;
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const resolved = resolveUrl(baseUrl, href);
    if (!resolved) return;
    let pathname;
    try { pathname = new URL(resolved).pathname; } catch { return; }
    const text = $el.text().trim();
    // Match either the path or the link text against our keywords.
    if (!matchers.some((re) => re.test(pathname) || re.test(text))) return;
    let score = 10;
    if ($el.closest('header, .header, nav, .nav').length) score += 30;
    if ($el.closest('footer, .footer').length) score += 20;
    // Penalise deep nested paths — /kontakt > /info/dk/kontakt-os
    score -= Math.max(0, pathname.split('/').filter(Boolean).length - 1) * 3;
    if (score > bestScore) { best = resolved; bestScore = score; }
  });
  return best;
}

// Merge contact info from a secondary source (typically a /kontakt page)
// into the primary. Existing values win — we only fill gaps.
function mergeContactInfo(primary, secondary) {
  const out = { ...primary };
  for (const k of Object.keys(secondary || {})) {
    if (!out[k] && secondary[k]) out[k] = secondary[k];
  }
  return out;
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

  // Contact info also comes from the FULL DOM — addresses and social links
  // typically live in the header or footer that we strip below.
  let contact = extractContactInfo($, baseUrl);

  // If the homepage is missing key contact fields, crawl the /kontakt page
  // and merge any new findings. Most Danish small-business sites keep the
  // canonical address/phone/email on a dedicated contact subpage rather
  // than the homepage footer.
  const missingFields = ['phone', 'email', 'address'].filter((k) => !contact[k]);
  if (missingFields.length) {
    const contactUrl = findContactPageUrl($, baseUrl);
    if (contactUrl && contactUrl !== baseUrl) {
      try {
        const r = await fetchWithTimeout(contactUrl, 6000);
        if (r.ok) {
          const html2 = await r.text();
          const $$ = cheerio.load(html2);
          const subContact = extractContactInfo($$, contactUrl);
          contact = mergeContactInfo(contact, subContact);
        }
      } catch { /* contact page failed — homepage data is still valid */ }
    }
  }

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
    contact,
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
    let contact = { phone: '', email: '', address: '', facebookUrl: '', instagramUrl: '' };
    let design = {
      themeColor: '', googleFonts: [], cssVars: {}, dominantColors: [],
      bodyFont: '', headlineFont: '',
      ctaStyle: null, headingStyle: null, palette: [], themeBg: null,
    };

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
        contact     = page.contact || contact;
      } catch (err) {
        return res.status(400).json({ error: `Could not fetch website: ${err.message}` });
      }
    }

    // Explicit image URL goes to the top of the selection
    if (imageUrl && !images.includes(imageUrl)) images.unshift(imageUrl);

    const combinedText = textContent.slice(0, 3000);

    // Build design context for Claude (may be empty if no website was analysed)
    const cssVarLines = Object.entries(design.cssVars).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none found)';

    // Weighted palette tells Claude which colours are LOAD-BEARING (used for
    // backgrounds vs. text vs. accents) instead of just listing every hex.
    const paletteLines = design.palette.length
      ? design.palette.slice(0, 6).map((p) => {
          const roles = [];
          if (p.bg)     roles.push(`${p.bg}× as background`);
          if (p.text)   roles.push(`${p.text}× as text`);
          if (p.border) roles.push(`${p.border}× as border`);
          if (p.accent) roles.push(`${p.accent}× as accent`);
          return `  ${p.hex} — ${roles.join(', ') || `${p.count} appearances`}`;
        }).join('\n')
      : '  (none found)';

    const ctaLines = design.ctaStyle
      ? Object.entries(design.ctaStyle).map(([k, v]) => `  ${k}: ${v}`).join('\n')
      : '  (no button styles detected)';

    const headingLines = design.headingStyle
      ? Object.entries(design.headingStyle).map(([k, v]) => `  ${k}: ${v}`).join('\n')
      : '  (no heading styles detected)';

    const designContext = `
=== DESIGN DATA EXTRACTED FROM THE PAGE ===
Theme-color meta tag: ${design.themeColor || '(not set)'}
Body background:      ${design.themeBg || '(not detected — assume light)'}
Google Fonts in use:  ${design.googleFonts.length ? design.googleFonts.join(', ') : '(none detected)'}
Body/primary font:    ${design.bodyFont || '(not detected)'}
Headline font:        ${design.headlineFont || '(same as body)'}

Weighted brand palette (most-used → least, by role):
${paletteLines}

CTA / primary button rule extracted from CSS:
${ctaLines}

Heading style signature (from h1/h2/.hero rules):
${headingLines}

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
- primaryColor: the colour for body/headline text on the banner. Use white (#ffffff) when the banner image/background is dark; use a dark colour from the palette when the banner area is light.
- secondaryColor: the site's accent/highlight colour. Strong signal: a high-count colour in the weighted palette that appears as accent/border/text on hero elements.
- overlayColor: a dark colour from the palette to use as the image overlay; default #000000 if none found.
- ctaColor: PREFER the extracted CTA background-color from the CSS rule above if present (it's the literal button colour the site already uses). Otherwise use the most-used "background" role colour from the weighted palette. Last resort: secondaryColor.
- fontFamily: the EXACT body/primary font-family name detected from the page (Google Font name or web-safe font). If none detected, pick a Google Font that matches the brand personality.
- headlineFont: the EXACT headline font detected (from h1/h2/.hero/.title CSS rules). If none detected or same as fontFamily, return "".
- overlayOpacity: between 0.30 and 0.60 — lower if the site has a clean/minimal feel, higher for dramatic.

Quality bar: if the extracted CTA rule shows e.g. "background: #2563eb, border-radius: 999px, font-weight: 600", that means the brand uses a blue pill-shaped semibold button. Reflect that personality in your colour choices — don't pick a contrasting accent that fights the brand.

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

    // Merge scraped contact info into analysis. Claude doesn't see contact
    // info in the prompt — addresses, phones and emails are factual data we
    // pull straight from the page, no LLM judgment needed.
    analysis.address      = contact.address      || analysis.address      || '';
    analysis.phone        = contact.phone        || analysis.phone        || '';
    analysis.email        = contact.email        || analysis.email        || '';
    analysis.facebookUrl  = contact.facebookUrl  || analysis.facebookUrl  || '';
    analysis.instagramUrl = contact.instagramUrl || analysis.instagramUrl || '';

    // designTokens are concrete CSS values lifted from the page — the frontend
    // applies them directly to the banner (border-radius, font-weight, button
    // colour) without round-tripping through Claude. They're authoritative
    // when present.
    const designTokens = {
      ctaStyle: design.ctaStyle,
      headingStyle: design.headingStyle,
      palette: design.palette,
      themeBg: design.themeBg,
    };

    res.json({ analysis, images, logos, designTokens });
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
