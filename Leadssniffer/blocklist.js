const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'blocklist.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      emails: Array.isArray(data.emails) ? data.emails : [],
      domains: Array.isArray(data.domains) ? data.domains : []
    };
  } catch {
    return { emails: [], domains: [] };
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify({
    emails: [...new Set(data.emails)].sort(),
    domains: [...new Set(data.domains)].sort()
  }, null, 2));
}

function isBlocked(email, cached) {
  if (!email) return false;
  const data = cached || load();
  const e = email.toLowerCase().trim();
  if (data.emails.includes(e)) return true;
  const dom = (e.split('@')[1] || '').trim();
  if (dom && data.domains.includes(dom)) return true;
  return false;
}

function addEmail(email) {
  const e = (email || '').toLowerCase().trim();
  if (!e || !e.includes('@')) throw new Error('ugyldig email');
  const data = load();
  if (!data.emails.includes(e)) {
    data.emails.push(e);
    save(data);
  }
  return data;
}

function addDomain(domain) {
  const d = (domain || '').toLowerCase().trim().replace(/^@/, '');
  if (!d || !d.includes('.')) throw new Error('ugyldig domæne');
  const data = load();
  if (!data.domains.includes(d)) {
    data.domains.push(d);
    save(data);
  }
  return data;
}

function removeEntry(value) {
  const v = (value || '').toLowerCase().trim();
  if (!v) return load();
  const data = load();
  data.emails = data.emails.filter(e => e !== v);
  data.domains = data.domains.filter(d => d !== v);
  save(data);
  return data;
}

module.exports = { load, save, isBlocked, addEmail, addDomain, removeEntry };
