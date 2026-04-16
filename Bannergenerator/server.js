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

function extractPageData(html, baseUrl) {
  const $ = cheerio.load(html);
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

  // OG image is highest priority
  if (ogImage) {
    const resolved = resolveUrl(baseUrl, ogImage);
    if (resolved) images.push(resolved);
  }

  // Collect <img> sources (skip icons/tiny images)
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
    const w = parseInt($(el).attr('width') || '0', 10);
    const h = parseInt($(el).attr('height') || '0', 10);
    if (!src || src.startsWith('data:') || src.includes('logo') || src.includes('icon')) return;
    if ((w > 0 && w < 80) || (h > 0 && h < 80)) return;
    const resolved = resolveUrl(baseUrl, src);
    if (resolved && !images.includes(resolved)) images.push(resolved);
  });

  const textContent = [
    ogTitle || title,
    description,
    ...headings,
    ...paragraphs,
  ]
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3500);

  return {
    textContent,
    images: images.slice(0, 12),
    title: ogTitle || title,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Analyze a website URL and generate banner content via Claude
app.post('/api/analyze', async (req, res) => {
  const { websiteUrl, facebookUrl } = req.body;

  if (!websiteUrl) {
    return res.status(400).json({ error: 'websiteUrl is required' });
  }
  if (!isSafeUrl(websiteUrl)) {
    return res.status(400).json({ error: 'Invalid or unsafe URL' });
  }

  try {
    // Fetch website
    let html = '';
    try {
      const response = await fetchWithTimeout(websiteUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      html = await response.text();
    } catch (err) {
      return res.status(400).json({ error: `Could not fetch website: ${err.message}` });
    }

    const { textContent, images, title } = extractPageData(html, websiteUrl);

    // Optionally fetch Facebook OG image
    if (facebookUrl && isSafeUrl(facebookUrl)) {
      try {
        const fbRes = await fetchWithTimeout(facebookUrl, 8000);
        if (fbRes.ok) {
          const fbHtml = await fbRes.text();
          const $fb = cheerio.load(fbHtml);
          const fbOg = $fb('meta[property="og:image"]').attr('content');
          if (fbOg && !images.includes(fbOg)) images.unshift(fbOg);
        }
      } catch {
        // Facebook often blocks scrapers — silently ignore
      }
    }

    // Ask Claude to generate banner content
    const prompt = `You are a professional marketing copywriter. Analyze the following website content and generate professional banner elements.

Website URL: ${websiteUrl}
Content:
${textContent}

Return ONLY a valid JSON object with these exact fields (no markdown, no explanation):
{
  "companyName": "the company or brand name",
  "headline": "bold banner headline, max 6 words, impactful and specific to this company",
  "subtext": "supporting text describing value proposition, max 15 words",
  "tagline": "short memorable tagline, max 8 words",
  "ctaText": "call-to-action button text, 2-4 words",
  "primaryColor": "suggested text color as hex (e.g. #ffffff for dark backgrounds)",
  "secondaryColor": "suggested accent/highlight color as hex",
  "overlayColor": "suggested banner overlay color as hex (usually dark, e.g. #0a0a1a)",
  "overlayOpacity": suggested overlay opacity as number between 0.35 and 0.65
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
      // Graceful fallback
      analysis = {
        companyName: title,
        headline: title.split(/\s+/).slice(0, 5).join(' '),
        subtext: 'Visit us to learn more.',
        tagline: '',
        ctaText: 'Learn More',
        primaryColor: '#ffffff',
        secondaryColor: '#f0c040',
        overlayColor: '#000000',
        overlayOpacity: 0.5,
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
