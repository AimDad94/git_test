require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { franc } = require('franc-min');
const { convert: htmlToText } = require('html-to-text');
const llm = require('./llm');
const blocklist = require('./blocklist');
const spamRules = require('./spam-rules');
const forward = require('./forward');
const verdictOverrides = require('./verdict-overrides');

const VORESDIGITAL_API_KEY = process.env.VORESDIGITAL_API_KEY || '';
const FORWARD_LEADS_TO = process.env.FORWARD_LEADS_TO || '';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const LLM_MAX_PER_REFRESH = Number(process.env.LLM_MAX_PER_REFRESH) || 300;

const app = express();
app.use(express.json());
const PORT = Number(process.env.PORT) || 3002;
const TOKEN = process.env.HUBSPOT_TOKEN;
const PIPELINE_NAME = process.env.PIPELINE_NAME || 'Eksterne tickets';
const STAGE_NAME = process.env.STAGE_NAME || 'New';
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || '';
const CACHE_TTL_MS = 60_000;

if (!TOKEN) {
  console.error('Mangler HUBSPOT_TOKEN i .env');
  process.exit(1);
}

const HS = 'https://api.hubapi.com';
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json'
};

let cache = { fetchedAt: 0, payload: null };
let pipelineCache = null;

async function hsGet(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot ${res.status} ${url}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function hsPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot ${res.status} ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function resolvePipeline() {
  if (pipelineCache) return pipelineCache;
  const data = await hsGet(`${HS}/crm/v3/pipelines/tickets`);
  const match = (data.results || []).find(
    p => (p.label || '').toLowerCase() === PIPELINE_NAME.toLowerCase()
  );
  if (!match) {
    const labels = (data.results || []).map(p => p.label).join(', ');
    throw new Error(`Pipeline "${PIPELINE_NAME}" ikke fundet. Tilgængelige: ${labels}`);
  }
  const stages = match.stages || [];
  const stageByLabel = stages.find(
    s => (s.label || '').toLowerCase() === STAGE_NAME.toLowerCase()
  );
  if (!stageByLabel) {
    const labels = stages.map(s => s.label).join(', ');
    throw new Error(`Stage "${STAGE_NAME}" ikke fundet i pipeline "${match.label}". Tilgængelige: ${labels}`);
  }
  pipelineCache = {
    id: match.id,
    label: match.label,
    stageId: stageByLabel.id,
    stageLabel: stageByLabel.label,
    stages: Object.fromEntries(stages.map(s => [s.id, s.label]))
  };
  return pipelineCache;
}

const TICKET_PROPS = [
  'subject',
  'content',
  'hs_pipeline',
  'hs_pipeline_stage',
  'hs_ticket_priority',
  'source_type',
  'hs_ticket_category',
  'createdate',
  'hs_lastmodifieddate',
  'hubspot_owner_id',
  'hs_object_source',
  'hs_object_source_label',
  'hs_thread_ids_to_restore',
  'first_agent_email_response_date',
  'closed_date'
];

async function archiveTicketIds(ids) {
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const resp = await fetch(`${HS}/crm/v3/objects/tickets/batch/archive`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ inputs: chunk.map(id => ({ id })) })
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`HubSpot ${resp.status} ved archive: ${txt.slice(0, 300)}`);
    }
  }
}

// Flytter tickets til en bestemt stage uden at arkivere dem - bevarer at HubSpot-link virker.
async function moveTicketsToStage(ids, stageId) {
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const resp = await fetch(`${HS}/crm/v3/objects/tickets/batch/update`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        inputs: chunk.map(id => ({ id, properties: { hs_pipeline_stage: stageId } }))
      })
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`HubSpot ${resp.status} ved stage-update: ${txt.slice(0, 300)}`);
    }
  }
}

async function fetchTicketsForPipeline(pipelineId, stageId) {
  const out = [];
  let after;
  for (let safety = 0; safety < 50; safety++) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_pipeline', operator: 'EQ', value: pipelineId },
          { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: stageId }
        ]
      }],
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      properties: TICKET_PROPS,
      limit: 100
    };
    if (after) body.after = after;
    const page = await hsPost(`${HS}/crm/v3/objects/tickets/search`, body);
    out.push(...(page.results || []));
    after = page.paging && page.paging.next && page.paging.next.after;
    if (!after) break;
  }
  return out;
}

async function fetchAssociatedContacts(ticketIds) {
  if (!ticketIds.length) return new Map();
  const map = new Map();
  for (let i = 0; i < ticketIds.length; i += 100) {
    const chunk = ticketIds.slice(i, i + 100);
    const body = { inputs: chunk.map(id => ({ id })) };
    const data = await hsPost(
      `${HS}/crm/v4/associations/tickets/contacts/batch/read`,
      body
    );
    for (const row of data.results || []) {
      const ticketId = row.from && row.from.id;
      const contactIds = (row.to || []).map(t => String(t.toObjectId));
      if (ticketId) map.set(ticketId, contactIds);
    }
  }
  return map;
}

async function fetchContacts(contactIds) {
  if (!contactIds.length) return new Map();
  const map = new Map();
  for (let i = 0; i < contactIds.length; i += 100) {
    const chunk = contactIds.slice(i, i + 100);
    const body = {
      properties: ['email', 'firstname', 'lastname', 'company', 'phone', 'website'],
      inputs: chunk.map(id => ({ id }))
    };
    const data = await hsPost(`${HS}/crm/v3/objects/contacts/batch/read`, body);
    for (const c of data.results || []) map.set(c.id, c.properties || {});
  }
  return map;
}

const SPAM_PHRASES = [
  'seo services', 'seo service', 'seo expert', 'seo agency', 'seo company',
  'rank #1', 'rank 1', 'first page of google', 'top of google', 'google ranking',
  'guest post', 'guest posting', 'backlinks', 'back links', 'link building', 'link-building',
  'do follow', 'dofollow', 'high da', 'high pa', 'domain authority', 'da pa',
  'web design services', 'web development services', 'mobile app development',
  'app development services', 'website redesign', 'website revamp',
  'increase your sales', 'boost your sales', 'boost your traffic', 'boost your ranking',
  'increase your traffic', 'drive traffic', 'qualified leads',
  'crypto', 'bitcoin', 'forex', 'investment opportunity', 'binary option', 'trading signals',
  'dear sir', 'dear sir/madam', 'dear owner', 'dear ceo', 'to whom it may concern', 'dear admin',
  'i hope this email finds you well', 'i hope this finds you well', 'hope this email finds you',
  'kindly revert', 'kindly reply', 'kindly let me know', 'kindly confirm',
  'wordpress developer', 'shopify developer', 'magento developer',
  'cold email', 'cold outreach', 'lead generation services', 'b2b lead',
  'i came across your website', 'i visited your website', 'i was browsing your website',
  'i recently visited', 'while browsing the internet', 'noticed your website',
  'we offer', 'we provide professional', 'our team of experts', 'team of skilled',
  'highly skilled developers', 'dedicated developers', 'offshore development',
  'free trial', 'no obligation', 'risk free', 'limited time offer', 'act now',
  'work from home', 'make money online', 'earn from home', 'passive income',
  'chatgpt prompt', 'ai automation agency', 'ai agency', 'ai-powered solution',
  'unsubscribe', 'click here to unsubscribe', 'opt out of these emails',
  'mail merge', 'php developer', '.net developer', 'react developer for hire',
  'looking for partnership', 'partnership opportunity', 'business proposal',
  'i am writing to inquire', 'as per our discussion', 'per my last email',
  'follow up', 'just following up', 'circling back', 'bumping this',
  'increase conversion', 'conversion rate optimization', 'cro services',
  'press release distribution', 'pr distribution', 'media outreach service',
  'verified email list', 'targeted email list', 'b2b database',
  'whitelabel', 'white label seo', 'reseller program'
];

const LEAD_PHRASES = [
  'vores digital', 'voresdigital',
  'annoncering', 'annonce', 'annoncere', 'kampagne', 'kampagner',
  'reklame', 'markedsføring', 'marketing',
  'banner', 'bannerannonce', 'displayannonce', 'native', 'native annonce',
  'sponsoreret', 'sponsoreret indhold', 'advertorial', 'redaktionel',
  'nyhedssite', 'nyhedssider', 'nyhedsmedie', 'medie', 'avis',
  'tilbud på', 'pris på', 'prisliste', 'prissætning', 'mediaplan',
  'samarbejde', 'samarbejdsaftale', 'kunde', 'kontakt person',
  'faktura', 'betaling', 'abonnement', 'opsige', 'forny',
  'møde', 'aftale', 'opkald', 'ringe', 'kan vi tales ved',
  'rettelse', 'ret venligst', 'kan i ændre', 'kan i rette', 'kan i fjerne',
  'support', 'fejl', 'virker ikke', 'logge ind', 'login', 'kan ikke logge',
  'artikel', 'indlæg', 'opslag', 'pressemeddelelse',
  'cvr', 'kontonummer', 'mit medie', 'jeres side', 'vores hjemmeside'
];

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com','outlook.com','hotmail.com','live.com','yahoo.com','icloud.com','protonmail.com','aol.com',
  'mail.com','gmx.com','yandex.com','zoho.com','msn.com'
]);

const SUSPICIOUS_TLDS = ['.xyz', '.top', '.click', '.live', '.shop', '.online', '.site', '.club', '.work', '.icu', '.cyou', '.pw', '.tk', '.ml', '.ga', '.cf'];

const URL_SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'ow.ly', 'goo.gl', 'lnkd.in', 'rb.gy', 'cutt.ly',
  'is.gd', 'shorturl.at', 'rebrand.ly', 'tiny.cc', 'soo.gd', 'buff.ly', 'short.io'
]);

// Outreach/samarbejdsfraser - reel lead kun hvis ticket er på dansk.
// Hvis sproget ikke er dansk OG en af disse fraser optræder, er det spam.
const OUTREACH_PHRASES = [
  'guest post', 'guest posting', 'guest blog', 'guest article',
  'link placement', 'link insertion', 'link exchange', 'link building', 'link-building',
  'backlinks', 'back links', 'do follow', 'dofollow',
  'partnership', 'collaboration', 'collab opportunity', 'business proposal',
  'sponsored post', 'sponsored article', 'sponsored content',
  'content placement', 'content collaboration', 'paid post',
  'press release distribution', 'pr distribution', 'media outreach'
];

// Pressemeddelelses-signaler
const PRESS_SUBJECT_PREFIXES = [
  'pm -', 'pm:', 'pm ', 'pressemeddelelse', 'pressemeddelse',
  'presseinvitation', 'presse-invitation', 'pressemateriale',
  'presse:', 'press release', 'press-release', 'nyhedsbrev', 'nyhed:'
];

const PRESS_SENDER_LOCALPARTS = new Set([
  'presse', 'pressemeddelelse', 'pressekontakt', 'press', 'pr',
  'nyheder', 'nyhedsrum', 'kommunikation', 'media', 'newsroom', 'news'
]);

// Pressekanaler / pressedistribuører - alt herfra er pressemeddelelser
const PRESS_SENDER_DOMAINS = new Set([
  'ritzau.dk', 'mynewsdesk.com', 'mynewsdesk.dk', 'cision.com', 'prnewswire.com', 'businesswire.com'
]);

// Egne formular-afsendere - tickets herfra er reelle henvendelser
const LEAD_FORM_SENDERS = new Set([
  'no-reply@voresdigital.dk', 'noreply@voresdigital.dk'
]);

// Opsigelses-signaler (kontrakter, abonnementer, samarbejder)
const OPSIGELSE_SUBJECT_PREFIXES = [
  'opsigelse', 'opsig ', 'opsig:', 'opsig.', 'opsig-',
  'annullering', 'annullér', 'annuller ', 'annuller:',
  'sv: opsigelse', 're: opsigelse', 'vs: opsigelse'
];

const OPSIGELSE_PHRASES = [
  'vil opsige', 'vil gerne opsige', 'ønsker at opsige', 'vil hermed opsige',
  'hermed opsiger', 'opsiger hermed', 'vi opsiger', 'jeg opsiger',
  'opsige min aftale', 'opsige vores aftale', 'opsige aftalen',
  'opsige mit abonnement', 'opsige vores abonnement', 'opsige abonnementet',
  'opsige samarbejdet', 'opsige kontrakten', 'opsige kontrakt',
  'ophør af aftale', 'ophør af samarbejde', 'ophæve aftalen', 'ophæve aftale',
  'annullere min aftale', 'annullere vores aftale', 'annullere abonnementet',
  'afmelde abonnement', 'afmelde aftalen', 'afmeld jeres ydelse',
  'stoppe samarbejdet', 'stoppe abonnementet', 'stoppe aftalen',
  'afslutte aftalen', 'afslutte samarbejdet', 'afslutte abonnementet',
  'kontrakten skal opsiges', 'aftalen skal opsiges', 'abonnement skal opsiges',
  'frasige aftalen', 'frasige samarbejdet'
];

const PRESS_BODY_PHRASES = [
  'for yderligere information', 'for yderligere oplysninger', 'for mere information kontakt',
  'om virksomheden', 'om os:', 'kort om', 'kort fortalt om',
  'pressekontakt', 'pressefoto', 'pressebillede', 'pressebilleder',
  'med venlig hilsen kommunikation', 'kommunikationsafdelingen',
  'kontakt for pressen', 'pressen kan kontakte'
];

// Danske phishing-templates
const PHISHING_PHRASES = [
  'betaling afvist', 'betaling fejlede', 'betalingen blev afvist',
  'opdater dit kreditkort', 'opdater dine kortoplysninger', 'opdater betalingsoplysninger',
  'verificer din konto', 'verificér din konto', 'bekræft din konto', 'bekræft din identitet',
  'din konto bliver suspenderet', 'din konto er suspenderet', 'din konto bliver lukket',
  'midlertidigt suspenderet', 'midlertidig suspendering',
  'klik her for at undgå', 'klik her for at bekræfte', 'klik her for at fortsætte',
  'verifikationsproces', 'verifikations-proces',
  'blå verifikation', 'blåt verifikationsmærke', 'verifikationsmærke',
  'pakke kunne ikke leveres', 'pakken venter', 'told gebyr', 'told-gebyr', 'fortoldningsgebyr',
  'din mfa', 'din 2fa', 'din to-faktor',
  'mistænkelig aktivitet', 'usædvanlig aktivitet', 'usædvanlig log-in',
  'undgå afbrydelse', 'undgå at miste adgang',
  'nemid', 'mitid udløber', 'mit-id udløber',
  'din regning', 'ubetalt regning', 'ubetalt faktura forfalden'
];

const HTML_TO_TEXT_OPTS = {
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { hideLinkHrefIfSameAsText: true, ignoreHref: false } },
    { selector: 'img', format: 'skip' },
    { selector: 'style', format: 'skip' },
    { selector: 'script', format: 'skip' }
  ]
};

function lower(s) { return (s || '').toString().toLowerCase(); }

function isHtml(s) {
  return /<\/?[a-z][\s\S]*?>/i.test(s || '');
}

function stripHtml(s) {
  if (!s) return '';
  if (!isHtml(s)) return s;
  try { return htmlToText(s, HTML_TO_TEXT_OPTS); }
  catch { return s.replace(/<[^>]+>/g, ' '); }
}

function detectLanguage(text) {
  const t = (text || '').trim();
  if (t.length < 30) return { lang: 'und', confident: false };
  const code = franc(t, { minLength: 20, only: ['dan', 'eng', 'nob', 'swe', 'deu', 'fra', 'spa', 'por', 'ita', 'pol', 'rus', 'tur'] });
  return { lang: code, confident: code !== 'und' };
}

function hasDanishChars(text) {
  return /[æøåÆØÅ]/.test(text || '');
}

function countMatches(text, phrases) {
  const t = lower(text);
  let n = 0;
  const hits = [];
  for (const p of phrases) {
    if (t.includes(p)) {
      n++;
      hits.push(p);
    }
  }
  return { n, hits };
}

function extractLinks(html) {
  const links = [];
  if (!html) return links;
  const anchorRe = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1].trim();
    const anchorText = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    links.push({ href, anchorText });
  }
  const bareUrlRe = /(?<!["'=])\bhttps?:\/\/[^\s<>"')\]]+/gi;
  let bm;
  while ((bm = bareUrlRe.exec(html)) !== null) {
    links.push({ href: bm[0], anchorText: bm[0] });
  }
  return links;
}

function urlHost(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ''; }
}

function analyzeLinks(html) {
  const links = extractLinks(html);
  const hosts = links.map(l => urlHost(l.href)).filter(Boolean);
  const uniqueHosts = new Set(hosts);
  const shortened = hosts.filter(h => URL_SHORTENERS.has(h)).length;
  const ipUrls = hosts.filter(h => /^\d{1,3}(\.\d{1,3}){3}$/.test(h)).length;
  const suspiciousTld = hosts.filter(h => SUSPICIOUS_TLDS.some(t => h.endsWith(t))).length;

  let mismatched = 0;
  for (const l of links) {
    if (!l.anchorText || l.anchorText === l.href) continue;
    const looksLikeUrl = /\b[a-z0-9-]+\.(com|dk|net|org|io|co)\b/i.test(l.anchorText);
    if (!looksLikeUrl) continue;
    const anchorHost = urlHost(l.anchorText.startsWith('http') ? l.anchorText : 'http://' + l.anchorText);
    const realHost = urlHost(l.href);
    if (anchorHost && realHost && !realHost.endsWith(anchorHost) && !anchorHost.endsWith(realHost)) {
      mismatched++;
    }
  }

  return {
    total: links.length,
    uniqueHosts: uniqueHosts.size,
    shortened,
    ipUrls,
    suspiciousTld,
    mismatched
  };
}

function detectTrackingPixels(html) {
  if (!html) return 0;
  const re = /<img\b[^>]*(?:width\s*=\s*["']?1["']?[^>]*height\s*=\s*["']?1["']?|height\s*=\s*["']?1["']?[^>]*width\s*=\s*["']?1["']?)/gi;
  const m = html.match(re);
  return m ? m.length : 0;
}

function htmlToTextRatio(html, text) {
  if (!html) return 0;
  const tags = (html.match(/<[^>]+>/g) || []).length;
  const textLen = (text || '').length;
  return textLen === 0 ? 999 : tags / textLen;
}

function emailDomain(email) {
  const m = /([^@\s]+)@([^@\s]+)/.exec(email || '');
  return m ? m[2].toLowerCase() : '';
}

function looksLikeDanishPhone(phone) {
  if (!phone) return false;
  const digits = phone.replace(/\D+/g, '');
  if (digits.startsWith('45') && digits.length === 10) return true;
  if (digits.length === 8) return true;
  return false;
}

function emailLocalpart(email) {
  const m = /([^@\s]+)@/.exec(email || '');
  return m ? m[1].toLowerCase().split('+')[0] : '';
}

function isPressRelease(subject, bodyText, contact) {
  const subj = lower(subject);
  const reasons = [];

  for (const p of PRESS_SUBJECT_PREFIXES) {
    if (subj.startsWith(p)) {
      reasons.push(`Emne starter med "${p.trim()}"`);
      break;
    }
  }

  const local = emailLocalpart(contact && contact.email);
  if (local && PRESS_SENDER_LOCALPARTS.has(local)) {
    reasons.push(`Afsender-mailbox "${local}@…"`);
  }

  const dom = emailDomain(contact && contact.email);
  if (dom && PRESS_SENDER_DOMAINS.has(dom)) {
    reasons.push(`Pressekanal-domæne (${dom})`);
  }

  const bodyHits = countMatches(bodyText, PRESS_BODY_PHRASES);
  if (bodyHits.n >= 2) reasons.push(`PR-boilerplate (${bodyHits.n} fraser)`);

  if (/^pm\b[\s.:-]/i.test(subject)) reasons.push('"PM" prefix');

  return { isPress: reasons.length > 0, reasons };
}

function detectOpsigelse(subject, bodyText) {
  const subj = lower(subject).trim();
  const reasons = [];

  for (const prefix of OPSIGELSE_SUBJECT_PREFIXES) {
    if (subj.startsWith(prefix)) {
      reasons.push(`Emne starter med "${prefix.trim()}"`);
      break;
    }
  }

  // Tjek kun de første ~800 tegn af body for at undgå at fange opsigelses-ord
  // i lange e-mailtråde, signaturer osv.
  const earlyBody = (bodyText || '').slice(0, 800);
  const hits = countMatches(earlyBody, OPSIGELSE_PHRASES);
  if (hits.n > 0) {
    reasons.push(`Opsigelses-fraser: ${hits.hits.slice(0, 3).join(', ')}`);
  }

  return { isOpsigelse: reasons.length > 0, reasons };
}

function detectPhishing(text, contact) {
  const hits = countMatches(text, PHISHING_PHRASES);
  if (!hits.n) return { isPhish: false, reasons: [] };

  const reasons = [`Phishing-fraser: ${hits.hits.slice(0, 3).join(', ')}`];
  const domain = emailDomain(contact && contact.email);
  if (domain && !domain.endsWith('.dk')) reasons.push(`Afsender ikke .dk (${domain})`);
  if (domain && FREE_EMAIL_DOMAINS.has(domain)) reasons.push(`Free-mail afsender (${domain})`);

  const strong = hits.n >= 2 || (hits.n >= 1 && domain && !domain.endsWith('.dk'));
  return { isPhish: strong, reasons };
}

function classifyTicket(ticket, contacts) {
  const props = ticket.properties || {};
  const subject = props.subject || '';
  const rawBody = props.content || '';
  const bodyText = stripHtml(rawBody);
  const text = `${subject}\n${bodyText}`;
  const contact = contacts[0] || {};
  const senderEmail = (contact.email || '').toLowerCase();
  const lang = detectLanguage(bodyText);
  const isDanish = lang.lang === 'dan' || (!lang.confident && hasDanishChars(text));

  // Override 0a: Opsigelse → opsigelse-bucket (kritisk - skal fanges først)
  const ops = detectOpsigelse(subject, bodyText);
  if (ops.isOpsigelse) {
    return {
      verdict: 'opsigelse',
      spamScore: 0,
      leadScore: 0,
      spamProbability: 0,
      reasons: { spam: [], lead: [], opsigelse: ops.reasons },
      bypassLlm: true
    };
  }

  // Override 0b: Egen formular-afsender → lead (springer LLM over)
  if (LEAD_FORM_SENDERS.has(senderEmail)) {
    return {
      verdict: 'lead',
      spamScore: 0,
      leadScore: 100,
      spamProbability: 0,
      reasons: { spam: [], lead: [`Formular-indsendelse via ${senderEmail}`] },
      bypassLlm: true
    };
  }

  // Override 0c: Spec-baserede regler (decision order matcher spec).
  // Fanger kendte spam-domæner/afsendere, FB-phishing, officiel impersonation,
  // domænesvindel, dansk phishing, 419, kold pitch, SEO og pressemeddelelses-domæner.
  const spec = spamRules.applySpecRules({ subject, bodyText, contact });
  if (spec) {
    if (spec.verdict === 'pressemeddelelse') {
      return {
        verdict: 'pressemeddelelse',
        spamScore: 0,
        leadScore: 0,
        spamProbability: 0,
        reasons: { spam: [], lead: [], press: spec.reasons },
        bypassLlm: true
      };
    }
    return {
      verdict: 'spam',
      spamScore: 100,
      leadScore: 0,
      spamProbability: 100,
      reasons: { spam: spec.reasons, lead: [] },
      spamCategory: spec.category,
      bypassLlm: true
    };
  }

  // Override 1: Pressemeddelelse → egen bucket
  const press = isPressRelease(subject, bodyText, contact);
  if (press.isPress) {
    return {
      verdict: 'pressemeddelelse',
      spamScore: 0,
      leadScore: 0,
      spamProbability: 0,
      reasons: { spam: [], lead: [], press: press.reasons }
    };
  }

  // Override 2: Outreach/samarbejds-pitch på ikke-dansk → spam
  const outreachHits = countMatches(text, OUTREACH_PHRASES);
  if (outreachHits.n > 0 && !isDanish) {
    return {
      verdict: 'spam',
      spamScore: 100,
      leadScore: 0,
      spamProbability: 100,
      reasons: {
        spam: [
          `Outreach på ikke-dansk: ${outreachHits.hits.slice(0, 3).join(', ')}`,
          `Sprog: ${lang.lang || 'ikke dansk'}`
        ],
        lead: []
      }
    };
  }

  // Override 3: Phishing-template → spam
  const phish = detectPhishing(text, contact);
  if (phish.isPhish) {
    return {
      verdict: 'spam',
      spamScore: 100,
      leadScore: 0,
      spamProbability: 100,
      reasons: { spam: phish.reasons, lead: [] }
    };
  }

  const reasons = { spam: [], lead: [] };
  let spamScore = 0;
  let leadScore = 0;

  const spamHits = countMatches(text, SPAM_PHRASES);
  spamScore += spamHits.n * 25;
  if (spamHits.n) reasons.spam.push(`Spam-fraser: ${spamHits.hits.slice(0, 4).join(', ')}`);

  const leadHits = countMatches(text, LEAD_PHRASES);
  leadScore += leadHits.n * 18;
  if (leadHits.n) reasons.lead.push(`Lead-fraser: ${leadHits.hits.slice(0, 4).join(', ')}`);

  if (lang.lang === 'dan') {
    leadScore += 30;
    reasons.lead.push('Sprog: dansk');
  } else if (lang.lang === 'eng' && bodyText.length > 100) {
    spamScore += 20;
    reasons.spam.push('Sprog: engelsk');
  } else if (lang.confident && lang.lang !== 'dan' && lang.lang !== 'eng') {
    spamScore += 25;
    reasons.spam.push(`Sprog: ${lang.lang}`);
  } else if (hasDanishChars(text)) {
    leadScore += 15;
    reasons.lead.push('Indeholder æ/ø/å');
  }

  // Soft phishing-signal (1 frase, dansk afsender) - boost uden override
  if (phish.reasons.length && !phish.isPhish) {
    spamScore += 25;
    reasons.spam.push('Phishing-signal: ' + phish.reasons[0]);
  }

  const linkStats = analyzeLinks(rawBody);
  if (linkStats.shortened > 0) {
    spamScore += 20 * linkStats.shortened;
    reasons.spam.push(`${linkStats.shortened} link-shortener(s)`);
  }
  if (linkStats.suspiciousTld > 0) {
    spamScore += 15 * linkStats.suspiciousTld;
    reasons.spam.push(`${linkStats.suspiciousTld} link(s) med mistænkelig TLD`);
  }
  if (linkStats.ipUrls > 0) {
    spamScore += 30;
    reasons.spam.push('Link med rå IP-adresse');
  }
  if (linkStats.mismatched > 0) {
    spamScore += 25;
    reasons.spam.push(`${linkStats.mismatched} link(s) hvor anchor-tekst ikke matcher href`);
  }
  if (linkStats.uniqueHosts >= 8) {
    spamScore += 15;
    reasons.spam.push(`${linkStats.uniqueHosts} unikke domæner i links`);
  }

  const pixels = detectTrackingPixels(rawBody);
  if (pixels > 0) {
    spamScore += 10;
    reasons.spam.push(`${pixels} tracking-pixel(s)`);
  }

  const tagRatio = htmlToTextRatio(rawBody, bodyText);
  if (tagRatio > 0.5 && bodyText.length < 200) {
    spamScore += 15;
    reasons.spam.push('Næsten kun HTML, lidt tekst');
  }

  if (/dear (sir|madam|owner|ceo|admin)/i.test(text) || /to whom it may concern/i.test(text)) {
    spamScore += 30;
    reasons.spam.push('Generisk hilsen');
  }

  if (/^(hej|hejsa|godmorgen|god morgen|god dag|kære|hej team|hej vores digital)/i.test(subject) ||
      /^(hej|hejsa|godmorgen|god morgen|god dag|kære)/im.test(bodyText.slice(0, 200))) {
    leadScore += 10;
    reasons.lead.push('Dansk hilsen');
  }

  const email = contact.email || '';
  const domain = emailDomain(email);
  if (domain) {
    if (domain.endsWith('.dk')) {
      leadScore += 25;
      reasons.lead.push(`.dk-afsender (${domain})`);
    }
    if (FREE_EMAIL_DOMAINS.has(domain)) {
      spamScore += 5;
      reasons.spam.push(`Fri-mail (${domain})`);
    }
    for (const tld of SUSPICIOUS_TLDS) {
      if (domain.endsWith(tld)) {
        spamScore += 30;
        reasons.spam.push(`Mistænkelig TLD (${tld})`);
        break;
      }
    }
  }

  if (looksLikeDanishPhone(contact.phone)) {
    leadScore += 15;
    reasons.lead.push('Dansk telefonnummer');
  }

  if (subject && subject.length < 6) {
    spamScore += 10;
    reasons.spam.push('Meget kort emne');
  }

  if (bodyText && bodyText.length > 4000) {
    spamScore += 10;
    reasons.spam.push('Meget lang body');
  }

  if (/\b(unsubscribe|opt out|opt-out)\b/i.test(text)) {
    spamScore += 25;
    reasons.spam.push('Unsubscribe-tekst');
  }

  if (/(cvr[\s:.-]*\d{8})/i.test(text)) {
    leadScore += 20;
    reasons.lead.push('CVR-nummer nævnt');
  }

  const total = spamScore + leadScore;
  const spamProbability = total === 0 ? 0.4 : spamScore / total;

  let verdict;
  if (spamScore >= 50 && spamScore - leadScore >= 20) verdict = 'spam';
  else if (leadScore >= 30 && leadScore > spamScore) verdict = 'lead';
  else verdict = 'usikker';

  return {
    verdict,
    spamScore,
    leadScore,
    spamProbability: Math.round(spamProbability * 100),
    reasons
  };
}

function snippet(text, n = 220) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

async function safe(promise, label) {
  try { return await promise; }
  catch (err) {
    console.warn(`[advarsel] ${label}: ${err.message.slice(0, 200)}`);
    return null;
  }
}

async function buildPayload() {
  const pipeline = await resolvePipeline();
  const tickets = await fetchTicketsForPipeline(pipeline.id, pipeline.stageId);
  const ids = tickets.map(t => t.id);
  const ticketToContacts = (await safe(fetchAssociatedContacts(ids), 'associations')) || new Map();
  const allContactIds = [...new Set([...ticketToContacts.values()].flat())];
  const contactMap = (await safe(fetchContacts(allContactIds), 'contacts')) || new Map();

  // Auto-arkivér tickets fra blokerede afsendere før klassificering
  const blocklistData = blocklist.load();
  const blockedIds = [];
  const visibleTickets = tickets.filter(t => {
    const contactIds = ticketToContacts.get(t.id) || [];
    const contacts = contactIds.map(id => contactMap.get(id)).filter(Boolean);
    const email = (contacts[0] || {}).email;
    if (email && blocklist.isBlocked(email, blocklistData)) {
      blockedIds.push(t.id);
      return false;
    }
    return true;
  });
  let blockedAutoArchived = 0;
  if (blockedIds.length) {
    try {
      await archiveTicketIds(blockedIds);
      blockedAutoArchived = blockedIds.length;
      console.log(`[blocklist] auto-arkiveret ${blockedIds.length} tickets fra blokerede afsendere`);
    } catch (err) {
      console.warn(`[blocklist] auto-arkivering fejlede: ${err.message}`);
    }
  }

  const enriched = visibleTickets.map(t => {
    const props = t.properties || {};
    const contactIds = ticketToContacts.get(t.id) || [];
    const contacts = contactIds.map(id => contactMap.get(id)).filter(Boolean);
    const classification = classifyTicket(t, contacts);
    const cleanBody = stripHtml(props.content || '');
    return {
      id: t.id,
      subject: props.subject || '(uden emne)',
      bodySnippet: snippet(cleanBody),
      bodyFull: cleanBody,
      bodyText: cleanBody,
      stage: pipeline.stages[props.hs_pipeline_stage] || props.hs_pipeline_stage || '',
      priority: props.hs_ticket_priority || '',
      source: props.hs_object_source_label || props.source_type || '',
      createdate: props.createdate,
      lastModified: props.hs_lastmodifieddate,
      contact: contacts[0] || null,
      hubspotUrl: PORTAL_ID
        ? `https://app-eu1.hubspot.com/contacts/${PORTAL_ID}/record/0-5/${t.id}`
        : `https://app-eu1.hubspot.com/contacts/_/ticket/${t.id}`,
      ...classification
    };
  });

  // LLM second pass: kun lead + usikker (regler er allerede sikre på spam/pressemeddelelse)
  const llmCandidates = enriched
    .filter(t => (t.verdict === 'lead' || t.verdict === 'usikker') && !t.bypassLlm)
    .map(t => ({ ...t, preVerdict: t.verdict }));

  const llmStart = Date.now();
  const llmRes = await llm.classifyBatch(llmCandidates, {
    apiKey: OPENAI_API_KEY,
    model: OPENAI_MODEL,
    maxCalls: LLM_MAX_PER_REFRESH
  });
  const llmMs = Date.now() - llmStart;
  console.log(`[llm] kandidater=${llmCandidates.length} stats=${JSON.stringify(llmRes.stats)} tid=${llmMs}ms`);

  for (const t of enriched) {
    const verdict = llmRes.results.get(t.id);
    if (!verdict) continue;
    t.ruleVerdict = t.verdict;
    t.verdict = verdict.verdict;
    t.llm = {
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      begrundelse: verdict.begrundelse,
      cached: !!verdict.cached
    };
  }

  // Manuelle verdict-overrides vinder over alt andet
  const overrides = verdictOverrides.load();
  let manualOverrideCount = 0;
  for (const t of enriched) {
    const ov = overrides[t.id];
    if (!ov) continue;
    if (t.verdict !== ov.verdict) {
      t.autoVerdict = t.verdict;
      t.verdict = ov.verdict;
    }
    t.manualOverride = { verdict: ov.verdict, setAt: ov.setAt };
    manualOverrideCount++;
  }

  const buckets = {
    leads: enriched.filter(t => t.verdict === 'lead'),
    spam: enriched.filter(t => t.verdict === 'spam'),
    usikker: enriched.filter(t => t.verdict === 'usikker'),
    pressemeddelelser: enriched.filter(t => t.verdict === 'pressemeddelelse'),
    opsigelser: enriched.filter(t => t.verdict === 'opsigelse')
  };

  return {
    pipeline: { id: pipeline.id, label: pipeline.label, stage: pipeline.stageLabel },
    fetchedAt: new Date().toISOString(),
    llm: { model: OPENAI_MODEL, ...llmRes.stats, durationMs: llmMs },
    manualOverrides: manualOverrideCount,
    blocklist: {
      emails: blocklistData.emails.length,
      domains: blocklistData.domains.length,
      autoArchived: blockedAutoArchived
    },
    counts: {
      total: enriched.length,
      leads: buckets.leads.length,
      spam: buckets.spam.length,
      usikker: buckets.usikker.length,
      pressemeddelelser: buckets.pressemeddelelser.length,
      opsigelser: buckets.opsigelser.length
    },
    tickets: enriched
  };
}

app.get('/api/tickets', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    if (!force && cache.payload && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      return res.json(cache.payload);
    }
    const payload = await buildPayload();
    cache = { fetchedAt: Date.now(), payload };
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

async function ensurePayload() {
  if (cache.payload && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.payload;
  const payload = await buildPayload();
  cache = { fetchedAt: Date.now(), payload };
  return payload;
}

function findTicketsBySender(payload, { email, domain }) {
  const e = (email || '').toLowerCase().trim();
  const d = (domain || '').toLowerCase().trim().replace(/^@/, '');
  if (!e && !d) return [];
  return payload.tickets.filter(t => {
    const c = t.contact || {};
    const senderEmail = (c.email || '').toLowerCase();
    if (e) return senderEmail === e;
    const senderDomain = (senderEmail.split('@')[1] || '').toLowerCase();
    return senderDomain === d;
  });
}

// Preview: hvor mange tickets matcher denne afsender (email eller domain)?
app.get('/api/tickets/by-sender', async (req, res) => {
  try {
    const { email, domain } = req.query;
    if (!email && !domain) return res.status(400).json({ error: 'email eller domain mangler' });
    const payload = await ensurePayload();
    const matches = findTicketsBySender(payload, { email, domain });
    res.json({
      email: email || null,
      domain: domain || null,
      count: matches.length,
      sample: matches.slice(0, 5).map(t => ({
        id: t.id,
        subject: t.subject,
        verdict: t.verdict,
        createdate: t.createdate,
        contactEmail: (t.contact || {}).email || null
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Arkivér alle tickets fra én afsender (email eller domain).
// Hvis body.block === true, tilføjes også afsenderen til bloklisten på samme niveau.
app.post('/api/tickets/archive-by-sender', async (req, res) => {
  try {
    const email = ((req.body && req.body.email) || '').toLowerCase().trim();
    const domain = ((req.body && req.body.domain) || '').toLowerCase().trim().replace(/^@/, '');
    const block = !!(req.body && req.body.block);
    if (!email && !domain) return res.status(400).json({ error: 'email eller domain mangler' });

    const payload = await ensurePayload();
    const matches = findTicketsBySender(payload, { email, domain });
    let archived = 0;
    if (matches.length) {
      const ids = matches.map(t => t.id);
      await archiveTicketIds(ids);
      archived = ids.length;
      cache = { fetchedAt: 0, payload: null };
      console.log(`[archive] ${ids.length} tickets fra ${email || '@' + domain} arkiveret`);
    }

    let blocked = false;
    if (block) {
      if (email) blocklist.addEmail(email);
      else blocklist.addDomain(domain);
      blocked = true;
      console.log(`[blocklist] tilføjet ${email || domain}`);
    }

    res.json({ archived, blocked, email: email || null, domain: domain || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Opsigelser: flyt alle opsigelses-tickets til Intern Support / New pipeline
// så internt team kan håndtere kontraktopsigelser separat.
const INTERN_SUPPORT_PIPELINE_ID = '25053937';
const INTERN_SUPPORT_NEW_STAGE_ID = '78372571';

async function moveTicketsToInternalNew(ids) {
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const resp = await fetch(`${HS}/crm/v3/objects/tickets/batch/update`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        inputs: chunk.map(id => ({
          id,
          properties: {
            hs_pipeline: INTERN_SUPPORT_PIPELINE_ID,
            hs_pipeline_stage: INTERN_SUPPORT_NEW_STAGE_ID
          }
        }))
      })
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`HubSpot ${resp.status}: ${txt.slice(0, 300)}`);
    }
  }
}

app.post('/api/opsigelser/move-to-internal', async (_req, res) => {
  try {
    const payload = await ensurePayload();
    const opsigelser = payload.tickets.filter(t => t.verdict === 'opsigelse');
    if (!opsigelser.length) return res.json({ moved: 0, message: 'Ingen opsigelser at flytte' });

    const ids = opsigelser.map(t => t.id);
    await moveTicketsToInternalNew(ids);
    cache = { fetchedAt: 0, payload: null };
    console.log(`[opsigelser] ${ids.length} flyttet til Intern Support / New`);
    res.json({ moved: ids.length, ids });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets/:id/move-to-internal', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'ticket id mangler' });
    await moveTicketsToInternalNew([id]);
    cache = { fetchedAt: 0, payload: null };
    console.log(`[move-to-internal] ticket ${id} flyttet til Intern Support / New`);
    res.json({ moved: 1, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/usikker/move-to-internal', async (_req, res) => {
  try {
    const payload = await ensurePayload();
    const usikker = payload.tickets.filter(t => t.verdict === 'usikker');
    if (!usikker.length) return res.json({ moved: 0, message: 'Ingen andre henvendelser at flytte' });

    const ids = usikker.map(t => t.id);
    await moveTicketsToInternalNew(ids);
    cache = { fetchedAt: 0, payload: null };
    console.log(`[usikker] ${ids.length} andre henvendelser flyttet til Intern Support / New`);
    res.json({ moved: ids.length, ids });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Pressemeddelelser: send pm-template til hver unik afsender, arkivér deres tickets,
// og bloker deres email-adresser fremadrettet.
app.get('/api/press/preview', async (_req, res) => {
  try {
    const payload = await ensurePayload();
    const press = payload.tickets.filter(t => t.verdict === 'pressemeddelelse');
    const senderToTickets = new Map();
    for (const t of press) {
      const e = ((t.contact || {}).email || '').toLowerCase().trim();
      if (!e || !e.includes('@')) continue;
      if (!senderToTickets.has(e)) senderToTickets.set(e, []);
      senderToTickets.get(e).push(t);
    }
    const noContact = press.filter(t => !((t.contact || {}).email));

    let template = null;
    let templateError = null;
    try {
      template = JSON.parse(fs.readFileSync(path.join(__dirname, 'pm-template.json'), 'utf8'));
    } catch (err) {
      templateError = err.message;
    }

    res.json({
      pressTotal: press.length,
      uniqueSenders: senderToTickets.size,
      ticketsWithoutContact: noContact.length,
      apiKeyConfigured: !!VORESDIGITAL_API_KEY,
      template: template ? { subject: template.subject, bodyLength: (template.body || '').length } : null,
      templateError,
      sampleSenders: [...senderToTickets.entries()].slice(0, 5).map(([email, ts]) => ({
        email,
        ticketCount: ts.length,
        sampleSubject: ts[0].subject
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/press/handle', async (_req, res) => {
  try {
    if (!VORESDIGITAL_API_KEY) return res.status(400).json({ error: 'VORESDIGITAL_API_KEY mangler i .env' });

    let template;
    try {
      template = JSON.parse(fs.readFileSync(path.join(__dirname, 'pm-template.json'), 'utf8'));
    } catch (err) {
      return res.status(500).json({ error: 'Kunne ikke læse pm-template.json: ' + err.message });
    }
    if (!template.subject || !template.body) {
      return res.status(400).json({ error: 'pm-template.json skal indeholde "subject" og "body"' });
    }

    const payload = await ensurePayload();
    const press = payload.tickets.filter(t => t.verdict === 'pressemeddelelse');
    const senderToTickets = new Map();
    for (const t of press) {
      const e = ((t.contact || {}).email || '').toLowerCase().trim();
      if (!e || !e.includes('@')) continue;
      if (!senderToTickets.has(e)) senderToTickets.set(e, []);
      senderToTickets.get(e).push(t);
    }

    const sentEmails = [];
    const failedEmails = [];
    const archivedIds = [];
    const blockedEmails = [];

    for (const [email, tickets] of senderToTickets.entries()) {
      try {
        const resp = await fetch('https://api.voresdigital.dk/data/email/send', {
          method: 'POST',
          headers: { 'X-ApiKey': VORESDIGITAL_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject: template.subject,
            body: template.body,
            recipientEmail: email
          })
        });
        if (!resp.ok) {
          const txt = await resp.text();
          failedEmails.push({ email, error: `${resp.status}: ${txt.slice(0, 200)}` });
          continue;
        }
        sentEmails.push(email);
        archivedIds.push(...tickets.map(t => t.id));
        try {
          blocklist.addEmail(email);
          blockedEmails.push(email);
        } catch { /* skip ugyldig */ }
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        failedEmails.push({ email, error: err.message });
      }
    }

    let archived = 0;
    let archiveError = null;
    if (archivedIds.length) {
      try {
        await archiveTicketIds(archivedIds);
        archived = archivedIds.length;
        cache = { fetchedAt: 0, payload: null };
      } catch (err) {
        archiveError = err.message;
      }
    }

    console.log(`[press] sendt=${sentEmails.length} fejlet=${failedEmails.length} arkiveret=${archived} blokeret=${blockedEmails.length}`);
    res.json({
      sent: sentEmails.length,
      failed: failedEmails.length,
      archived,
      blocked: blockedEmails.length,
      archiveError,
      failedEmails
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk: arkivér alle tickets i én verdict-bucket + bloker unikke afsendere.
// Bruges til "tøm spam-bunken på én gang"-knappen.
app.post('/api/tickets/archive-bucket', async (req, res) => {
  try {
    const verdict = (req.body && req.body.verdict || '').trim();
    const block = !!(req.body && req.body.block);
    if (!verdict) return res.status(400).json({ error: 'verdict mangler' });

    const payload = await ensurePayload();
    const matches = payload.tickets.filter(t => t.verdict === verdict);
    if (!matches.length) return res.json({ archived: 0, blocked: 0, verdict });

    const ids = matches.map(t => t.id);
    await archiveTicketIds(ids);

    let blockedCount = 0;
    const blockedEmails = [];
    if (block) {
      const uniqueEmails = [...new Set(
        matches
          .map(t => ((t.contact && t.contact.email) || '').toLowerCase().trim())
          .filter(e => e && e.includes('@'))
      )];
      for (const email of uniqueEmails) {
        try {
          blocklist.addEmail(email);
          blockedCount++;
          blockedEmails.push(email);
        } catch { /* skip ugyldig */ }
      }
    }

    cache = { fetchedAt: 0, payload: null };
    console.log(`[archive-bucket] ${ids.length} ${verdict}-tickets arkiveret, ${blockedCount} afsendere blokeret`);
    res.json({ archived: ids.length, blocked: blockedCount, blockedEmails, verdict });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Manuel verdict-override pr. ticket — flyt en ticket mellem buckets.
app.post('/api/tickets/:id/verdict', (req, res) => {
  try {
    const id = req.params.id;
    const verdict = (req.body && req.body.verdict || '').trim();
    const stored = verdictOverrides.set(id, verdict);
    cache = { fetchedAt: 0, payload: null };
    console.log(`[override] ${id} -> ${verdict}`);
    res.json({ id, ...stored });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/tickets/:id/verdict', (req, res) => {
  const removed = verdictOverrides.remove(req.params.id);
  cache = { fetchedAt: 0, payload: null };
  res.json({ id: req.params.id, removed: !!removed });
});

// Blocklist CRUD
app.get('/api/blocklist', (_req, res) => {
  res.json(blocklist.load());
});

app.post('/api/blocklist', (req, res) => {
  try {
    const { email, domain } = req.body || {};
    let data;
    if (email) data = blocklist.addEmail(email);
    else if (domain) data = blocklist.addDomain(domain);
    else return res.status(400).json({ error: 'email eller domain skal angives' });
    cache = { fetchedAt: 0, payload: null };
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/blocklist', (req, res) => {
  const value = (req.query.value || '').toLowerCase().trim();
  if (!value) return res.status(400).json({ error: 'value mangler' });
  const data = blocklist.removeEntry(value);
  cache = { fetchedAt: 0, payload: null };
  res.json(data);
});

// Returnerer hvor mange leads der ville blive sendt + destination for preview
app.get('/api/leads/forward/preview', async (_req, res) => {
  try {
    const payload = await ensurePayload();
    const leads = payload.tickets.filter(t => t.verdict === 'lead');
    res.json({
      count: leads.length,
      to: FORWARD_LEADS_TO || '(default fra API)',
      apiKeyConfigured: !!VORESDIGITAL_API_KEY,
      sample: leads.slice(0, 5).map(t => ({
        subject: t.subject,
        contactEmail: (t.contact || {}).email || null
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Sender hver aktuel lead som sin egen mail via Vores Digital intern email-API.
// Kun successfully-sendte tickets arkiveres bagefter — fejlede sends arkiveres ikke
// så brugeren kan retry uden duplikat-mails.
app.post('/api/leads/forward', async (_req, res) => {
  try {
    if (!VORESDIGITAL_API_KEY) return res.status(400).json({ error: 'VORESDIGITAL_API_KEY mangler i .env' });

    const payload = await ensurePayload();
    const leads = payload.tickets.filter(t => t.verdict === 'lead');
    if (!leads.length) return res.json({ sent: 0, failed: 0, archived: 0, message: 'Ingen leads at sende' });

    const result = await forward.sendLeadsIndividually({
      leads,
      config: { apiKey: VORESDIGITAL_API_KEY, to: FORWARD_LEADS_TO || null }
    });
    console.log(`[forward] sendt=${result.sent} fejlet=${result.failed} til ${result.to}`);
    if (result.errors.length) {
      result.errors.slice(0, 3).forEach(e => console.warn(`[forward] fejl på "${e.subject}": ${e.message}`));
    }

    // Flyt dem der blev sendt succesfuldt til stage="Closed" (id 4) i stedet for at
    // arkivere — så HubSpot-linket i mailen stadig virker for modtageren.
    let archived = 0;
    let archiveError = null;
    if (result.sentIds.length) {
      try {
        await moveTicketsToStage(result.sentIds, '4');
        archived = result.sentIds.length;
        cache = { fetchedAt: 0, payload: null };
        console.log(`[forward] ${archived} leads flyttet til Closed i HubSpot`);
      } catch (err) {
        archiveError = err.message;
        console.warn(`[forward] flytning til Closed fejlede: ${err.message}`);
      }
    }

    res.json({ ...result, archived, archiveError });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'leadssniffer.html'));
});

app.listen(PORT, () => {
  console.log(`Leadssniffer kører på http://localhost:${PORT}`);
});
