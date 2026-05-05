// Manuel verdict-override pr. ticket. Persisteres til disk så de overlever refreshs.
// Anvendes som SIDSTE skridt i klassificeringen — vinder over regler og LLM.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'verdict-overrides.json');
const VALID = new Set(['lead', 'spam', 'usikker', 'pressemeddelelse', 'opsigelse']);

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return (data && typeof data === 'object') ? data : {};
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function set(ticketId, verdict) {
  if (!ticketId) throw new Error('ticketId mangler');
  if (!VALID.has(verdict)) throw new Error(`ugyldig verdict "${verdict}"`);
  const data = load();
  data[String(ticketId)] = { verdict, setAt: new Date().toISOString() };
  save(data);
  return data[String(ticketId)];
}

function remove(ticketId) {
  if (!ticketId) return null;
  const data = load();
  const had = data[String(ticketId)];
  if (had) {
    delete data[String(ticketId)];
    save(data);
  }
  return had || null;
}

function get(ticketId, cached) {
  const data = cached || load();
  return data[String(ticketId)] || null;
}

module.exports = { load, save, set, remove, get, VALID: [...VALID] };
