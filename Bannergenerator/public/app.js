/* ── Banner formats ──────────────────────────────────────────────────────── */
const FORMATS = [
  { id: '300x160',  label: '300×160',  sourceW: 600,  sourceH: 320 },
  { id: '300x250',  label: '300×250',  sourceW: 600,  sourceH: 500 },
  { id: '600x160',  label: '600×160',  sourceW: 1200, sourceH: 320 },
  { id: '640x160',  label: '640×160',  sourceW: 1280, sourceH: 320 },
  { id: '930x180',  label: '930×180',  sourceW: 1860, sourceH: 360 },
];

/* ── Default element positions (center-point x,y within 600×320 banner) ─── */
const DEFAULT_POSITIONS = {
  logo:        { x: 70,  y: 40  },  // top-left, free-floating (not in stack)
  companyName: { x: 300, y: 42  },
  headline:    { x: 300, y: 135 },
  subtext:     { x: 300, y: 198 },
  cta:         { x: 300, y: 258 },
  tagline:     { x: 300, y: 296 },
};

function clonePositions(src) {
  const out = {};
  for (const k of Object.keys(DEFAULT_POSITIONS)) {
    out[k] = src && src[k] ? { ...src[k] } : { ...DEFAULT_POSITIONS[k] };
  }
  return out;
}

/* ── State ──────────────────────────────────────────────────────────────── */
const state = {
  // Sourced from analysis
  images: [],              // [{ url, base64 }]
  // Banner properties
  companyName: '',
  headline: 'Your Banner Headline',
  subtext: 'Supporting text will appear here after analysis',
  tagline: '',
  ctaText: 'Learn More',
  showCompanyName: true,
  showHeadline: true,
  showSubtext: false,
  showTagline: false,
  showCta: true,
  // Logo (free-floating image element, independent of text stack)
  logoUrl: null,
  logoBase64: null,
  showLogo: false,
  logoSize: 56, // height in source pixels; width auto via aspect ratio
  // Scraped logo candidates from last analyze pass (shown in the logo picker)
  scrapedLogos: [],
  // Background
  selectedImageBase64: null,
  imageAvgColor: null,
  imagePixels: [],
  bgColor: '#1a1a2e',
  // Background image fit: 'cover' (fill+crop), 'contain' (fit whole, may letterbox),
  // 'fill' (stretch). imagePosX/Y are percentages used by background-position.
  imageFit: 'cover',
  imagePosX: 50,
  imagePosY: 50,
  // Overlay
  showOverlay: false,
  overlayColor: '#000000',
  overlayOpacity: 0.5,
  // Colors
  primaryColor: '#ffffff',
  secondaryColor: '#f0c040',
  ctaColor: '#6c63ff',
  ctaTextColor: '#ffffff',
  ctaFontSize: 14,
  ctaBorderRadius: 4,
  ctaPaddingV: 10,
  ctaPaddingH: 28,
  ctaFontWeight: '700',
  fontFamily: '',
  headlineFont: '',
  // Typography
  headlineSize: 20,
  subtextSize: 16,
  companySize: 32,
  taglineSize: 13,
  headlineWeight: '700',
  textAlign: 'center',
  // Element positions
  positions: clonePositions(),
  // Split/zoned layouts (empty for free-floating styles).
  // Each entry: { bounds_px:{x,y,w,h}, bg:'image'|'color', color:'#hex'|null,
  //               textColor:'#hex'|null, elements:[keys], textAlign }
  zones: [],
  // Per-element overrides populated when zones are active. Elements not in
  // these maps fall back to state.primaryColor / state.textAlign.
  elementColors: {},
  elementTextAligns: {},
  // Persistence
  currentBannerId: null,
  bannerName: '',
  // Format
  format: FORMATS[0],
  previewScale: 1,
};

/* ── DOM refs ────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

/* ── Font loader ─────────────────────────────────────────────────────────── */
const SYSTEM_FONTS = new Set(['Arial','Helvetica','Georgia','Times New Roman','Courier New','Verdana','Tahoma','Trebuchet MS','Impact','Comic Sans MS']);
let _loadedFont = '';
function loadGoogleFont(family) {
  if (!family || family === _loadedFont) return;
  if (SYSTEM_FONTS.has(family)) { _loadedFont = family; return; }
  document.getElementById('dynamic-font')?.remove();
  const link = document.createElement('link');
  link.id = 'dynamic-font';
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;600;700;900&display=swap`;
  document.head.appendChild(link);
  _loadedFont = family;
}

/* ── Design styles — aspect-aware layout + typography rules ──────────────── */
/*
 * Each style is a mini "design system":
 *   minAspect/maxAspect — which banner shapes this style suits (w/h ratio)
 *   textAlign, headlineWeight, overlayOpacity — style personality
 *   cta: { radius, padV, padH, weight } — button shape/weight
 *   typeScale: font sizes as fractions of banner height
 *   anchors.stackX — x centre (fraction of width) for the vertical stack
 *   anchors.cta    — 'flow' (CTA in stack) or {x, y} fractions (off-stack)
 *   vAlign         — 'top' | 'center' | 'bottom' — how stack sits in banner
 *   gap            — fraction of banner height between stacked elements
 *   vPad           — fraction of banner height reserved as top/bottom margin
 *
 * Shuffle measures real rendered heights (offsetHeight) and flows the stack
 * sequentially so elements never overlap.
 */
const DESIGN_STYLES = [
  {
    name: 'Bold Center',
    minAspect: 1.2, maxAspect: 4.5,
    textAlign: 'center', headlineWeight: '800', overlayOpacity: 0.52,
    cta: { radius: 4, padV: 12, padH: 34, weight: '700' },
    typeScale: { headline: 0.038, subtext: 0.058, company: 0.15, tagline: 0.036, cta: 0.052 },
    anchors: { stackX: 0.50, cta: 'flow' },
    vAlign: 'center', gap: 0.055, vPad: 0.06,
  },
  {
    name: 'Minimal Left',
    minAspect: 1.5, maxAspect: 6,
    textAlign: 'left', headlineWeight: '600', overlayOpacity: 0.36,
    cta: { radius: 2, padV: 9, padH: 26, weight: '500' },
    typeScale: { headline: 0.034, subtext: 0.050, company: 0.12, tagline: 0.030, cta: 0.046 },
    anchors: { stackX: 0.28, cta: 'flow' },
    vAlign: 'center', gap: 0.05, vPad: 0.08,
  },
  {
    name: 'Editorial Right',
    minAspect: 1.4, maxAspect: 5,
    textAlign: 'right', headlineWeight: '700', overlayOpacity: 0.45,
    cta: { radius: 6, padV: 10, padH: 28, weight: '600' },
    typeScale: { headline: 0.036, subtext: 0.054, company: 0.13, tagline: 0.032, cta: 0.048 },
    anchors: { stackX: 0.72, cta: 'flow' },
    vAlign: 'center', gap: 0.05, vPad: 0.08,
  },
  {
    name: 'Modern Split',
    minAspect: 2.0, maxAspect: 6,
    textAlign: 'left', headlineWeight: '700', overlayOpacity: 0.42,
    cta: { radius: 999, padV: 12, padH: 32, weight: '600' },
    typeScale: { headline: 0.036, subtext: 0.052, company: 0.14, tagline: 0.032, cta: 0.050 },
    anchors: { stackX: 0.30, cta: { x: 0.80, y: 0.50 } },
    vAlign: 'center', gap: 0.05, vPad: 0.10,
  },
  {
    name: 'Square Stack',
    minAspect: 0.5, maxAspect: 1.5,
    textAlign: 'center', headlineWeight: '800', overlayOpacity: 0.50,
    cta: { radius: 6, padV: 11, padH: 28, weight: '700' },
    typeScale: { headline: 0.032, subtext: 0.044, company: 0.10, tagline: 0.028, cta: 0.042 },
    anchors: { stackX: 0.50, cta: 'flow' },
    vAlign: 'center', gap: 0.045, vPad: 0.08,
  },
  {
    name: 'Top Heavy',
    minAspect: 1.3, maxAspect: 5,
    textAlign: 'center', headlineWeight: '900', overlayOpacity: 0.50,
    cta: { radius: 4, padV: 11, padH: 30, weight: '700' },
    typeScale: { headline: 0.038, subtext: 0.055, company: 0.16, tagline: 0.034, cta: 0.050 },
    anchors: { stackX: 0.50, cta: 'flow' },
    vAlign: 'top', gap: 0.045, vPad: 0.07,
  },
  {
    name: 'Reverse Split',
    minAspect: 2.5, maxAspect: 6,
    textAlign: 'right', headlineWeight: '700', overlayOpacity: 0.42,
    cta: { radius: 999, padV: 12, padH: 32, weight: '600' },
    typeScale: { headline: 0.036, subtext: 0.052, company: 0.14, tagline: 0.032, cta: 0.050 },
    anchors: { stackX: 0.72, cta: { x: 0.20, y: 0.50 } },
    vAlign: 'center', gap: 0.05, vPad: 0.10,
  },
  {
    name: 'Quiet Luxe',
    minAspect: 1.5, maxAspect: 5,
    textAlign: 'center', headlineWeight: '400', overlayOpacity: 0.34,
    cta: { radius: 0, padV: 10, padH: 30, weight: '500' },
    typeScale: { headline: 0.028, subtext: 0.044, company: 0.13, tagline: 0.028, cta: 0.040 },
    anchors: { stackX: 0.50, cta: 'flow' },
    vAlign: 'center', gap: 0.065, vPad: 0.10,
  },
  {
    name: 'Bottom Anchor',
    minAspect: 1.4, maxAspect: 5,
    textAlign: 'left', headlineWeight: '800', overlayOpacity: 0.48,
    cta: { radius: 4, padV: 10, padH: 28, weight: '700' },
    typeScale: { headline: 0.034, subtext: 0.048, company: 0.13, tagline: 0.030, cta: 0.046 },
    anchors: { stackX: 0.28, cta: 'flow' },
    vAlign: 'bottom', gap: 0.045, vPad: 0.07,
  },

  /* ── Split / zoned layouts ─────────────────────────────────────────────── */
  /* Each zone has its own background (image or solid colour) and flows its
   * assigned elements within its own bounds. Elements not listed in any zone
   * are hidden. typeScale fractions are still relative to banner height. */
  {
    name: 'Top Brand Bar',
    minAspect: 1.8, maxAspect: 6,
    textAlign: 'left', headlineWeight: '800', overlayOpacity: 0,
    cta: { radius: 4, padV: 10, padH: 26, weight: '700' },
    typeScale: { headline: 0.050, subtext: 0.048, company: 0.17, tagline: 0.036, cta: 0.052 },
    zones: [
      { bounds: { x: 0, y: 0, w: 1, h: 0.34 }, bg: 'light', textColor: 'dark',
        elements: ['companyName', 'tagline'],
        textAlign: 'left', stackX: 0.05, vAlign: 'center', gap: 0.012, vPad: 0.04 },
      { bounds: { x: 0, y: 0.34, w: 1, h: 0.66 }, bg: 'image',
        elements: ['headline', 'subtext', 'cta'],
        textAlign: 'left', stackX: 0.06, vAlign: 'center', gap: 0.030, vPad: 0.08 },
    ],
    anchors: { stackX: 0.5, cta: 'flow' }, vAlign: 'center', gap: 0.05, vPad: 0.08,
  },
  {
    name: 'Side CTA Panel',
    minAspect: 1.8, maxAspect: 6,
    textAlign: 'left', headlineWeight: '800', overlayOpacity: 0,
    cta: { radius: 4, padV: 12, padH: 28, weight: '700' },
    typeScale: { headline: 0.054, subtext: 0.050, company: 0.13, tagline: 0.036, cta: 0.060 },
    zones: [
      { bounds: { x: 0, y: 0, w: 0.68, h: 1 }, bg: 'image',
        elements: ['companyName', 'headline', 'subtext'],
        textAlign: 'left', stackX: 0.06, vAlign: 'center', gap: 0.040, vPad: 0.10 },
      // Use accent (tagline/secondary brand colour) rather than 'brand' so
      // the CTA button (which uses ctaColor) stays visually distinct.
      { bounds: { x: 0.68, y: 0, w: 0.32, h: 1 }, bg: 'accent', textColor: 'auto',
        elements: ['cta', 'tagline'],
        textAlign: 'center', stackX: 0.5, vAlign: 'center', gap: 0.04, vPad: 0.18 },
    ],
    anchors: { stackX: 0.5, cta: 'flow' }, vAlign: 'center', gap: 0.05, vPad: 0.08,
  },
  {
    name: 'Bottom Info Bar',
    minAspect: 2.0, maxAspect: 6,
    textAlign: 'left', headlineWeight: '800', overlayOpacity: 0,
    cta: { radius: 4, padV: 10, padH: 26, weight: '700' },
    typeScale: { headline: 0.078, subtext: 0.050, company: 0.20, tagline: 0.040, cta: 0.056 },
    zones: [
      { bounds: { x: 0, y: 0, w: 1, h: 0.60 }, bg: 'image',
        elements: ['companyName', 'headline'],
        textAlign: 'left', stackX: 0.05, vAlign: 'center', gap: 0.030, vPad: 0.10 },
      { bounds: { x: 0, y: 0.60, w: 1, h: 0.40 }, bg: 'dark', textColor: 'light',
        elements: ['subtext', 'cta', 'tagline'],
        textAlign: 'left', stackX: 0.06, vAlign: 'center', gap: 0.020, vPad: 0.10 },
    ],
    anchors: { stackX: 0.5, cta: 'flow' }, vAlign: 'center', gap: 0.05, vPad: 0.08,
  },
];

const SLIDER_BOUNDS = {
  headlineSize: [16, 62], subtextSize: [10, 28], companySize: [8, 72],
  taglineSize: [8, 22], ctaFontSize: [10, 36],
};

/* Vertical stacking order (top → bottom) */
const STACK_ORDER = ['companyName', 'headline', 'subtext', 'cta', 'tagline'];
const ELEMENT_IDS = {
  logo:        'previewLogo',
  companyName: 'previewCompanyName',
  headline:    'previewHeadline',
  subtext:     'previewSubtext',
  cta:         'previewCta',
  tagline:     'previewTagline',
};

function isElementVisible(key) {
  // Logo is free-floating — not filtered by zones, not part of the text stack.
  if (key === 'logo') return !!state.showLogo && !!(state.logoBase64 || state.logoUrl);
  // In zoned layouts, only elements assigned to a zone are shown.
  if (state.zones && state.zones.length) {
    const assigned = state.zones.some((z) => z.elements.includes(key));
    if (!assigned) return false;
  }
  if (key === 'companyName') return !!state.showCompanyName && !!state.companyName;
  if (key === 'headline')    return !!state.showHeadline    && !!state.headline;
  if (key === 'subtext')     return !!state.showSubtext     && !!state.subtext;
  if (key === 'cta')         return !!state.showCta;
  if (key === 'tagline')     return !!state.showTagline     && !!state.tagline;
  return false;
}

/* Resolve a zone's named bg to concrete {type, color}. */
function resolveZoneBg(bg) {
  if (bg === 'image') return { type: 'image', color: null };
  const namedColors = {
    brand:     state.ctaColor        || '#6c63ff',
    accent:    state.secondaryColor  || '#f0c040',
    primary:   state.primaryColor    || '#ffffff',
    light:     '#ffffff',
    dark:      '#1a1a2e',
    bg:        state.bgColor         || '#1a1a2e',
  };
  const color = namedColors[bg] || bg;
  return { type: 'color', color };
}

/* Resolve a zone's text colour. 'auto' picks white/black against the bg. */
function resolveZoneTextColor(textColor, zoneBgColor) {
  if (!textColor) return null;
  if (textColor === 'light') return '#ffffff';
  if (textColor === 'dark')  return '#1a1a2e';
  if (textColor === 'auto') {
    if (!zoneBgColor) return null;
    return relativeLuminance(zoneBgColor) > 0.55 ? '#1a1a2e' : '#ffffff';
  }
  return textColor;
}

let _lastStyleIndex = -1;
async function shuffleLayout() {
  const { sourceW: w, sourceH: h } = state.format;
  const aspect = w / h;

  // Styles whose aspect-ratio range fits the current banner
  const eligible = DESIGN_STYLES
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => aspect >= s.minAspect && aspect <= s.maxAspect);
  const pool = eligible.length ? eligible : DESIGN_STYLES.map((s, i) => ({ s, i }));

  // Avoid picking the same style twice in a row
  const filtered = pool.length > 1 ? pool.filter(({ i }) => i !== _lastStyleIndex) : pool;
  const pick = filtered[Math.floor(Math.random() * filtered.length)];
  _lastStyleIndex = pick.i;
  const style = pick.s;

  // Type scale derived from banner height, clamped to slider bounds
  const sized = (ratio, key) => {
    const [min, max] = SLIDER_BOUNDS[key];
    return Math.round(clamp(h * ratio, min, max));
  };

  // Apply style + initial sizes. Positions will be computed after measurement.
  Object.assign(state, {
    textAlign:       style.textAlign,
    headlineWeight:  style.headlineWeight,
    overlayOpacity:  style.overlayOpacity,
    headlineSize:    sized(style.typeScale.headline, 'headlineSize'),
    subtextSize:     sized(style.typeScale.subtext,  'subtextSize'),
    companySize:     sized(style.typeScale.company,  'companySize'),
    taglineSize:     sized(style.typeScale.tagline,  'taglineSize'),
    ctaFontSize:     sized(style.typeScale.cta,      'ctaFontSize'),
    ctaFontWeight:   style.cta.weight,
    ctaBorderRadius: style.cta.radius,
    ctaPaddingV:     style.cta.padV,
    ctaPaddingH:     style.cta.padH,
  });

  // Compute zones (if any) up-front so renderPreview can draw zone bgs and
  // isElementVisible correctly filters out unassigned elements.
  if (style.zones) {
    const zones = style.zones.map((z) => {
      const bg = resolveZoneBg(z.bg);
      return {
        bounds_px: {
          x: Math.round(z.bounds.x * w),
          y: Math.round(z.bounds.y * h),
          w: Math.round(z.bounds.w * w),
          h: Math.round(z.bounds.h * h),
        },
        bg: bg.type,
        color: bg.color,
        textColor: resolveZoneTextColor(z.textColor, bg.color),
        elements: z.elements.slice(),
        textAlign: z.textAlign || style.textAlign,
      };
    });
    state.zones = zones;
    state.elementColors = {};
    state.elementTextAligns = {};
    zones.forEach((z) => {
      z.elements.forEach((k) => {
        if (z.textColor) state.elementColors[k] = z.textColor;
        state.elementTextAligns[k] = z.textAlign;
      });
    });
  } else {
    state.zones = [];
    state.elementColors = {};
    state.elementTextAligns = {};
  }

  // Render once so the DOM reflects the new font sizes / families
  populateEditors();
  renderPreview();

  // Critical: wait for any just-requested web fonts to finish loading before
  // measuring offsetHeight. Otherwise flowStack sees fallback-font metrics
  // and the positions we snapshot won't match the final rendered layout.
  await waitForFontsReady();

  if (style.zones) {
    style.zones.forEach((zCfg, i) => {
      const z = state.zones[i];
      flowZone(z.elements, z.bounds_px, {
        stackX: zCfg.stackX,
        vAlign: zCfg.vAlign,
        gap:    zCfg.gap,
        vPad:   zCfg.vPad,
      });
    });
  } else {
    flowStack(style, w, h);
  }
  renderPreview();

  showToast(`Layout: ${style.name}`);
}

async function waitForFontsReady() {
  await new Promise((r) => requestAnimationFrame(r));
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch (_) { /* ignore */ }
  }
  await new Promise((r) => requestAnimationFrame(r));
}

/* ── Variant picker ──────────────────────────────────────────────────────── */

// State keys captured per variant (layout + typography — NOT colours/image)
const VARIANT_KEYS = [
  'textAlign', 'headlineWeight', 'overlayOpacity',
  'headlineSize', 'subtextSize', 'companySize', 'taglineSize',
  'ctaFontSize', 'ctaFontWeight', 'ctaBorderRadius', 'ctaPaddingV', 'ctaPaddingH',
];

function snapshotVariant() {
  const snap = {
    positions: clonePositions(state.positions),
    zones:             JSON.parse(JSON.stringify(state.zones || [])),
    elementColors:     { ...(state.elementColors || {}) },
    elementTextAligns: { ...(state.elementTextAligns || {}) },
    logoSize:          state.logoSize,
    showLogo:          state.showLogo,
  };
  for (const k of VARIANT_KEYS) snap[k] = state[k];
  return snap;
}

function applyVariant(snap) {
  for (const k of VARIANT_KEYS) state[k] = snap[k];
  state.positions         = JSON.parse(JSON.stringify(snap.positions));
  state.zones             = JSON.parse(JSON.stringify(snap.zones || []));
  state.elementColors     = { ...(snap.elementColors || {}) };
  state.elementTextAligns = { ...(snap.elementTextAligns || {}) };
  if (typeof snap.logoSize === 'number') state.logoSize = snap.logoSize;
  if (typeof snap.showLogo === 'boolean') state.showLogo = snap.showLogo;
  populateEditors();
  renderPreview();
}

async function captureBannerThumbnail() {
  const preview = $('bannerPreview');
  const fmt = state.format;
  const outer = preview.parentElement;

  const savedTransform = preview.style.transform;
  const savedOuterW = outer.style.width;
  const savedOuterH = outer.style.height;
  const savedOuterOverflow = outer.style.overflow;
  preview.style.transform = '';
  outer.style.width  = fmt.sourceW + 'px';
  outer.style.height = fmt.sourceH + 'px';
  outer.style.overflow = 'visible';
  await new Promise((r) => requestAnimationFrame(r));

  try {
    const canvas = await html2canvas(preview, {
      width: fmt.sourceW,
      height: fmt.sourceH,
      scale: 0.4,
      logging: false,
      useCORS: true,
      backgroundColor: state.bgColor,
    });
    return canvas.toDataURL('image/png');
  } finally {
    preview.style.transform = savedTransform;
    outer.style.width  = savedOuterW;
    outer.style.height = savedOuterH;
    outer.style.overflow = savedOuterOverflow;
  }
}

let _generatingVariants = false;
async function showVariantPicker(count = 4) {
  if (_generatingVariants) return;
  _generatingVariants = true;
  const panel = $('variantPanel');
  const grid = $('variantGrid');
  panel.classList.remove('hidden');
  grid.innerHTML = '<p class="empty-hint">Genererer varianter…</p>';

  const snapshots = [];
  const thumbs = [];
  try {
    // Ensure the body font is fully loaded before the first shuffle so
    // offsetHeight measurements aren't poisoned by a fallback-font render.
    await waitForFontsReady();
    for (let i = 0; i < count; i++) {
      await shuffleLayout();
      // Extra settle pass: guarantees the DOM has reflected the newly
      // computed positions before we snapshot + capture.
      await waitForFontsReady();
      snapshots.push(snapshotVariant());
      thumbs.push(await captureBannerThumbnail());
    }
    // Leave variant 0 applied as the active choice
    applyVariant(snapshots[0]);
    renderVariantGrid(snapshots, thumbs, 0);
  } finally {
    _generatingVariants = false;
  }
}

function renderVariantGrid(snapshots, thumbs, activeIndex = 0) {
  const grid = $('variantGrid');
  grid.innerHTML = '';
  snapshots.forEach((snap, i) => {
    const card = document.createElement('button');
    card.className = 'variant-card' + (i === activeIndex ? ' selected' : '');
    card.type = 'button';
    card.innerHTML = `<img src="${thumbs[i]}" alt="Variant ${i + 1}">`;
    card.addEventListener('click', () => {
      applyVariant(snap);
      document.querySelectorAll('.variant-card').forEach((el, j) => {
        el.classList.toggle('selected', j === i);
      });
    });
    grid.appendChild(card);
  });
}

/*
 * flowStack — sequentially place visible stacked elements so they don't overlap.
 * Uses offsetHeight (source pixels, unaffected by ancestor transform:scale).
 * Shrinks font sizes proportionally if the stack exceeds the available height.
 */
function flowStack(style, w, h) {
  const off = style.anchors.cta !== 'flow';
  const stackKeys = STACK_ORDER.filter((k) => {
    if (k === 'cta' && off) return false;
    return isElementVisible(k);
  });

  const gapPx = Math.max(4, Math.round(h * style.gap));
  const vPadPx = Math.round(h * style.vPad);
  const available = Math.max(h * 0.5, h - 2 * vPadPx);

  // Measure rendered heights
  let heights = stackKeys.map((k) => $(ELEMENT_IDS[k]).offsetHeight || 0);
  let totalH = heights.reduce((a, b) => a + b, 0) + gapPx * Math.max(0, stackKeys.length - 1);

  // If stack doesn't fit, shrink font sizes proportionally and re-measure
  if (totalH > available && stackKeys.length > 0) {
    const gapsTotal = gapPx * Math.max(0, stackKeys.length - 1);
    const textBudget = Math.max(1, available - gapsTotal);
    const currentText = Math.max(1, totalH - gapsTotal);
    const scale = textBudget / currentText;

    const shrink = (val, key) => {
      const [min, max] = SLIDER_BOUNDS[key];
      return Math.round(clamp(val * scale, min, max));
    };
    Object.assign(state, {
      headlineSize: shrink(state.headlineSize, 'headlineSize'),
      subtextSize:  shrink(state.subtextSize,  'subtextSize'),
      companySize:  shrink(state.companySize,  'companySize'),
      taglineSize:  shrink(state.taglineSize,  'taglineSize'),
      ctaFontSize:  shrink(state.ctaFontSize,  'ctaFontSize'),
      ctaPaddingV:  Math.max(4, Math.round(state.ctaPaddingV * scale)),
    });
    populateEditors();
    renderPreview();
    heights = stackKeys.map((k) => $(ELEMENT_IDS[k]).offsetHeight || 0);
    totalH = heights.reduce((a, b) => a + b, 0) + gapPx * Math.max(0, stackKeys.length - 1);
  }

  // Compute stack start Y based on vertical alignment
  let startY;
  if (style.vAlign === 'top') {
    startY = vPadPx;
  } else if (style.vAlign === 'bottom') {
    startY = Math.max(vPadPx, h - vPadPx - totalH);
  } else {
    startY = Math.max(vPadPx, (h - totalH) / 2);
  }

  // Sequential cursor placement. Element position is its CENTRE (transform: translate(-50%,-50%)).
  const positions = { ...state.positions };
  const stackX = Math.round(w * style.anchors.stackX);
  let cursor = startY;
  stackKeys.forEach((k, i) => {
    positions[k] = { x: stackX, y: Math.round(cursor + heights[i] / 2) };
    cursor += heights[i] + gapPx;
  });

  // Off-stack CTA (split layouts)
  if (off && isElementVisible('cta')) {
    positions.cta = {
      x: Math.round(w * style.anchors.cta.x),
      y: Math.round(h * style.anchors.cta.y),
    };
  }

  // Keep hidden elements' existing positions (or defaults) so they don't drift
  for (const k of Object.keys(DEFAULT_POSITIONS)) {
    if (!positions[k]) positions[k] = state.positions[k] || DEFAULT_POSITIONS[k];
  }

  state.positions = positions;
}

/* flowZone — like flowStack but constrains elements to a zone rectangle.
 * Used by split-layout styles. The key difference: stackX/vAlign/gap/vPad
 * are interpreted relative to the zone's own bounds, not the whole banner. */
function flowZone(keys, zone, opts) {
  const { x: zx, y: zy, w: zw, h: zh } = zone;
  const elKeys = keys.filter(isElementVisible);
  if (!elKeys.length) return;

  // Preserve STACK_ORDER within the zone
  const stackKeys = STACK_ORDER.filter((k) => elKeys.includes(k));

  const gapPx   = Math.max(4, Math.round(zh * (opts.gap  ?? 0.04)));
  const vPadPx  = Math.round(zh * (opts.vPad ?? 0.08));
  const available = Math.max(zh * 0.4, zh - 2 * vPadPx);

  let heights = stackKeys.map((k) => $(ELEMENT_IDS[k]).offsetHeight || 0);
  let totalH  = heights.reduce((a, b) => a + b, 0) + gapPx * Math.max(0, stackKeys.length - 1);

  // Shrink font sizes of elements in this zone if they overflow
  if (totalH > available && stackKeys.length > 0) {
    const gapsTotal = gapPx * Math.max(0, stackKeys.length - 1);
    const budget = Math.max(1, available - gapsTotal);
    const currentText = Math.max(1, totalH - gapsTotal);
    const scale = Math.max(0.4, budget / currentText);
    const keyToSizeKey = {
      companyName: 'companySize',
      headline:    'headlineSize',
      subtext:     'subtextSize',
      tagline:     'taglineSize',
      cta:         'ctaFontSize',
    };
    const shrink = (val, sk) => {
      const [min, max] = SLIDER_BOUNDS[sk];
      return Math.round(clamp(val * scale, min, max));
    };
    stackKeys.forEach((k) => {
      const sk = keyToSizeKey[k];
      if (sk) state[sk] = shrink(state[sk], sk);
      if (k === 'cta') state.ctaPaddingV = Math.max(4, Math.round(state.ctaPaddingV * scale));
    });
    populateEditors();
    renderPreview();
    heights = stackKeys.map((k) => $(ELEMENT_IDS[k]).offsetHeight || 0);
    totalH  = heights.reduce((a, b) => a + b, 0) + gapPx * Math.max(0, stackKeys.length - 1);
  }

  let startY;
  if (opts.vAlign === 'top')         startY = zy + vPadPx;
  else if (opts.vAlign === 'bottom') startY = zy + Math.max(vPadPx, zh - vPadPx - totalH);
  else                               startY = zy + Math.max(vPadPx, (zh - totalH) / 2);

  const stackX = Math.round(zx + zw * (opts.stackX ?? 0.5));
  const positions = { ...state.positions };
  let cursor = startY;
  stackKeys.forEach((k, i) => {
    positions[k] = { x: stackX, y: Math.round(cursor + heights[i] / 2) };
    cursor += heights[i] + gapPx;
  });

  // Keep unrelated elements' positions untouched
  for (const k of Object.keys(DEFAULT_POSITIONS)) {
    if (!positions[k]) positions[k] = state.positions[k] || DEFAULT_POSITIONS[k];
  }
  state.positions = positions;
}

/* ── Format helpers ──────────────────────────────────────────────────────── */
function computePreviewScale(fmt) {
  const main = document.querySelector('.main-content');
  const availW = (main ? main.clientWidth : window.innerWidth - 320) - 48;
  return Math.min(1, Math.max(0.1, availW / fmt.sourceW));
}

function scalePositions(positions, fromW, fromH, toW, toH) {
  const out = {};
  for (const k of Object.keys(DEFAULT_POSITIONS)) {
    const p = positions[k] || DEFAULT_POSITIONS[k];
    out[k] = { x: Math.round(p.x * toW / fromW), y: Math.round(p.y * toH / fromH) };
  }
  return out;
}

function applyFormat(fmt) {
  const prev = state.format;
  state.positions = scalePositions(state.positions, prev.sourceW, prev.sourceH, fmt.sourceW, fmt.sourceH);
  // Rescale zone pixel bounds to the new format
  if (state.zones && state.zones.length) {
    const sx = fmt.sourceW / prev.sourceW;
    const sy = fmt.sourceH / prev.sourceH;
    state.zones = state.zones.map((z) => ({
      ...z,
      bounds_px: {
        x: Math.round(z.bounds_px.x * sx),
        y: Math.round(z.bounds_px.y * sy),
        w: Math.round(z.bounds_px.w * sx),
        h: Math.round(z.bounds_px.h * sy),
      },
    }));
  }
  state.format = fmt;
  state.previewScale = computePreviewScale(fmt);

  const preview = $('bannerPreview');
  preview.style.width  = fmt.sourceW + 'px';
  preview.style.height = fmt.sourceH + 'px';
  preview.style.transformOrigin = 'top left';
  preview.style.transform = state.previewScale < 1 ? `scale(${state.previewScale})` : '';

  const outer = preview.parentElement;
  outer.style.width  = Math.round(fmt.sourceW * state.previewScale) + 'px';
  outer.style.height = Math.round(fmt.sourceH * state.previewScale) + 'px';

  renderPreview();
}

/* Render (or clear) zone background divs inside bannerPreview. Zones with
 * bg: 'image' are skipped — the preview's own background photo shows through. */
function renderZones(preview) {
  // Remove previously rendered zone divs
  preview.querySelectorAll('.banner-zone').forEach((el) => el.remove());
  if (!state.zones || !state.zones.length) return;

  const frag = document.createDocumentFragment();
  state.zones.forEach((z, i) => {
    const div = document.createElement('div');
    div.className = 'banner-zone';
    div.dataset.zoneIndex = String(i);
    div.style.left   = z.bounds_px.x + 'px';
    div.style.top    = z.bounds_px.y + 'px';
    div.style.width  = z.bounds_px.w + 'px';
    div.style.height = z.bounds_px.h + 'px';
    if (z.bg === 'color') {
      div.style.backgroundColor = z.color;
    } else {
      // Image zone — let the preview's photo show through
      div.style.backgroundColor = 'transparent';
    }
    frag.appendChild(div);
  });
  // Insert at the beginning so overlay (z:1) and text (z:2) stack above
  preview.insertBefore(frag, preview.firstChild);
}

/* Resolve effective text colour / alignment for an element, honouring zone
 * overrides when the current style is zoned. */
function effectiveTextColor(key, fallback) {
  return (state.elementColors && state.elementColors[key]) || fallback;
}
function effectiveTextAlign(key) {
  return (state.elementTextAligns && state.elementTextAligns[key]) || state.textAlign;
}

/* Render color pickers for each solid-color zone in the current layout.
 * Called by populateEditors; hides itself when no color zones exist. */
function renderZoneColorControls() {
  const section = $('zoneColorsSection');
  const container = $('zoneColorsContainer');
  if (!section || !container) return;

  const colorZoneIndices = (state.zones || [])
    .map((z, i) => ({ z, i }))
    .filter(({ z }) => z.bg === 'color');

  if (!colorZoneIndices.length) {
    section.style.display = 'none';
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  section.style.display = '';
  container.style.display = '';
  container.innerHTML = '';

  colorZoneIndices.forEach(({ z, i }) => {
    const row = document.createElement('div');
    row.className = 'zone-color-row';
    // A descriptive label based on which elements live in the zone
    const labels = (z.elements || []).slice(0, 2).join(' + ') || `Zone ${i + 1}`;
    row.innerHTML = `
      <span class="zone-color-label">${labels}</span>
      <input type="color" class="zone-color-picker" data-zone-index="${i}" value="${z.color}">
      <input type="text" class="hex-input zone-color-hex" data-zone-index="${i}" value="${z.color}" maxlength="7">
    `;
    container.appendChild(row);
  });

  container.querySelectorAll('.zone-color-picker, .zone-color-hex')
    .forEach((el) => el.addEventListener('input', handleZoneColorChange));
}

function handleZoneColorChange(e) {
  const idx = parseInt(e.target.dataset.zoneIndex, 10);
  const zone = state.zones?.[idx];
  if (!zone) return;
  const val = e.target.value.trim();
  if (!/^#[0-9a-f]{6}$/i.test(val)) return;

  const oldTextColor = zone.textColor;
  zone.color = val;

  // Re-pick text colour against the new bg so labels stay readable. Any element
  // text colour that still matches the previous auto-pick follows along.
  const newTextColor = relativeLuminance(val) > 0.55 ? '#1a1a2e' : '#ffffff';
  if (oldTextColor && oldTextColor.toLowerCase() !== newTextColor.toLowerCase()) {
    zone.textColor = newTextColor;
    (zone.elements || []).forEach((key) => {
      if (state.elementColors[key] &&
          state.elementColors[key].toLowerCase() === oldTextColor.toLowerCase()) {
        state.elementColors[key] = newTextColor;
      }
    });
  }

  // Sync the sibling input (hex ↔ picker)
  document.querySelectorAll(`[data-zone-index="${idx}"]`).forEach((s) => {
    if (s !== e.target && s.value !== val) s.value = val;
  });
  renderPreview();
}

/* ── Render ──────────────────────────────────────────────────────────────── */
function renderPreview() {
  const preview = $('bannerPreview');
  const overlay = $('bannerOverlay');

  // Fonts — body/primary for the whole preview; headlineFont (if distinct)
  // gets applied to headline+company below for a typographic hierarchy.
  if (state.fontFamily) {
    loadGoogleFont(state.fontFamily);
    preview.style.fontFamily = `'${state.fontFamily}', sans-serif`;
  } else {
    preview.style.fontFamily = '';
  }
  const headlineFontStack = state.headlineFont
    ? `'${state.headlineFont}', ${state.fontFamily ? `'${state.fontFamily}', ` : ''}sans-serif`
    : '';
  if (state.headlineFont) loadGoogleFont(state.headlineFont);

  // Background
  preview.style.backgroundImage = state.selectedImageBase64
    ? `url(${state.selectedImageBase64})` : 'none';
  preview.style.backgroundColor = state.bgColor;
  preview.style.backgroundRepeat = 'no-repeat';
  preview.style.backgroundSize = state.imageFit === 'fill'
    ? '100% 100%'
    : (state.imageFit || 'cover');
  preview.style.backgroundPosition = `${state.imagePosX ?? 50}% ${state.imagePosY ?? 50}%`;
  preview.classList.toggle('bg-draggable', !!state.selectedImageBase64 && state.imageFit === 'cover');

  // Zones (split layouts) — render before overlay so text (z:2) stays on top.
  renderZones(preview);

  // Overlay — zoned layouts handle contrast per-zone, so skip the global overlay.
  const zoned = state.zones && state.zones.length > 0;
  if (state.showOverlay && !zoned) {
    const { r, g, b } = hexToRgb(state.overlayColor);
    overlay.style.backgroundColor = `rgba(${r},${g},${b},${state.overlayOpacity})`;
  } else {
    overlay.style.backgroundColor = 'transparent';
  }

  // ── Position + style each draggable element ──────────────────────────────
  const pos = state.positions;


  // Company name
  const company = $('previewCompanyName');
  company.textContent = state.companyName;
  const companyColor = effectiveTextColor('companyName', state.primaryColor);
  company.style.color = companyColor;
  company.style.fontSize = state.companySize + 'px';
  company.style.fontFamily = headlineFontStack || '';
  company.style.left = pos.companyName.x + 'px';
  company.style.top  = pos.companyName.y + 'px';
  company.style.textAlign = effectiveTextAlign('companyName');
  company.style.background = '';
  company.style.padding = '';
  company.style.borderRadius = '';
  company.style.boxShadow = '';
  company.style.textShadow = textGlyphShadow(companyColor);
  company.style.display = isElementVisible('companyName') ? '' : 'none';

  // Headline
  const headline = $('previewHeadline');
  headline.textContent = state.headline;
  const headlineColor = effectiveTextColor('headline', state.primaryColor);
  headline.style.color = headlineColor;
  headline.style.fontSize = state.headlineSize + 'px';
  headline.style.fontWeight = state.headlineWeight;
  headline.style.fontFamily = headlineFontStack || '';
  headline.style.left = pos.headline.x + 'px';
  headline.style.top  = pos.headline.y + 'px';
  headline.style.textAlign = effectiveTextAlign('headline');
  headline.style.background = '';
  headline.style.padding = '';
  headline.style.borderRadius = '';
  headline.style.boxShadow = '';
  headline.style.textShadow = textGlyphShadow(headlineColor);
  headline.style.display = isElementVisible('headline') ? '' : 'none';

  // Subtext
  const subtext = $('previewSubtext');
  subtext.textContent = state.subtext;
  const subtextColor = effectiveTextColor('subtext', state.primaryColor);
  subtext.style.color = subtextColor;
  subtext.style.fontSize = state.subtextSize + 'px';
  subtext.style.left = pos.subtext.x + 'px';
  subtext.style.top  = pos.subtext.y + 'px';
  subtext.style.textAlign = effectiveTextAlign('subtext');
  subtext.style.background = '';
  subtext.style.padding = '';
  subtext.style.borderRadius = '';
  subtext.style.boxShadow = '';
  subtext.style.textShadow = textGlyphShadow(subtextColor);
  subtext.style.display = isElementVisible('subtext') ? '' : 'none';

  // CTA
  const cta = $('previewCta');
  cta.textContent = state.ctaText;
  cta.style.backgroundColor = state.ctaColor;
  cta.style.color = state.ctaTextColor;
  cta.style.fontSize = state.ctaFontSize + 'px';
  cta.style.fontWeight = state.ctaFontWeight;
  cta.style.borderRadius = state.ctaBorderRadius + 'px';
  cta.style.padding = `${state.ctaPaddingV}px ${state.ctaPaddingH}px`;
  cta.style.left = pos.cta.x + 'px';
  cta.style.top  = pos.cta.y + 'px';
  cta.style.display = isElementVisible('cta') ? '' : 'none';

  // Logo (free-floating image, not part of the text stack)
  const logo = $('previewLogo');
  const logoSrc = state.logoBase64 || state.logoUrl || '';
  if (logoSrc) logo.src = logoSrc;
  logo.style.height = (state.logoSize || 56) + 'px';
  logo.style.width = 'auto';
  logo.style.left = (pos.logo?.x ?? DEFAULT_POSITIONS.logo.x) + 'px';
  logo.style.top  = (pos.logo?.y ?? DEFAULT_POSITIONS.logo.y) + 'px';
  logo.style.display = isElementVisible('logo') ? '' : 'none';

  // Tagline
  const tagline = $('previewTagline');
  tagline.textContent = state.tagline;
  const taglineColor = effectiveTextColor('tagline', state.secondaryColor);
  tagline.style.color = taglineColor;
  tagline.style.fontSize = state.taglineSize + 'px';
  tagline.style.left = pos.tagline.x + 'px';
  tagline.style.top  = pos.tagline.y + 'px';
  tagline.style.textAlign = effectiveTextAlign('tagline');
  tagline.style.background = '';
  tagline.style.padding = '';
  tagline.style.borderRadius = '';
  tagline.style.boxShadow = '';
  tagline.style.textShadow = textGlyphShadow(taglineColor);
  tagline.style.display = isElementVisible('tagline') ? '' : 'none';
}

/* ── Drag to reposition ──────────────────────────────────────────────────── */
const drag = { active: false, key: null, offsetX: 0, offsetY: 0, mode: null, startX: 0, startY: 0, startPosX: 50, startPosY: 50 };

function initDragging() {
  const preview = $('bannerPreview');

  preview.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.banner-el');
    if (el) {
      e.preventDefault();

      const key = el.dataset.element;
      const rect = preview.getBoundingClientRect();
      const pos = state.positions[key];

      drag.active  = true;
      drag.mode    = 'element';
      drag.key     = key;
      drag.offsetX = (e.clientX - rect.left) / state.previewScale - pos.x;
      drag.offsetY = (e.clientY - rect.top)  / state.previewScale - pos.y;

      el.classList.add('is-dragging');
      preview.classList.add('is-dragging');
      return;
    }

    // Background drag — only meaningful in 'cover' mode (where image is cropped).
    if (state.selectedImageBase64 && state.imageFit === 'cover') {
      e.preventDefault();
      const rect = preview.getBoundingClientRect();
      drag.active   = true;
      drag.mode     = 'bg';
      drag.key      = null;
      drag.startX   = e.clientX;
      drag.startY   = e.clientY;
      drag.startPosX = state.imagePosX ?? 50;
      drag.startPosY = state.imagePosY ?? 50;
      drag._rectW = rect.width;
      drag._rectH = rect.height;
      preview.classList.add('bg-dragging');
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!drag.active) return;

    if (drag.mode === 'element') {
      const rect = $('bannerPreview').getBoundingClientRect();
      const x = clamp((e.clientX - rect.left) / state.previewScale - drag.offsetX, 0, state.format.sourceW);
      const y = clamp((e.clientY - rect.top)  / state.previewScale - drag.offsetY, 0, state.format.sourceH);

      state.positions[drag.key] = { x, y };
      renderPreview();
    } else if (drag.mode === 'bg') {
      // Invert delta: dragging right should reveal what's to the right,
      // i.e. move background-position toward 0% (left edge of image).
      const dxPct = ((e.clientX - drag.startX) / drag._rectW) * 100;
      const dyPct = ((e.clientY - drag.startY) / drag._rectH) * 100;
      state.imagePosX = clamp(drag.startPosX - dxPct, 0, 100);
      state.imagePosY = clamp(drag.startPosY - dyPct, 0, 100);
      renderPreview();
    }
  });

  document.addEventListener('mouseup', () => {
    if (!drag.active) return;
    const preview = $('bannerPreview');
    if (drag.mode === 'element') {
      document.querySelector(`[data-element="${drag.key}"]`)
        ?.classList.remove('is-dragging');
      preview.classList.remove('is-dragging');
    } else if (drag.mode === 'bg') {
      preview.classList.remove('bg-dragging');
    }
    drag.active = false;
    drag.key    = null;
    drag.mode   = null;
  });
}

/* ── Sync editors → state → render ──────────────────────────────────────── */
function syncFromEditors() {
  state.companyName   = $('editCompanyName').value;
  state.headline      = $('editHeadline').value;
  state.subtext       = $('editSubtext').value;
  state.tagline       = $('editTagline').value;
  state.ctaText       = $('editCta').value;
  state.showCompanyName = $('editShowCompanyName').checked;
  state.showHeadline    = $('editShowHeadline').checked;
  state.showSubtext     = $('editShowSubtext').checked;
  state.showTagline     = $('editShowTagline').checked;
  state.showCta         = $('editShowCta').checked;
  state.showLogo        = $('editShowLogo').checked;
  state.logoSize        = parseInt($('editLogoSize').value, 10);
  $('logoSizeValue').textContent = state.logoSize + 'px';

  state.primaryColor  = $('editPrimaryColor').value;
  state.secondaryColor = $('editSecondaryColor').value;
  state.ctaColor      = $('editCtaColor').value;
  state.showOverlay   = $('editShowOverlay').checked;
  state.overlayColor  = $('editOverlayColor').value;
  state.overlayOpacity = parseFloat($('editOverlayOpacity').value);
  state.bgColor       = $('editBgColor').value;

  state.ctaTextColor    = $('editCtaTextColor').value;
  state.ctaFontSize     = parseInt($('editCtaFontSize').value, 10);
  state.ctaBorderRadius = parseInt($('editCtaBorderRadius').value, 10);
  state.ctaPaddingV     = parseInt($('editCtaPaddingV').value, 10);
  state.ctaPaddingH     = parseInt($('editCtaPaddingH').value, 10);
  state.ctaFontWeight   = $('editCtaFontWeight').value;

  state.headlineSize  = parseInt($('editHeadlineSize').value, 10);
  state.subtextSize   = parseInt($('editSubtextSize').value, 10);
  state.companySize   = parseInt($('editCompanySize').value, 10);
  state.taglineSize   = parseInt($('editTaglineSize').value, 10);
  state.headlineWeight = $('editHeadlineWeight').value;
  state.textAlign     = $('editTextAlign').value;
  state.fontFamily    = $('editFontFamily').value.trim();

  // Update range labels
  $('opacityValue').textContent       = Math.round(state.overlayOpacity * 100) + '%';
  $('headlineSizeValue').textContent  = state.headlineSize + 'px';
  $('subtextSizeValue').textContent   = state.subtextSize + 'px';
  $('companySizeValue').textContent   = state.companySize + 'px';
  $('taglineSizeValue').textContent   = state.taglineSize + 'px';
  $('ctaFontSizeValue').textContent   = state.ctaFontSize + 'px';
  $('ctaRadiusValue').textContent     = state.ctaBorderRadius + 'px';
  $('ctaPaddingVValue').textContent   = state.ctaPaddingV + 'px';
  $('ctaPaddingHValue').textContent   = state.ctaPaddingH + 'px';

  // Sync hex inputs with color pickers
  $('editPrimaryColorHex').value    = state.primaryColor;
  $('editSecondaryColorHex').value  = state.secondaryColor;
  $('editCtaColorHex').value        = state.ctaColor;
  $('editOverlayColorHex').value    = state.overlayColor;
  $('editBgColorHex').value         = state.bgColor;
  $('editCtaTextColorHex').value    = state.ctaTextColor;

  renderPreview();
}

/* ── Push state → editors ────────────────────────────────────────────────── */
function populateEditors() {
  $('editCompanyName').value  = state.companyName;
  $('editHeadline').value     = state.headline;
  $('editSubtext').value      = state.subtext;
  $('editTagline').value      = state.tagline;
  $('editCta').value          = state.ctaText;
  $('editShowCompanyName').checked = state.showCompanyName;
  $('editShowHeadline').checked    = state.showHeadline;
  $('editShowSubtext').checked     = state.showSubtext;
  $('editShowTagline').checked     = state.showTagline;
  $('editShowCta').checked         = state.showCta;
  $('editShowLogo').checked        = state.showLogo;
  $('editLogoSize').value          = state.logoSize;
  $('logoSizeValue').textContent   = state.logoSize + 'px';
  syncLogoPreview();

  $('editPrimaryColor').value   = state.primaryColor;
  $('editSecondaryColor').value = state.secondaryColor;
  $('editCtaColor').value       = state.ctaColor;
  $('editShowOverlay').checked  = state.showOverlay;
  $('editOverlayColor').value   = state.overlayColor;
  $('editOverlayOpacity').value = state.overlayOpacity;
  $('editBgColor').value        = state.bgColor;

  $('editPrimaryColorHex').value   = state.primaryColor;
  $('editSecondaryColorHex').value = state.secondaryColor;
  $('editCtaColorHex').value       = state.ctaColor;
  $('editOverlayColorHex').value   = state.overlayColor;
  $('editBgColorHex').value        = state.bgColor;

  $('editCtaTextColor').value       = state.ctaTextColor;
  $('editCtaTextColorHex').value    = state.ctaTextColor;
  $('editCtaFontSize').value        = state.ctaFontSize;
  $('editCtaBorderRadius').value    = state.ctaBorderRadius;
  $('editCtaPaddingV').value        = state.ctaPaddingV;
  $('editCtaPaddingH').value        = state.ctaPaddingH;
  $('editCtaFontWeight').value      = state.ctaFontWeight;

  $('editHeadlineSize').value  = state.headlineSize;
  $('editSubtextSize').value   = state.subtextSize;
  $('editCompanySize').value   = state.companySize;
  $('editTaglineSize').value   = state.taglineSize;
  $('editHeadlineWeight').value = state.headlineWeight;
  $('editTextAlign').value     = state.textAlign;
  $('editFontFamily').value    = state.fontFamily || '';

  $('opacityValue').textContent      = Math.round(state.overlayOpacity * 100) + '%';
  $('headlineSizeValue').textContent = state.headlineSize + 'px';
  $('subtextSizeValue').textContent  = state.subtextSize + 'px';
  $('companySizeValue').textContent  = state.companySize + 'px';
  $('taglineSizeValue').textContent  = state.taglineSize + 'px';
  $('ctaFontSizeValue').textContent  = state.ctaFontSize + 'px';
  $('ctaRadiusValue').textContent    = state.ctaBorderRadius + 'px';
  $('ctaPaddingVValue').textContent  = state.ctaPaddingV + 'px';
  $('ctaPaddingHValue').textContent  = state.ctaPaddingH + 'px';

  $('bannerName').value = state.bannerName || state.companyName || '';
  syncFitButtons();
  renderZoneColorControls();
}

function syncFitButtons() {
  const current = state.imageFit || 'cover';
  document.querySelectorAll('#imageFitControls .btn-fit').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.fit === current);
  });
}

/* ── Analyze ─────────────────────────────────────────────────────────────── */
async function handleAnalyze(e) {
  e.preventDefault();
  const websiteUrl   = $('websiteUrl').value.trim();
  const imageUrl     = $('imageUrl').value.trim();
  const companyName  = $('analyzeCompanyName').value.trim();
  const businessType = $('analyzeBusinessType').value.trim();

  if (!websiteUrl && !imageUrl && !companyName && !businessType) {
    showError('Please provide at least one input (website URL, image URL, company name, or business type).');
    return;
  }

  setLoading(true);
  clearError();

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        websiteUrl:   websiteUrl   || undefined,
        imageUrl:     imageUrl     || undefined,
        companyName:  companyName  || undefined,
        businessType: businessType || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed');

    const { analysis, images, logos = [] } = data;

    // Apply Claude's suggestions to state
    Object.assign(state, {
      companyName:    analysis.companyName   || '',
      headline:       analysis.headline      || '',
      subtext:        analysis.subtext       || '',
      tagline:        analysis.tagline       || '',
      ctaText:        analysis.ctaText       || 'Learn More',
      primaryColor:   isHex(analysis.primaryColor)   ? analysis.primaryColor   : '#ffffff',
      secondaryColor: isHex(analysis.secondaryColor) ? analysis.secondaryColor : '#f0c040',
      overlayColor:   isHex(analysis.overlayColor)   ? analysis.overlayColor   : '#000000',
      overlayOpacity: clamp(parseFloat(analysis.overlayOpacity) || 0.5, 0, 1),
      ctaColor:       isHex(analysis.ctaColor)       ? analysis.ctaColor       : (isHex(analysis.secondaryColor) ? analysis.secondaryColor : '#6c63ff'),
      fontFamily:     analysis.fontFamily || '',
      headlineFont:   analysis.headlineFont || '',
      images:         images.map((url) => ({ url, base64: null })),
      showCompanyName: true,
      showHeadline:    true,
      showSubtext:     false,
      showTagline:     false,
      showCta:         true,
      showOverlay:     false,
      selectedImageBase64: null,
      imageAvgColor:   null,
      imagePixels:     [],
      imageFit:        'cover',
      imagePosX:       50,
      imagePosY:       50,
      logoUrl:         null,
      logoBase64:      null,
      showLogo:        false,
      logoSize:        56,
      currentBannerId: null,
      bannerName:     analysis.companyName || '',
      positions:      scalePositions(clonePositions(), FORMATS[0].sourceW, FORMATS[0].sourceH, state.format.sourceW, state.format.sourceH),
      zones:          [],
      elementColors:  {},
      elementTextAligns: {},
    });

    // Server already prepends the manually entered image URL; just ensure
    // it's in the local state list if the server somehow dropped it.
    if (imageUrl && !state.images.some((i) => i.url === imageUrl)) {
      state.images.unshift({ url: imageUrl, base64: null });
      images.unshift(imageUrl);
    }

    // First pass: fix contrast against bgColor fallback (will re-check once
    // an image is selected, since the avg image colour may differ)
    ensureReadableColors();

    populateEditors();
    renderPreview();
    renderImageGrid(images);
    renderLogoGrid(logos);

    $('imagePanel').classList.remove('hidden');
    $('editorPanel').classList.add('hidden');            // hide full editor — user enters via "Tilpas"
    $('variantPanel').classList.add('hidden');           // will be shown by showVariantPicker
    state._pendingVariants = true;

    // Auto-select the first image (manual URL takes priority if provided)
    if (images.length > 0) selectImage(images[0]);
    else {
      // No image → still show variants against solid bg
      $('quickActions').classList.remove('hidden');
      state._pendingVariants = false;
      showVariantPicker(4);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

/* ── Image selection ─────────────────────────────────────────────────────── */
function renderImageGrid(imageUrls) {
  const grid = $('imageGrid');
  grid.innerHTML = '';
  imageUrls.forEach((url) => {
    const img = document.createElement('img');
    img.src = url;
    img.className = 'image-thumb';
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('click', () => selectImage(url));
    img.addEventListener('error', () => img.style.display = 'none');
    grid.appendChild(img);
  });
}

/* ── Logo element (free-floating overlay on top of background) ───────────── */

// Fetch a logo URL as base64 (via /api/image-base64) and install it as the
// banner's logo element. Automatically toggles showLogo on.
async function setLogo(url) {
  if (!url) return;
  try {
    const res = await fetch('/api/image-base64?url=' + encodeURIComponent(url));
    if (!res.ok) throw new Error('Could not load logo');
    const { dataUrl } = await res.json();
    state.logoUrl    = url;
    state.logoBase64 = dataUrl;
    state.showLogo   = true;
    populateEditors();
    renderPreview();
    showToast('Logo added. Drag to reposition.');
  } catch (err) {
    showError('Could not load that logo: ' + err.message);
  }
}

function clearLogo() {
  state.logoUrl    = null;
  state.logoBase64 = null;
  state.showLogo   = false;
  populateEditors();
  renderPreview();
}

// Reflect current logo state in the editor's preview thumbnail + clear button.
function syncLogoPreview() {
  const thumb = $('logoPreviewThumb');
  const empty = $('logoPreviewEmpty');
  const clear = $('clearLogoBtn');
  const urlInput = $('editLogoUrl');
  if (!thumb || !empty || !clear) return;
  const src = state.logoBase64 || state.logoUrl;
  if (src) {
    thumb.src = src;
    thumb.style.display = '';
    empty.style.display = 'none';
    clear.style.display = '';
    if (urlInput && state.logoUrl) urlInput.value = state.logoUrl;
  } else {
    thumb.src = '';
    thumb.style.display = 'none';
    empty.style.display = '';
    clear.style.display = 'none';
    if (urlInput) urlInput.value = '';
  }
}

/* ── Logo grid (scraped from site) ───────────────────────────────────────── */
function renderLogoGrid(logoUrls) {
  const section = $('logoSection');
  const grid = $('logoGrid');
  state.scrapedLogos = logoUrls || [];
  grid.innerHTML = '';
  if (!logoUrls || !logoUrls.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  logoUrls.forEach((url) => {
    const img = document.createElement('img');
    img.src = url;
    img.className = 'logo-thumb';
    img.alt = 'Logo';
    img.loading = 'lazy';
    img.title = 'Klik for at lægge logoet oven på banneret';
    img.addEventListener('click', () => setLogo(url));
    img.addEventListener('error', () => img.style.display = 'none');
    grid.appendChild(img);
  });
}

/* ── Local file upload ───────────────────────────────────────────────────── */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

async function handleFileUpload(e) {
  const input = e.target;
  const file = input.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showError('Vælg venligst en billedfil.');
    input.value = '';
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showError('Billedet er for stort (maks 20MB).');
    input.value = '';
    return;
  }
  try {
    const dataUrl = await readFileAsDataURL(file);
    // Store the data URL as both url (key) and base64 (cached payload) so
    // selectImage hits its cache path and skips the /api/image-base64 hop.
    if (!state.images.some((i) => i.url === dataUrl)) {
      state.images.push({ url: dataUrl, base64: dataUrl });
    }
    renderImageGrid(state.images.map((i) => i.url));
    $('imagePanel').classList.remove('hidden');
    await selectImage(dataUrl);
    showToast(`Uploadet: ${file.name}`);
  } catch (err) {
    showError('Upload fejlede: ' + err.message);
  } finally {
    // Clear so the same file can be re-picked to trigger change again
    input.value = '';
  }
}

/* ── Pixabay search ──────────────────────────────────────────────────────── */
async function runPixabaySearch() {
  const q = $('pixabayQuery').value.trim();
  const results = $('pixabayResults');
  const credit = $('pixabayCredit');
  if (!q) { results.innerHTML = ''; credit.style.display = 'none'; return; }

  // Pick orientation based on current banner format's aspect ratio
  const fmt = state.format;
  const aspect = fmt.sourceW / fmt.sourceH;
  const orientation = aspect > 1.2 ? 'horizontal' : aspect < 0.9 ? 'vertical' : 'all';

  results.innerHTML = '<p class="empty-hint">Søger…</p>';
  try {
    const url = `/api/pixabay-search?q=${encodeURIComponent(q)}&orientation=${orientation}&per_page=24`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');

    if (!data.hits.length) {
      results.innerHTML = '<p class="empty-hint">Ingen resultater</p>';
      credit.style.display = 'none';
      return;
    }

    results.innerHTML = '';
    data.hits.forEach((hit) => {
      const img = document.createElement('img');
      img.src = hit.previewURL;
      img.className = 'image-thumb';
      img.alt = hit.tags || '';
      img.title = `${hit.tags} — by ${hit.user}`;
      img.loading = 'lazy';
      // Use webformatURL for actual banner — previewURL is only ~150px.
      img.addEventListener('click', () => {
        const url = hit.webformatURL;
        if (!state.images.some((i) => i.url === url)) {
          state.images.push({ url, base64: null });
          renderImageGrid([...state.images.map((i) => i.url)]);
        }
        selectImage(url);
      });
      img.addEventListener('error', () => img.style.display = 'none');
      results.appendChild(img);
    });
    credit.style.display = '';
  } catch (err) {
    results.innerHTML = `<p class="empty-hint">Fejl: ${err.message}</p>`;
    credit.style.display = 'none';
  }
}

async function selectImage(url) {
  // Highlight selected thumbnail
  document.querySelectorAll('.image-thumb').forEach((el) => {
    el.classList.toggle('selected', el.src === url);
  });

  const applyImage = async (dataUrl) => {
    state.selectedImageBase64 = dataUrl;
    const { avg, samples } = await sampleImagePixels(dataUrl);
    state.imageAvgColor = avg;
    state.imagePixels   = samples;
    const changes = ensureReadableColors();
    populateEditors();
    renderPreview();
    if (changes.length) showToast(`Adjusted ${changes.join(' & ')} colour for readability`);
    $('quickActions').classList.remove('hidden');
    if (state._pendingVariants) {
      state._pendingVariants = false;
      showVariantPicker(4);
    }
  };

  // Check cache
  const cached = state.images.find((i) => i.url === url);
  if (cached && cached.base64) {
    await applyImage(cached.base64);
    return;
  }

  try {
    const res = await fetch('/api/image-base64?url=' + encodeURIComponent(url));
    if (!res.ok) throw new Error('Could not load image');
    const { dataUrl } = await res.json();

    // Cache
    const entry = state.images.find((i) => i.url === url);
    if (entry) entry.base64 = dataUrl;
    else state.images.push({ url, base64: dataUrl });

    await applyImage(dataUrl);
  } catch (err) {
    console.warn('Image load failed:', err.message);
    showError('Could not load that image. Try another.');
  }
}

/* ── Save ────────────────────────────────────────────────────────────────── */
async function handleSave() {
  const name = $('bannerName').value.trim() || state.companyName || 'Untitled Banner';
  const payload = {
    name,
    companyName: state.companyName,
    headline: state.headline,
    subtext: state.subtext,
    tagline: state.tagline,
    ctaText: state.ctaText,
    showCompanyName: state.showCompanyName,
    showHeadline: state.showHeadline,
    showSubtext: state.showSubtext,
    showTagline: state.showTagline,
    showCta: state.showCta,
    primaryColor: state.primaryColor,
    secondaryColor: state.secondaryColor,
    ctaColor: state.ctaColor,
    showOverlay: state.showOverlay,
    overlayColor: state.overlayColor,
    overlayOpacity: state.overlayOpacity,
    bgColor: state.bgColor,
    headlineSize: state.headlineSize,
    subtextSize: state.subtextSize,
    companySize: state.companySize,
    taglineSize: state.taglineSize,
    headlineWeight: state.headlineWeight,
    textAlign: state.textAlign,
    fontFamily: state.fontFamily,
    headlineFont: state.headlineFont,
    ctaTextColor: state.ctaTextColor,
    ctaFontSize: state.ctaFontSize,
    ctaBorderRadius: state.ctaBorderRadius,
    ctaPaddingV: state.ctaPaddingV,
    ctaPaddingH: state.ctaPaddingH,
    ctaFontWeight: state.ctaFontWeight,
    selectedImageBase64: state.selectedImageBase64,
    imageFit: state.imageFit,
    imagePosX: state.imagePosX,
    imagePosY: state.imagePosY,
    logoUrl: state.logoUrl,
    logoBase64: state.logoBase64,
    showLogo: state.showLogo,
    logoSize: state.logoSize,
    imageUrls: state.images.map((i) => i.url),
    positions: state.positions,
    zones: state.zones,
    elementColors: state.elementColors,
    elementTextAligns: state.elementTextAligns,
  };

  try {
    const isUpdate = !!state.currentBannerId;
    const url = isUpdate ? `/api/banners/${state.currentBannerId}` : '/api/banners';
    const method = isUpdate ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Save failed');

    const saved = await res.json();
    state.currentBannerId = saved.id;
    state.bannerName = name;

    showToast(isUpdate ? 'Banner updated!' : 'Banner saved!');
    loadSavedBanners();
  } catch (err) {
    showError('Save failed: ' + err.message);
  }
}

/* ── Download ────────────────────────────────────────────────────────────── */
async function handleDownload() {
  const btn = $('downloadBtn');
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const preview = $('bannerPreview');
    const fmt = state.format;
    const outer = preview.parentElement;

    // Temporarily remove CSS transform so html2canvas captures at source resolution
    const savedTransform = preview.style.transform;
    const savedOuterW = outer.style.width;
    const savedOuterH = outer.style.height;
    const savedOuterOverflow = outer.style.overflow;
    preview.style.transform = '';
    outer.style.width  = fmt.sourceW + 'px';
    outer.style.height = fmt.sourceH + 'px';
    outer.style.overflow = 'visible';
    await new Promise(r => requestAnimationFrame(r));

    const canvas = await html2canvas(preview, {
      width: fmt.sourceW,
      height: fmt.sourceH,
      scale: 1,
      useCORS: false,
      allowTaint: false,
      logging: false,
      backgroundColor: state.bgColor,
    });

    // Restore visual state
    preview.style.transform = savedTransform;
    outer.style.width  = savedOuterW;
    outer.style.height = savedOuterH;
    outer.style.overflow = savedOuterOverflow;

    const link = document.createElement('a');
    const safeName = (state.bannerName || state.companyName || 'banner')
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase();
    link.download = `banner_${safeName}_${fmt.id}_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch (err) {
    showError('Download failed: ' + err.message);
  } finally {
    btn.textContent = 'Download PNG';
    btn.disabled = false;
  }
}

/* ── Saved banners ───────────────────────────────────────────────────────── */
async function loadSavedBanners() {
  try {
    const res = await fetch('/api/banners');
    const banners = await res.json();
    renderSavedBanners(banners);
  } catch {
    // Silently ignore if server not ready
  }
}

function renderSavedBanners(banners) {
  const list = $('savedBannersList');
  if (!banners.length) {
    list.innerHTML = '<p class="empty-hint">No saved banners yet.</p>';
    return;
  }

  list.innerHTML = banners
    .map((b) => {
      const date = new Date(b.updatedAt || b.savedAt).toLocaleDateString('da-DK', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
      const thumbStyle = b.selectedImageBase64
        ? `background-image:url(${b.selectedImageBase64.slice(0, 80)}...); background-color:${b.bgColor || '#1a1a2e'}`
        : `background-color:${b.bgColor || '#1a1a2e'}`;

      return `<div class="saved-item" data-id="${escHtml(b.id)}">
        <div class="saved-thumb" style="${thumbStyle}"></div>
        <div class="saved-info">
          <div class="saved-name">${escHtml(b.name || b.companyName || 'Untitled')}</div>
          <div class="saved-date">${date}</div>
        </div>
        <button class="btn btn-danger" data-delete="${escHtml(b.id)}" title="Delete">&#10005;</button>
      </div>`;
    })
    .join('');
}

function handleSavedItemClick(e) {
  const deleteBtn = e.target.closest('[data-delete]');
  const item = e.target.closest('.saved-item');

  if (deleteBtn) {
    e.stopPropagation();
    deleteBanner(deleteBtn.dataset.delete);
    return;
  }

  if (item) {
    fetchAndLoadBanner(item.dataset.id);
  }
}

async function fetchAndLoadBanner(id) {
  try {
    const res = await fetch('/api/banners');
    const banners = await res.json();
    const banner = banners.find((b) => b.id === id);
    if (banner) loadBanner(banner);
  } catch (err) {
    showError('Could not load banner: ' + err.message);
  }
}

function loadBanner(b) {
  Object.assign(state, {
    companyName:         b.companyName    || '',
    headline:            b.headline       || '',
    subtext:             b.subtext        || '',
    tagline:             b.tagline        || '',
    ctaText:             b.ctaText        || 'Learn More',
    showCompanyName:     b.showCompanyName !== false,
    showHeadline:        b.showHeadline    !== false,
    showSubtext:         b.showSubtext     !== false,
    showTagline:         b.showTagline     !== false,
    showCta:             b.showCta         !== false,
    primaryColor:        b.primaryColor   || '#ffffff',
    secondaryColor:      b.secondaryColor || '#f0c040',
    ctaColor:            b.ctaColor        || '#6c63ff',
    ctaTextColor:        b.ctaTextColor    || '#ffffff',
    ctaFontSize:         b.ctaFontSize     || 14,
    ctaBorderRadius:     b.ctaBorderRadius ?? 4,
    ctaPaddingV:         b.ctaPaddingV     || 10,
    ctaPaddingH:         b.ctaPaddingH     || 28,
    ctaFontWeight:       b.ctaFontWeight   || '700',
    fontFamily:          b.fontFamily      || '',
    headlineFont:        b.headlineFont    || '',
    showOverlay:         b.showOverlay === true,
    overlayColor:        b.overlayColor   || '#000000',
    overlayOpacity:      b.overlayOpacity ?? 0.5,
    bgColor:             b.bgColor        || '#1a1a2e',
    headlineSize:        b.headlineSize   || 20,
    subtextSize:         b.subtextSize    || 16,
    companySize:         b.companySize    || 32,
    taglineSize:         b.taglineSize    || 13,
    headlineWeight:      b.headlineWeight || '700',
    textAlign:           b.textAlign      || 'center',
    selectedImageBase64: b.selectedImageBase64 || null,
    imageAvgColor:       null,
    imagePixels:         [],
    imageFit:            b.imageFit   || 'cover',
    imagePosX:           b.imagePosX ?? 50,
    imagePosY:           b.imagePosY ?? 50,
    logoUrl:             b.logoUrl    || null,
    logoBase64:          b.logoBase64 || null,
    showLogo:            b.showLogo === true,
    logoSize:            b.logoSize   || 56,
    images:              (b.imageUrls || []).map((url) => ({ url, base64: null })),
    currentBannerId:     b.id,
    bannerName:          b.name || b.companyName || '',
    positions:           clonePositions(b.positions),
    zones:               b.zones             ? JSON.parse(JSON.stringify(b.zones))             : [],
    elementColors:       b.elementColors     ? { ...b.elementColors }     : {},
    elementTextAligns:   b.elementTextAligns ? { ...b.elementTextAligns } : {},
  });

  // If saved banner had images, populate grid too
  if (b.imageUrls && b.imageUrls.length) {
    renderImageGrid(b.imageUrls);
    $('imagePanel').classList.remove('hidden');
  }
  // Clear any logos from a prior analyze pass — saved banners don't carry them.
  renderLogoGrid([]);

  populateEditors();
  renderPreview();

  // Saved banners keep their layout — skip variant picker, show quick actions + editor
  $('quickActions').classList.remove('hidden');
  $('variantPanel').classList.add('hidden');

  // Re-sample image pixels so contrast helpers have fresh data after load
  if (state.selectedImageBase64) {
    sampleImagePixels(state.selectedImageBase64).then(({ avg, samples }) => {
      state.imageAvgColor = avg;
      state.imagePixels   = samples;
    });
  }
}

async function deleteBanner(id) {
  if (!confirm('Delete this banner?')) return;
  try {
    await fetch(`/api/banners/${id}`, { method: 'DELETE' });
    if (state.currentBannerId === id) {
      state.currentBannerId = null;
      $('bannerName').value = '';
    }
    loadSavedBanners();
    showToast('Banner deleted.');
  } catch (err) {
    showError('Delete failed: ' + err.message);
  }
}

/* ── New banner reset ────────────────────────────────────────────────────── */
function resetBanner() {
  Object.assign(state, {
    companyName: '',
    headline: 'Your Banner Headline',
    subtext: 'Supporting text will appear here after analysis',
    tagline: '',
    ctaText: 'Learn More',
    showCompanyName: true,
    showHeadline: true,
    showSubtext: false,
    showTagline: false,
    showCta: true,
    selectedImageBase64: null,
    imageAvgColor: null,
    imagePixels: [],
    imageFit: 'cover',
    imagePosX: 50,
    imagePosY: 50,
    logoUrl: null,
    logoBase64: null,
    showLogo: false,
    logoSize: 56,
    scrapedLogos: [],
    bgColor: '#1a1a2e',
    showOverlay: false,
    overlayColor: '#000000',
    overlayOpacity: 0.5,
    primaryColor: '#ffffff',
    secondaryColor: '#f0c040',
    ctaColor: '#6c63ff',
    ctaTextColor: '#ffffff',
    ctaFontSize: 14,
    ctaBorderRadius: 4,
    ctaPaddingV: 10,
    ctaPaddingH: 28,
    ctaFontWeight: '700',
    headlineSize: 20,
    subtextSize: 16,
    companySize: 32,
    taglineSize: 13,
    headlineWeight: '700',
    textAlign: 'center',
    images: [],
    currentBannerId: null,
    bannerName: '',
    positions: scalePositions(clonePositions(), FORMATS[0].sourceW, FORMATS[0].sourceH, state.format.sourceW, state.format.sourceH),
    zones: [],
    elementColors: {},
    elementTextAligns: {},
  });
  populateEditors();
  renderPreview();
  $('imageGrid').innerHTML = '';
  renderLogoGrid([]);
  $('imagePanel').classList.add('hidden');
  $('variantPanel').classList.add('hidden');
  $('quickActions').classList.add('hidden');
  $('editorPanel').classList.add('hidden');
  $('bannerName').value = '';
}

/* ── Color hex inputs sync ───────────────────────────────────────────────── */
function wireColorPair(pickerId, hexId) {
  const picker = $(pickerId);
  const hex = $(hexId);
  picker.addEventListener('input', () => {
    hex.value = picker.value;
    syncFromEditors();
  });
  hex.addEventListener('input', () => {
    if (isHex(hex.value)) {
      picker.value = hex.value;
      syncFromEditors();
    }
  });
}

/* ── Tabs ────────────────────────────────────────────────────────────────── */
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${tab}`).classList.add('active');
    });
  });
}

/* ── Toast ───────────────────────────────────────────────────────────────── */
function showToast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = `
    position:fixed; bottom:24px; right:24px; background:#10b981; color:#fff;
    padding:12px 18px; border-radius:8px; font-size:13px; font-weight:500;
    box-shadow:0 4px 12px rgba(0,0,0,.15); z-index:9999;
    animation: fadeIn .2s ease;
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

/* ── Error / loading helpers ─────────────────────────────────────────────── */
function showError(msg) {
  const el = $('errorMessage');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError() {
  $('errorMessage').classList.add('hidden');
}

function setLoading(on) {
  const btn = $('analyzeBtn');
  const txt = $('analyzeBtnText');
  const spin = $('analyzeSpinner');
  btn.disabled = on;
  txt.textContent = on ? 'Analyzing...' : 'Analyze & Generate';
  spin.classList.toggle('hidden', !on);
}

/* ── Utilities ───────────────────────────────────────────────────────────── */
function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16) || 0,
    g: parseInt(clean.slice(2, 4), 16) || 0,
    b: parseInt(clean.slice(4, 6), 16) || 0,
  };
}

function isHex(val) {
  return typeof val === 'string' && /^#[0-9a-f]{6}$/i.test(val.trim());
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function rgbToHex({ r, g, b }) {
  const h = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

/* WCAG relative luminance (0–1) for a hex colour */
function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const toLin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

/* Text-shadow applied directly to the glyphs — a strong contrasting colour
 * behind each letter so the text pops. Dark text gets a light halo around
 * the glyphs, light text gets a dark halo. Layered for a thick, even glow. */
function textGlyphShadow(hex) {
  const isDark = relativeLuminance(hex) < 0.5;
  const c = isDark ? '255,255,255' : '0,0,0';
  // Multiple layered shadows → thicker, more uniform halo around glyphs
  return [
    `0 0 2px rgba(${c},0.95)`,
    `0 0 4px rgba(${c},0.85)`,
    `0 0 8px rgba(${c},0.75)`,
    `0 0 14px rgba(${c},0.60)`,
  ].join(', ');
}

/* WCAG contrast ratio between two hex colours (1–21) */
function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const [lo, hi] = la < lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/* Hex → HSL (h: 0–360, s/l: 0–1) */
function hexToHsl(hex) {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn)      h = ((gn - bn) / d + (gn < bn ? 6 : 0));
    else if (max === gn) h = ((bn - rn) / d + 2);
    else                 h = ((rn - gn) / d + 4);
    h *= 60;
  }
  return { h, s, l };
}

/* HSL → hex */
function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0, gp = 0, bp = 0;
  if      (h < 60)  { rp = c; gp = x; bp = 0; }
  else if (h < 120) { rp = x; gp = c; bp = 0; }
  else if (h < 180) { rp = 0; gp = c; bp = x; }
  else if (h < 240) { rp = 0; gp = x; bp = c; }
  else if (h < 300) { rp = x; gp = 0; bp = c; }
  else              { rp = c; gp = 0; bp = x; }
  return rgbToHex({ r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 });
}

/* Circular distance between two hues (0–180). Neutrals pass `null` → treated
   as a medium distance so a vivid near-hue match still beats a pure neutral. */
function hueDistance(a, b) {
  if (a == null || b == null) return 120;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/* Build a palette of ~90 candidate text colours spanning the hue/lightness
   spectrum, plus extra variants along the original text colour's hue so
   brand-flavoured choices get preference when they pass contrast. */
function contrastSpectrumCandidates(orig) {
  const out = [];
  // Neutrals
  out.push({ hex: '#ffffff', hue: null });
  out.push({ hex: '#f5f5f5', hue: null });
  out.push({ hex: '#111111', hue: null });
  out.push({ hex: '#2a2a2a', hue: null });
  // Full spectrum: 12 hues × 6 lightness × 2 saturation — added near-black/near-white
  // coloured variants so we have options that can beat pure B/W on contrast
  // while still keeping a hue.
  const hues = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  const lightnesses = [0.1, 0.22, 0.38, 0.62, 0.82, 0.93];
  const saturations = [0.85, 0.55];
  for (const h of hues) {
    for (const l of lightnesses) {
      for (const s of saturations) {
        out.push({ hex: hslToHex(h, s, l), hue: h });
      }
    }
  }
  // Brand-preserving: extra lightness steps along the original hue
  if (orig && orig.s > 0.1) {
    const sBrand = Math.max(orig.s, 0.65);
    for (const l of [0.1, 0.18, 0.28, 0.4, 0.55, 0.7, 0.82, 0.92]) {
      out.push({ hex: hslToHex(orig.h, sBrand, l), hue: orig.h });
    }
  }
  return out;
}

/* Blend foreground over background by alpha (0–1); returns hex */
function blendHex(bgHex, fgHex, alpha) {
  const a = clamp(alpha, 0, 1);
  const bg = hexToRgb(bgHex);
  const fg = hexToRgb(fgHex);
  return rgbToHex({
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  });
}

/* Sample an image (data URL) to a 32×32 canvas and return
   { avg, samples } where samples is an array of ~1024 hex colours */
function sampleImagePixels(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 32; c.height = 32;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 32, 32);
        const data = ctx.getImageData(0, 0, 32, 32).data;
        const samples = [];
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const pr = data[i], pg = data[i + 1], pb = data[i + 2];
          samples.push(rgbToHex({ r: pr, g: pg, b: pb }));
          r += pr; g += pg; b += pb; n++;
        }
        resolve({
          avg: rgbToHex({ r: r / n, g: g / n, b: b / n }),
          samples,
        });
      } catch {
        resolve({ avg: null, samples: [] });
      }
    };
    img.onerror = () => resolve({ avg: null, samples: [] });
    img.src = dataUrl;
  });
}

/* Fraction of pixel samples where `textHex` meets the minimum contrast ratio.
   When overlay is active, each pixel is first composited with the overlay.
   Returns 1.0 when the image is missing (caller should fall back to bgColor). */
function readabilityScore(textHex, minRatio = 3.5) {
  const samples = state.imagePixels;
  if (!samples || !samples.length) return 1.0;
  let ok = 0;
  for (const pix of samples) {
    const bg = state.showOverlay
      ? blendHex(pix, state.overlayColor, state.overlayOpacity)
      : pix;
    if (contrastRatio(textHex, bg) >= minRatio) ok++;
  }
  return ok / samples.length;
}

/* Effective background colour for contrast checks when no image is present
   (or as a fallback). Composites bgColor with overlay if active. */
function effectiveBackgroundColor() {
  const base = state.imageAvgColor || state.bgColor || '#1a1a2e';
  if (state.showOverlay) return blendHex(base, state.overlayColor, state.overlayOpacity);
  return base;
}

/* Pick a readable text colour. Strategy:
   1. If the original text already passes, keep it.
   2. Try coloured candidates (non-neutral) that clear `passThreshold` — prefer
      closest hue to the original, break ties by higher score.
   3. If no coloured candidate passes, try coloured candidates at a relaxed
      `softThreshold` — prefer highest score.
   4. Only fall back to a neutral (white / near-black) if even the softened
      coloured search comes up empty. B/W is the last resort, not the default. */
function readableTextColor(textHex, minRatio = 3.5, passThreshold = 0.80, softThreshold = 0.65) {
  const hasImage = state.imagePixels && state.imagePixels.length;
  const orig = hexToHsl(textHex);
  const origHasHue = orig.s > 0.15;

  if (!hasImage) {
    const bg = effectiveBackgroundColor();
    if (contrastRatio(textHex, bg) >= minRatio) return textHex;
    const candidates = contrastSpectrumCandidates(orig);
    let best = null;
    for (const c of candidates) {
      if (c.hue == null) continue; // skip neutrals on the first pass
      if (contrastRatio(c.hex, bg) < minRatio) continue;
      const distance = origHasHue ? hueDistance(orig.h, c.hue) : 0;
      if (!best || distance < best.distance) best = { hex: c.hex, distance };
    }
    if (best) return best.hex;
    return relativeLuminance(bg) > 0.5 ? '#111111' : '#ffffff';
  }

  const currentScore = readabilityScore(textHex, minRatio);
  if (currentScore >= passThreshold) return textHex;

  const candidates = contrastSpectrumCandidates(orig);
  const scored = candidates.map((c) => ({
    hex: c.hex,
    hue: c.hue,
    isNeutral: c.hue == null,
    score: readabilityScore(c.hex, minRatio),
    distance: origHasHue ? hueDistance(orig.h, c.hue) : 0,
  }));

  // Pass 1: coloured candidates above passThreshold — closest hue wins
  const colouredStrong = scored.filter((s) => !s.isNeutral && s.score >= passThreshold);
  if (colouredStrong.length) {
    colouredStrong.sort((a, b) => (a.distance - b.distance) || (b.score - a.score));
    return colouredStrong[0].hex;
  }

  // Pass 2: coloured candidates at relaxed threshold — highest score wins
  const colouredSoft = scored.filter((s) => !s.isNeutral && s.score >= softThreshold);
  if (colouredSoft.length) {
    colouredSoft.sort((a, b) => (b.score - a.score) || (a.distance - b.distance));
    return colouredSoft[0].hex;
  }

  // Pass 3: no coloured candidate is usable — fall back to the best neutral
  const neutrals = scored.filter((s) => s.isNeutral);
  neutrals.sort((a, b) => b.score - a.score);
  if (neutrals.length && neutrals[0].score > currentScore + 0.05) return neutrals[0].hex;
  return textHex;
}

/* CTA button contrast check — CTA sits on a solid button colour. Same
   preference order as `readableTextColor`: coloured first, neutrals last. */
function readableCtaTextColor(textHex, btnHex, minRatio = 3.5) {
  if (contrastRatio(textHex, btnHex) >= minRatio) return textHex;

  const orig = hexToHsl(textHex);
  const origHasHue = orig.s > 0.15;
  const candidates = contrastSpectrumCandidates(orig);

  const colouredPass = [];
  let bestNeutral = null;
  for (const c of candidates) {
    const ratio = contrastRatio(c.hex, btnHex);
    if (ratio < minRatio) continue;
    const distance = origHasHue ? hueDistance(orig.h, c.hue) : 0;
    if (c.hue == null) {
      if (!bestNeutral || ratio > bestNeutral.ratio) bestNeutral = { hex: c.hex, ratio };
    } else {
      colouredPass.push({ hex: c.hex, distance, ratio });
    }
  }
  if (colouredPass.length) {
    colouredPass.sort((a, b) => (a.distance - b.distance) || (b.ratio - a.ratio));
    return colouredPass[0].hex;
  }
  if (bestNeutral) return bestNeutral.hex;
  return relativeLuminance(btnHex) > 0.5 ? '#111111' : '#ffffff';
}

/* Audit text colours and flip any that fail contrast. Mutates state and
   returns an array of changes for reporting. */
function ensureReadableColors() {
  const changes = [];

  const newPrimary = readableTextColor(state.primaryColor, 3.5);
  if (newPrimary !== state.primaryColor) {
    changes.push('text');
    state.primaryColor = newPrimary;
  }

  const newSecondary = readableTextColor(state.secondaryColor, 3.0);
  if (newSecondary !== state.secondaryColor) {
    changes.push('accent');
    state.secondaryColor = newSecondary;
  }

  const newCtaText = readableCtaTextColor(state.ctaTextColor, state.ctaColor, 3.5);
  if (newCtaText !== state.ctaTextColor) {
    changes.push('CTA text');
    state.ctaTextColor = newCtaText;
  }

  return changes;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Init ────────────────────────────────────────────────────────────────── */
function init() {
  // Analyze form
  $('analyzeForm').addEventListener('submit', handleAnalyze);

  // All text/select editors → real-time preview
  const liveEditors = [
    'editCompanyName', 'editHeadline', 'editSubtext', 'editTagline', 'editCta',
    'editHeadlineSize', 'editSubtextSize', 'editCompanySize', 'editTaglineSize',
    'editHeadlineWeight', 'editTextAlign', 'editOverlayOpacity', 'editFontFamily',
    'editShowCompanyName', 'editShowHeadline', 'editShowSubtext',
    'editShowTagline', 'editShowCta', 'editShowOverlay', 'editShowLogo',
    'editLogoSize',
    'editCtaFontSize', 'editCtaBorderRadius', 'editCtaPaddingV', 'editCtaPaddingH',
    'editCtaFontWeight',
  ];
  liveEditors.forEach((id) => $(id).addEventListener('input', syncFromEditors));
  // Checkboxes need 'change' too (some browsers fire only 'change' for them)
  ['editShowCompanyName','editShowHeadline','editShowSubtext','editShowTagline','editShowCta','editShowOverlay','editShowLogo']
    .forEach((id) => $(id).addEventListener('change', syncFromEditors));

  // Logo URL input + clear button
  $('setLogoUrlBtn')?.addEventListener('click', () => {
    const u = $('editLogoUrl').value.trim();
    if (u) setLogo(u);
  });
  $('editLogoUrl')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('setLogoUrlBtn').click(); }
  });
  $('clearLogoBtn')?.addEventListener('click', clearLogo);

  // A "Check contrast" button: re-audits and fixes text colours on demand
  $('checkContrastBtn')?.addEventListener('click', () => {
    const changes = ensureReadableColors();
    populateEditors();
    renderPreview();
    showToast(changes.length
      ? `Adjusted ${changes.join(' & ')} colour for readability`
      : 'Contrast looks good.');
  });

  // Color pair syncing (picker ↔ hex text)
  wireColorPair('editPrimaryColor',   'editPrimaryColorHex');
  wireColorPair('editSecondaryColor', 'editSecondaryColorHex');
  wireColorPair('editCtaColor',       'editCtaColorHex');
  wireColorPair('editOverlayColor',   'editOverlayColorHex');
  wireColorPair('editBgColor',        'editBgColorHex');
  wireColorPair('editCtaTextColor',   'editCtaTextColorHex');

  // Custom image URL
  $('useCustomImageBtn').addEventListener('click', () => {
    const url = $('customImageUrl').value.trim();
    if (!url) return;
    state.images.push({ url, base64: null });
    renderImageGrid([...state.images.map((i) => i.url)]);
    $('imagePanel').classList.remove('hidden');
    selectImage(url);
    $('customImageUrl').value = '';
  });

  // Upload image from local computer
  $('uploadImage').addEventListener('change', handleFileUpload);

  // Pixabay search
  $('pixabaySearchBtn').addEventListener('click', runPixabaySearch);
  $('pixabayQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runPixabaySearch(); }
  });

  // Action buttons
  $('saveBannerBtn').addEventListener('click', handleSave);
  $('downloadBtn').addEventListener('click', handleDownload);
  $('newBannerBtn').addEventListener('click', resetBanner);
  $('resetPositionsBtn').addEventListener('click', () => {
    state.positions = scalePositions(clonePositions(), FORMATS[0].sourceW, FORMATS[0].sourceH, state.format.sourceW, state.format.sourceH);
    renderPreview();
  });
  $('shuffleBtn').addEventListener('click', shuffleLayout);

  // Tweak toggle — show/hide the full editor panel
  $('tweakBannerBtn')?.addEventListener('click', () => {
    const panel = $('editorPanel');
    const hidden = panel.classList.toggle('hidden');
    $('tweakBannerBtn').textContent = hidden ? 'Tilpas banner' : 'Skjul redigering';
  });

  // Regenerate variants button
  $('regenerateVariantsBtn')?.addEventListener('click', () => showVariantPicker(4));

  // Format selector
  $('formatSelect').addEventListener('change', (e) => {
    applyFormat(FORMATS[parseInt(e.target.value, 10)]);
  });

  // Drag to reposition
  initDragging();

  // Background image fit buttons
  document.querySelectorAll('#imageFitControls .btn-fit').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.imageFit = btn.dataset.fit;
      if (state.imageFit !== 'cover') {
        // Re-centre when leaving drag-capable mode so we don't lock an offset.
        state.imagePosX = 50;
        state.imagePosY = 50;
      }
      syncFitButtons();
      renderPreview();
    });
  });
  syncFitButtons();

  // Saved banners — event delegation
  $('savedBannersList').addEventListener('click', handleSavedItemClick);

  // Tabs
  initTabs();

  // Apply initial format (sets preview dimensions)
  applyFormat(FORMATS[0]);

  // Initial render
  populateEditors();

  // Load saved banners
  loadSavedBanners();
}

document.addEventListener('DOMContentLoaded', init);
