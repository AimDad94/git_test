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
  showCta: true,
  // Background
  selectedImageBase64: null,
  bgColor: '#1a1a2e',
  // Overlay
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
  // Typography
  headlineSize: 32,
  subtextSize: 16,
  companySize: 12,
  taglineSize: 13,
  headlineWeight: '700',
  textAlign: 'center',
  // Element positions
  positions: clonePositions(),
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
    typeScale: { headline: 0.15, subtext: 0.058, company: 0.038, tagline: 0.036, cta: 0.052 },
    anchors: { stackX: 0.50, cta: 'flow' },
    vAlign: 'center', gap: 0.055, vPad: 0.06,
  },
  {
    name: 'Minimal Left',
    minAspect: 1.5, maxAspect: 6,
    textAlign: 'left', headlineWeight: '600', overlayOpacity: 0.36,
    cta: { radius: 2, padV: 9, padH: 26, weight: '500' },
    typeScale: { headline: 0.12, subtext: 0.050, company: 0.034, tagline: 0.030, cta: 0.046 },
    anchors: { stackX: 0.28, cta: 'flow' },
    vAlign: 'center', gap: 0.05, vPad: 0.08,
  },
  {
    name: 'Editorial Right',
    minAspect: 1.4, maxAspect: 5,
    textAlign: 'right', headlineWeight: '700', overlayOpacity: 0.45,
    cta: { radius: 6, padV: 10, padH: 28, weight: '600' },
    typeScale: { headline: 0.13, subtext: 0.054, company: 0.036, tagline: 0.032, cta: 0.048 },
    anchors: { stackX: 0.72, cta: 'flow' },
    vAlign: 'center', gap: 0.05, vPad: 0.08,
  },
  {
    name: 'Modern Split',
    minAspect: 2.0, maxAspect: 6,
    textAlign: 'left', headlineWeight: '700', overlayOpacity: 0.42,
    cta: { radius: 999, padV: 12, padH: 32, weight: '600' },
    typeScale: { headline: 0.14, subtext: 0.052, company: 0.036, tagline: 0.032, cta: 0.050 },
    anchors: { stackX: 0.30, cta: { x: 0.80, y: 0.50 } },
    vAlign: 'center', gap: 0.05, vPad: 0.10,
  },
  {
    name: 'Square Stack',
    minAspect: 0.5, maxAspect: 1.5,
    textAlign: 'center', headlineWeight: '800', overlayOpacity: 0.50,
    cta: { radius: 6, padV: 11, padH: 28, weight: '700' },
    typeScale: { headline: 0.10, subtext: 0.044, company: 0.032, tagline: 0.028, cta: 0.042 },
    anchors: { stackX: 0.50, cta: 'flow' },
    vAlign: 'center', gap: 0.045, vPad: 0.08,
  },
  {
    name: 'Top Heavy',
    minAspect: 1.3, maxAspect: 5,
    textAlign: 'center', headlineWeight: '900', overlayOpacity: 0.50,
    cta: { radius: 4, padV: 11, padH: 30, weight: '700' },
    typeScale: { headline: 0.16, subtext: 0.055, company: 0.038, tagline: 0.034, cta: 0.050 },
    anchors: { stackX: 0.50, cta: 'flow' },
    vAlign: 'top', gap: 0.045, vPad: 0.07,
  },
  {
    name: 'Reverse Split',
    minAspect: 2.5, maxAspect: 6,
    textAlign: 'right', headlineWeight: '700', overlayOpacity: 0.42,
    cta: { radius: 999, padV: 12, padH: 32, weight: '600' },
    typeScale: { headline: 0.14, subtext: 0.052, company: 0.036, tagline: 0.032, cta: 0.050 },
    anchors: { stackX: 0.72, cta: { x: 0.20, y: 0.50 } },
    vAlign: 'center', gap: 0.05, vPad: 0.10,
  },
  {
    name: 'Quiet Luxe',
    minAspect: 1.5, maxAspect: 5,
    textAlign: 'center', headlineWeight: '400', overlayOpacity: 0.34,
    cta: { radius: 0, padV: 10, padH: 30, weight: '500' },
    typeScale: { headline: 0.13, subtext: 0.044, company: 0.028, tagline: 0.028, cta: 0.040 },
    anchors: { stackX: 0.50, cta: 'flow' },
    vAlign: 'center', gap: 0.065, vPad: 0.10,
  },
  {
    name: 'Bottom Anchor',
    minAspect: 1.4, maxAspect: 5,
    textAlign: 'left', headlineWeight: '800', overlayOpacity: 0.48,
    cta: { radius: 4, padV: 10, padH: 28, weight: '700' },
    typeScale: { headline: 0.13, subtext: 0.048, company: 0.034, tagline: 0.030, cta: 0.046 },
    anchors: { stackX: 0.28, cta: 'flow' },
    vAlign: 'bottom', gap: 0.045, vPad: 0.07,
  },
];

const SLIDER_BOUNDS = {
  headlineSize: [16, 62], subtextSize: [10, 28], companySize: [8, 72],
  taglineSize: [8, 22], ctaFontSize: [10, 36],
};

/* Vertical stacking order (top → bottom) */
const STACK_ORDER = ['companyName', 'headline', 'subtext', 'cta', 'tagline'];
const ELEMENT_IDS = {
  companyName: 'previewCompanyName',
  headline:    'previewHeadline',
  subtext:     'previewSubtext',
  cta:         'previewCta',
  tagline:     'previewTagline',
};

function isElementVisible(key) {
  if (key === 'companyName') return !!state.companyName;
  if (key === 'headline')    return !!state.headline;
  if (key === 'subtext')     return !!state.subtext;
  if (key === 'cta')         return !!state.showCta;
  if (key === 'tagline')     return !!state.tagline;
  return false;
}

let _lastStyleIndex = -1;
function shuffleLayout() {
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

  // Render once so we can measure real heights
  populateEditors();
  renderPreview();
  flowStack(style, w, h);
  renderPreview();

  showToast(`Layout: ${style.name}`);
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

/* ── Render ──────────────────────────────────────────────────────────────── */
function renderPreview() {
  const preview = $('bannerPreview');
  const overlay = $('bannerOverlay');

  // Font
  if (state.fontFamily) {
    loadGoogleFont(state.fontFamily);
    preview.style.fontFamily = `'${state.fontFamily}', sans-serif`;
  } else {
    preview.style.fontFamily = '';
  }

  // Background
  preview.style.backgroundImage = state.selectedImageBase64
    ? `url(${state.selectedImageBase64})` : 'none';
  preview.style.backgroundColor = state.bgColor;

  // Overlay
  const { r, g, b } = hexToRgb(state.overlayColor);
  overlay.style.backgroundColor = `rgba(${r},${g},${b},${state.overlayOpacity})`;

  // ── Position + style each draggable element ──────────────────────────────
  const pos = state.positions;

  // Company name
  const company = $('previewCompanyName');
  company.textContent = state.companyName;
  company.style.color = state.primaryColor;
  company.style.fontSize = state.companySize + 'px';
  company.style.left = pos.companyName.x + 'px';
  company.style.top  = pos.companyName.y + 'px';
  company.style.textAlign = state.textAlign;
  company.style.display = state.companyName ? '' : 'none';

  // Headline
  const headline = $('previewHeadline');
  headline.textContent = state.headline;
  headline.style.color = state.primaryColor;
  headline.style.fontSize = state.headlineSize + 'px';
  headline.style.fontWeight = state.headlineWeight;
  headline.style.left = pos.headline.x + 'px';
  headline.style.top  = pos.headline.y + 'px';
  headline.style.textAlign = state.textAlign;

  // Subtext
  const subtext = $('previewSubtext');
  subtext.textContent = state.subtext;
  subtext.style.color = state.primaryColor;
  subtext.style.fontSize = state.subtextSize + 'px';
  subtext.style.left = pos.subtext.x + 'px';
  subtext.style.top  = pos.subtext.y + 'px';
  subtext.style.textAlign = state.textAlign;
  subtext.style.display = state.subtext ? '' : 'none';

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
  cta.style.display = state.showCta ? '' : 'none';

  // Tagline
  const tagline = $('previewTagline');
  tagline.textContent = state.tagline;
  tagline.style.color = state.secondaryColor;
  tagline.style.fontSize = state.taglineSize + 'px';
  tagline.style.left = pos.tagline.x + 'px';
  tagline.style.top  = pos.tagline.y + 'px';
  tagline.style.textAlign = state.textAlign;
  tagline.style.display = state.tagline ? '' : 'none';
}

/* ── Drag to reposition ──────────────────────────────────────────────────── */
const drag = { active: false, key: null, offsetX: 0, offsetY: 0 };

function initDragging() {
  const preview = $('bannerPreview');

  preview.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.banner-el');
    if (!el) return;
    e.preventDefault();

    const key = el.dataset.element;
    const rect = preview.getBoundingClientRect();
    const pos = state.positions[key];

    drag.active  = true;
    drag.key     = key;
    drag.offsetX = (e.clientX - rect.left) / state.previewScale - pos.x;
    drag.offsetY = (e.clientY - rect.top)  / state.previewScale - pos.y;

    el.classList.add('is-dragging');
    preview.classList.add('is-dragging');
  });

  document.addEventListener('mousemove', (e) => {
    if (!drag.active) return;

    const rect = $('bannerPreview').getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) / state.previewScale - drag.offsetX, 0, state.format.sourceW);
    const y = clamp((e.clientY - rect.top)  / state.previewScale - drag.offsetY, 0, state.format.sourceH);

    state.positions[drag.key] = { x, y };
    renderPreview();
  });

  document.addEventListener('mouseup', () => {
    if (!drag.active) return;
    document.querySelector(`[data-element="${drag.key}"]`)
      ?.classList.remove('is-dragging');
    $('bannerPreview').classList.remove('is-dragging');
    drag.active = false;
    drag.key    = null;
  });
}

/* ── Sync editors → state → render ──────────────────────────────────────── */
function syncFromEditors() {
  state.companyName   = $('editCompanyName').value;
  state.headline      = $('editHeadline').value;
  state.subtext       = $('editSubtext').value;
  state.tagline       = $('editTagline').value;
  state.ctaText       = $('editCta').value;
  state.showCta       = $('editShowCta').checked;

  state.primaryColor  = $('editPrimaryColor').value;
  state.secondaryColor = $('editSecondaryColor').value;
  state.ctaColor      = $('editCtaColor').value;
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
  $('editShowCta').checked    = state.showCta;

  $('editPrimaryColor').value   = state.primaryColor;
  $('editSecondaryColor').value = state.secondaryColor;
  $('editCtaColor').value       = state.ctaColor;
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
}

/* ── Analyze ─────────────────────────────────────────────────────────────── */
async function handleAnalyze(e) {
  e.preventDefault();
  const websiteUrl = $('websiteUrl').value.trim();
  const facebookUrl = $('facebookUrl').value.trim();
  const imageUrl = $('imageUrl').value.trim();

  setLoading(true);
  clearError();

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteUrl, facebookUrl: facebookUrl || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed');

    const { analysis, images } = data;

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
      images:         images.map((url) => ({ url, base64: null })),
      showCta:        true,
      selectedImageBase64: null,
      currentBannerId: null,
      bannerName:     analysis.companyName || '',
      positions:      scalePositions(clonePositions(), FORMATS[0].sourceW, FORMATS[0].sourceH, state.format.sourceW, state.format.sourceH),
    });

    // Prepend manually entered image URL so it takes priority
    if (imageUrl) {
      state.images.unshift({ url: imageUrl, base64: null });
      images.unshift(imageUrl);
    }

    populateEditors();
    renderPreview();
    renderImageGrid(images);

    $('imagePanel').classList.remove('hidden');

    // Auto-select the first image (manual URL takes priority if provided)
    if (images.length > 0) selectImage(images[0]);
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

async function selectImage(url) {
  // Highlight selected thumbnail
  document.querySelectorAll('.image-thumb').forEach((el) => {
    el.classList.toggle('selected', el.src === url);
  });

  // Check cache
  const cached = state.images.find((i) => i.url === url);
  if (cached && cached.base64) {
    state.selectedImageBase64 = cached.base64;
    renderPreview();
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

    state.selectedImageBase64 = dataUrl;
    renderPreview();
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
    showCta: state.showCta,
    primaryColor: state.primaryColor,
    secondaryColor: state.secondaryColor,
    ctaColor: state.ctaColor,
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
    ctaTextColor: state.ctaTextColor,
    ctaFontSize: state.ctaFontSize,
    ctaBorderRadius: state.ctaBorderRadius,
    ctaPaddingV: state.ctaPaddingV,
    ctaPaddingH: state.ctaPaddingH,
    ctaFontWeight: state.ctaFontWeight,
    selectedImageBase64: state.selectedImageBase64,
    imageUrls: state.images.map((i) => i.url),
    positions: state.positions,
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
    showCta:             b.showCta        !== false,
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
    overlayColor:        b.overlayColor   || '#000000',
    overlayOpacity:      b.overlayOpacity ?? 0.5,
    bgColor:             b.bgColor        || '#1a1a2e',
    headlineSize:        b.headlineSize   || 32,
    subtextSize:         b.subtextSize    || 16,
    companySize:         b.companySize    || 12,
    taglineSize:         b.taglineSize    || 13,
    headlineWeight:      b.headlineWeight || '700',
    textAlign:           b.textAlign      || 'center',
    selectedImageBase64: b.selectedImageBase64 || null,
    images:              (b.imageUrls || []).map((url) => ({ url, base64: null })),
    currentBannerId:     b.id,
    bannerName:          b.name || b.companyName || '',
    positions:           clonePositions(b.positions),
  });

  // If saved banner had images, populate grid too
  if (b.imageUrls && b.imageUrls.length) {
    renderImageGrid(b.imageUrls);
    $('imagePanel').classList.remove('hidden');
  }

  populateEditors();
  renderPreview();
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
    showCta: true,
    selectedImageBase64: null,
    bgColor: '#1a1a2e',
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
    headlineSize: 32,
    subtextSize: 16,
    companySize: 12,
    taglineSize: 13,
    headlineWeight: '700',
    textAlign: 'center',
    images: [],
    currentBannerId: null,
    bannerName: '',
    positions: scalePositions(clonePositions(), FORMATS[0].sourceW, FORMATS[0].sourceH, state.format.sourceW, state.format.sourceH),
  });
  populateEditors();
  renderPreview();
  $('imageGrid').innerHTML = '';
  $('imagePanel').classList.add('hidden');
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
    'editShowCta',
    'editCtaFontSize', 'editCtaBorderRadius', 'editCtaPaddingV', 'editCtaPaddingH',
    'editCtaFontWeight',
  ];
  liveEditors.forEach((id) => $(id).addEventListener('input', syncFromEditors));

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

  // Action buttons
  $('saveBannerBtn').addEventListener('click', handleSave);
  $('downloadBtn').addEventListener('click', handleDownload);
  $('newBannerBtn').addEventListener('click', resetBanner);
  $('resetPositionsBtn').addEventListener('click', () => {
    state.positions = scalePositions(clonePositions(), FORMATS[0].sourceW, FORMATS[0].sourceH, state.format.sourceW, state.format.sourceH);
    renderPreview();
  });
  $('shuffleBtn').addEventListener('click', shuffleLayout);

  // Format selector
  $('formatSelect').addEventListener('change', (e) => {
    applyFormat(FORMATS[parseInt(e.target.value, 10)]);
  });

  // Drag to reposition
  initDragging();

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
