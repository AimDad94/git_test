require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = 3001;
const API_KEY = process.env.API_KEY;
const API_BASE = 'https://api.voresdigital.dk/data/customers/active';
const CACHE_TTL_MS = 60_000;

if (!API_KEY) {
  console.error('Missing API_KEY in .env');
  process.exit(1);
}

let cache = { fetchedAt: 0, payload: null };

async function fetchPage(page) {
  const res = await fetch(`${API_BASE}?page=${page}`, {
    headers: { 'X-ApiKey': API_KEY }
  });
  if (!res.ok) throw new Error(`Upstream page ${page} returned ${res.status}`);
  return res.json();
}

async function fetchAll() {
  const first = await fetchPage(1);
  const totalPages = first.totalPages || 1;
  if (totalPages === 1) return first.items;
  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2))
  );
  return [first.items, ...rest.map(p => p.items)].flat();
}

const WEIGHTS = { call: 40, satisfaction: 20, mrr: 15, invoice: 10, products: 8, binding: 7 };
const MRR_CAP = 10_000;
const MAX_PRODUCTS = 7;

function scoreCall(lastCallDate) {
  if (!lastCallDate) return WEIGHTS.call;
  const days = (Date.now() - new Date(lastCallDate).getTime()) / 86_400_000;
  if (days >= 30) return Math.min(WEIGHTS.call, 30 + (days - 30) / 15);
  return (days / 30) * 15;
}

function scoreSatisfaction(s) {
  if (s === 'Red') return WEIGHTS.satisfaction;
  if (s === 'Yellow') return 10;
  if (s === 'Green') return 0;
  return 2;
}

function scoreMRR(mrr) {
  return Math.min(WEIGHTS.mrr, ((mrr || 0) / MRR_CAP) * WEIGHTS.mrr);
}

function scoreInvoice(status) {
  return status === 'has_unpaid' ? WEIGHTS.invoice : 0;
}

function scoreProducts(products) {
  const n = Math.min(MAX_PRODUCTS, (products || []).length);
  return WEIGHTS.products * (1 - n / MAX_PRODUCTS);
}

function scoreBinding(bindingPeriod) {
  const end = bindingPeriod && bindingPeriod.end;
  const active = end && new Date(end).getTime() > Date.now();
  return active ? 0 : WEIGHTS.binding;
}

function scoreCustomer(c) {
  const breakdown = {
    call: scoreCall(c.lastCallDate),
    satisfaction: scoreSatisfaction(c.satisfactionScore),
    mrr: scoreMRR(c.mrr),
    invoice: scoreInvoice(c.invoiceStatus),
    products: scoreProducts(c.products),
    binding: scoreBinding(c.bindingPeriod)
  };
  const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
  return { total: Math.round(total * 10) / 10, breakdown };
}

function rankByContactPriority(customers) {
  return customers
    .map(c => ({ ...c, priority: scoreCustomer(c) }))
    .sort((a, b) => b.priority.total - a.priority.total);
}

app.get('/api/customers', async (_req, res) => {
  try {
    const now = Date.now();
    if (cache.payload && now - cache.fetchedAt < CACHE_TTL_MS) {
      return res.json({ ...cache.payload, cached: true });
    }
    const items = await fetchAll();
    const ranked = rankByContactPriority(items);
    cache = {
      fetchedAt: now,
      payload: {
        total: ranked.length,
        fetchedAt: new Date(now).toISOString(),
        items: ranked
      }
    };
    res.json({ ...cache.payload, cached: false });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'crm.manager.html'));
});

app.listen(PORT, () => {
  console.log(`CRM Manager running at http://localhost:${PORT}`);
});
