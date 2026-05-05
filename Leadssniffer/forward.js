// Email-forwarding via Vores Digitals interne email-API.
// Endpoint: POST https://api.voresdigital.dk/data/email/send
// Auth: X-ApiKey header
// Body: { subject, body (HTML), recipientEmail (optional) }
// Server bestemmer afsenderen.

const ENDPOINT = 'https://api.voresdigital.dk/data/email/send';

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('da-DK', {
      dateStyle: 'medium', timeStyle: 'short'
    });
  } catch { return iso; }
}

function contactLine(c) {
  if (!c) return '<em>Ingen kontakt knyttet</em>';
  const name = [c.firstname, c.lastname].filter(Boolean).join(' ');
  const parts = [];
  if (name) parts.push(escapeHtml(name));
  if (c.email) parts.push(escapeHtml(c.email));
  if (c.company) parts.push(escapeHtml(c.company));
  if (c.phone) parts.push(escapeHtml(c.phone));
  return parts.join(' · ') || '<em>Ukendt afsender</em>';
}

// HTML for én enkelt lead-mail. Inkluderer fuld body, ikke kun snippet.
function singleLeadHtml(t) {
  const reasons = (t.llm && t.llm.begrundelse) ? t.llm.begrundelse : '';
  const fullBody = t.bodyFull || t.bodySnippet || '';
  const c = t.contact || {};
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#faf7f2;color:#2b2521;padding:24px">
  <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #ece4da;border-radius:10px;padding:24px">
    <div style="border-bottom:2px solid #c2410c;padding-bottom:12px;margin-bottom:16px">
      <div style="font-size:11px;color:#7a6e66;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">
        Nyt lead · Leadssniffer
      </div>
      <div style="font-size:18px;font-weight:600;color:#2b2521">${escapeHtml(t.subject || '(uden emne)')}</div>
    </div>

    <table style="width:100%;font-size:13px;color:#2b2521;border-collapse:collapse;margin-bottom:16px">
      <tr>
        <td style="padding:4px 12px 4px 0;color:#7a6e66;width:90px;vertical-align:top">Fra:</td>
        <td style="padding:4px 0">${contactLine(c)}</td>
      </tr>
      ${t.createdate ? `<tr>
        <td style="padding:4px 12px 4px 0;color:#7a6e66;vertical-align:top">Modtaget:</td>
        <td style="padding:4px 0">${escapeHtml(fmtDate(t.createdate))}</td>
      </tr>` : ''}
      ${reasons ? `<tr>
        <td style="padding:4px 12px 4px 0;color:#7a6e66;vertical-align:top">AI-vurdering:</td>
        <td style="padding:4px 0;color:#6d28d9">${escapeHtml(reasons)}</td>
      </tr>` : ''}
    </table>

    <div style="background:#fbf8f3;border:1px solid #ece4da;border-radius:6px;padding:14px 16px;margin-bottom:16px">
      <div style="font-size:11px;color:#7a6e66;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Henvendelsens indhold</div>
      <div style="font-size:14px;line-height:1.55;color:#2b2521;white-space:pre-wrap">${escapeHtml(fullBody) || '<em>(intet body-indhold)</em>'}</div>
    </div>

    <a href="${escapeHtml(t.hubspotUrl || '#')}" style="display:inline-block;background:#c2410c;color:white;font-size:13px;padding:8px 14px;border-radius:5px;text-decoration:none;font-weight:500">Åbn i HubSpot →</a>

    <div style="border-top:1px solid #ece4da;margin-top:24px;padding-top:12px;font-size:11px;color:#7a6e66">
      Sendt automatisk af Leadssniffer.
    </div>
  </div>
</div>`;
}

async function sendViaVoresDigital({ apiKey, subject, body, recipientEmail }) {
  const payload = { subject, body };
  if (recipientEmail) payload.recipientEmail = recipientEmail;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'X-ApiKey': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Vores Digital email-API ${res.status}: ${txt.slice(0, 400)}`);
  }
  return { ok: true };
}

async function sendOneLead({ ticket, config }) {
  const subject = `[Nyt lead fra Leadsnifferen] ${ticket.subject || '(uden emne)'}`.slice(0, 250);
  const body = singleLeadHtml(ticket);
  await sendViaVoresDigital({
    apiKey: config.apiKey,
    subject,
    body,
    recipientEmail: config.to || null
  });
}

// Sender hver lead som sin egen email. Returnerer { sent, failed, sentIds, errors }.
// Kører sekventielt med en lille pause for at være pæn ved API'et.
async function sendLeadsIndividually({ leads, config }) {
  if (!config.apiKey) throw new Error('VORESDIGITAL_API_KEY mangler i .env');
  if (!leads.length) return { sent: 0, failed: 0, sentIds: [], errors: [] };

  const sentIds = [];
  const errors = [];
  for (const ticket of leads) {
    try {
      await sendOneLead({ ticket, config });
      sentIds.push(ticket.id);
      await new Promise(r => setTimeout(r, 150));
    } catch (err) {
      errors.push({ id: ticket.id, subject: ticket.subject, message: err.message });
    }
  }
  return {
    sent: sentIds.length,
    failed: errors.length,
    sentIds,
    errors,
    to: config.to || '(default)'
  };
}

module.exports = { sendLeadsIndividually };
