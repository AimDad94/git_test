const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_FILE = path.join(__dirname, 'llm-cache.json');
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const CONCURRENCY = 5;

const SYSTEM_PROMPT = `Du er klassifikator for Vores Digital, et dansk marketingbureau med egne nyhedsmedier.

Klassificér en HubSpot-ticket i én af fem kategorier:

- "opsigelse": Eksisterende kunde der opsiger eller annullerer en aftale, et abonnement eller et samarbejde. Skal fanges som første prioritet — det er kritisk for forretningen. Eksempler på sprog: "vi vil gerne opsige", "ønsker at afslutte aftalen", "annullér vores abonnement".
- "lead": Reel henvendelse fra en potentiel eller eksisterende kunde — fx samarbejde, annoncekøb, prisforespørgsel, support, faktura, login-problemer. SKAL være på dansk for at kunne være en lead. Hvis afsenderen pitcher link placements, guest posts, samarbejde, partnerskab eller content-deals på engelsk, er det ALTID spam.
- "spam": Uopfordret salgspitch (særligt link-placements, guest posts, SEO-services, web design-services), phishing (falske betalings-/verifikations-mails), junk. Engelske outreach-mails er pr. definition spam.
- "pressemeddelelse": Pressemeddelelse eller nyhedsudsendelse fra en virksomhed/myndighed/organisation der ønsker omtale. Typiske kendetegn: 3.persons-overskrift som "X gør Y", citater, "for yderligere information kontakt", "om virksomheden", virksomhedsboilerplate i bunden. Ikke en lead, ikke spam — bare pressestof.
- "usikker": Andre henvendelser som ikke er salgsleads, spam, pressemeddelelser eller opsigelser — fx generelle henvendelser, support-spørgsmål uden klar kommerciel intent, læserbreve, takke-mails, faktura-spørgsmål uden tydelig opsigelse, info-forespørgsler. Også når du virkelig ikke kan afgøre det.

Du SKAL returnere et gyldigt JSON-objekt med præcis disse felter:
{"verdict": "opsigelse" | "lead" | "spam" | "pressemeddelelse" | "usikker", "confidence": 0.0-1.0, "begrundelse": "kort dansk forklaring (max 20 ord)"}`;

let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache() {
  if (!cache) return;
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (err) {
    console.warn(`[llm] kunne ikke gemme cache: ${err.message}`);
  }
}

function hashContent(s) {
  return crypto.createHash('sha1').update(s || '').digest('hex').slice(0, 12);
}

function cacheKey(ticket) {
  const subj = ticket.subject || '';
  const body = ticket.bodyText || '';
  return `${ticket.id}-${hashContent(subj + '\n' + body)}`;
}

function clip(text, n) {
  if (!text) return '';
  return text.length > n ? text.slice(0, n) + '…[trunkeret]' : text;
}

function buildUserMessage(ticket) {
  const contact = ticket.contact || {};
  const lines = [];
  lines.push(`Emne: ${ticket.subject || '(uden emne)'}`);
  lines.push(`Afsender: ${contact.email || 'ukendt'}${contact.company ? ' · ' + contact.company : ''}`);
  lines.push(`Foreløbig regel-vurdering: ${ticket.preVerdict} (lead-score ${ticket.leadScore}, spam-score ${ticket.spamScore})`);
  lines.push('');
  lines.push('Body:');
  lines.push(clip(ticket.bodyText || '(ingen body)', 2500));
  return lines.join('\n');
}

async function callOpenAI({ apiKey, model, ticket }) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(ticket) }
      ]
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('OpenAI: tomt svar');
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`OpenAI: kunne ikke parse JSON: ${content.slice(0, 200)}`); }
  const verdict = parsed.verdict;
  if (!['lead', 'spam', 'pressemeddelelse', 'usikker', 'opsigelse'].includes(verdict)) {
    throw new Error(`OpenAI: ugyldig verdict "${verdict}"`);
  }
  return {
    verdict,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    begrundelse: parsed.begrundelse || ''
  };
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function take() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      try { results[idx] = await worker(items[idx], idx); }
      catch (err) { results[idx] = { error: err }; }
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, take);
  await Promise.all(runners);
  return results;
}

async function classifyBatch(tickets, { apiKey, model, maxCalls }) {
  if (!apiKey) return { results: new Map(), stats: { skipped: 'no-api-key' } };
  loadCache();

  const map = new Map();
  const toCall = [];
  for (const t of tickets) {
    const key = cacheKey(t);
    if (cache[key]) {
      map.set(t.id, { ...cache[key], cached: true });
    } else {
      toCall.push({ ticket: t, key });
    }
  }

  const budget = Math.min(toCall.length, maxCalls || toCall.length);
  const todo = toCall.slice(0, budget);
  const skipped = toCall.length - todo.length;

  let ok = 0, errs = 0;
  if (todo.length) {
    const out = await runPool(
      todo,
      async ({ ticket, key }) => {
        const result = await callOpenAI({ apiKey, model, ticket });
        cache[key] = { ...result, classifiedAt: new Date().toISOString() };
        return { ticket, result };
      },
      CONCURRENCY
    );
    for (const r of out) {
      if (r.error) {
        errs++;
        if (errs <= 3) console.warn(`[llm] fejl: ${r.error.message}`);
        continue;
      }
      ok++;
      map.set(r.ticket.id, { ...r.result, cached: false });
    }
    saveCache();
  }

  return {
    results: map,
    stats: {
      total: tickets.length,
      cached: map.size - ok,
      called: ok,
      errors: errs,
      skippedDueToBudget: skipped
    }
  };
}

module.exports = { classifyBatch };
