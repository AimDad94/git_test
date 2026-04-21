const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'Data');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadAll() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.csv'));
  let header = null;
  const records = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    const rows = parseCsv(text).filter(r => r.length > 1 || (r.length === 1 && r[0].length));
    if (!rows.length) continue;
    if (!header) header = rows[0];
    for (let i = 1; i < rows.length; i++) {
      const obj = {};
      for (let j = 0; j < header.length; j++) obj[header[j]] = rows[i][j] ?? '';
      obj.__file = f;
      records.push(obj);
    }
  }
  return { header, records };
}

function parseDkDate(s) {
  if (!s || s.startsWith('01/01/0001')) return null;
  const [date, time] = s.split(' ');
  const [mm, dd, yyyy] = date.split('/');
  const t = time ? time.split(':').map(Number) : [0, 0, 0];
  return new Date(Date.UTC(+yyyy, +mm - 1, +dd, t[0] || 0, t[1] || 0, t[2] || 0));
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v) { return v === 'True' || v === 'true'; }

function bucket(n, edges) {
  for (let i = 0; i < edges.length; i++) if (n < edges[i]) return i;
  return edges.length;
}

function pct(x, total) { return total ? (100 * x / total).toFixed(1) + '%' : '0%'; }

const PRODUCTS = [
  'FacebookPlus', 'GroceryPlus', 'Facebook', 'Banner', 'SeoProfile',
  'FacebookAutopilot', 'UndertakerPlus', 'RealtorPlus',
  'RealtorPropertyAssessment', 'BusinessArticle', 'Autoarticle',
  'FacebookImpressionCampaign', 'FacebookClickCampaign'
];

function analyze() {
  const { header, records } = loadAll();
  console.log(`Total records: ${records.length}`);
  console.log(`Header cols: ${header.length}\n`);

  // Parse and enrich
  for (const r of records) {
    r._createdAt = parseDkDate(r.CreatedAt);
    r._endDate = parseDkDate(r.SubscriptionEndDate);
    r._startDate = parseDkDate(r.SubscriptionStartDate);
    r._lastLogin = parseDkDate(r.LastCustomerPortalLoginDate);
    r._mrr = num(r.CommittedMrr) ?? 0;
    r._lifetime = num(r.LifetimeInMonths) ?? 0;
    r._mailOpen = num(r.AverageMailOpeningRate);
    r._loginStaleDays = r._lastLogin && r._createdAt
      ? Math.round((r._createdAt - r._lastLogin) / 86_400_000)
      : null;
    r._noticeDays = r._endDate && r._createdAt
      ? Math.round((r._endDate - r._createdAt) / 86_400_000)
      : null;

    // Count warnings
    let configW = 0, perfW = 0;
    const products = [];
    for (const p of PRODUCTS) {
      const hasConfigW = bool(r[`Has${p}ConfigWarning`]);
      const hasPerfW = bool(r[`Has${p}PerformanceWarning`]);
      const sev = r[`${p}PerformanceWarningSeverity`] || '';
      if (hasConfigW) configW++;
      if (hasPerfW) perfW++;
      // Product is 'used' if it has any warning flag set (config warnings imply they subscribe)
      if (hasConfigW || hasPerfW || sev) products.push(p);
    }
    r._configWarnings = configW;
    r._perfWarnings = perfW;
    r._productsUsed = products;
  }

  // ===== 1. Churn reason distribution =====
  console.log('=== Churn reasons ===');
  const reasonCount = {};
  const reasonMrr = {};
  for (const r of records) {
    const reason = r.ChurnReason || '(blank)';
    reasonCount[reason] = (reasonCount[reason] || 0) + 1;
    reasonMrr[reason] = (reasonMrr[reason] || 0) + r._mrr;
  }
  const reasons = Object.entries(reasonCount).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of reasons) {
    const avgMrr = reasonMrr[reason] / count;
    console.log(`  ${count.toString().padStart(4)} (${pct(count, records.length)})  avg MRR ${avgMrr.toFixed(0).padStart(6)} kr  — ${reason}`);
  }

  // ===== 2. Lifetime distribution =====
  console.log('\n=== Lifetime at churn (months) ===');
  const lifeBuckets = { '0-3': 0, '4-6': 0, '7-12': 0, '13-24': 0, '25-36': 0, '37+': 0 };
  for (const r of records) {
    const m = r._lifetime;
    if (m <= 3) lifeBuckets['0-3']++;
    else if (m <= 6) lifeBuckets['4-6']++;
    else if (m <= 12) lifeBuckets['7-12']++;
    else if (m <= 24) lifeBuckets['13-24']++;
    else if (m <= 36) lifeBuckets['25-36']++;
    else lifeBuckets['37+']++;
  }
  for (const [k, v] of Object.entries(lifeBuckets)) {
    console.log(`  ${k.padEnd(6)} months: ${v.toString().padStart(4)} (${pct(v, records.length)})`);
  }
  const avgLife = records.reduce((s, r) => s + r._lifetime, 0) / records.length;
  const medLife = [...records].map(r => r._lifetime).sort((a, b) => a - b)[Math.floor(records.length / 2)];
  console.log(`  avg: ${avgLife.toFixed(1)}   median: ${medLife}`);

  // ===== 3. Portal login recency =====
  console.log('\n=== Portal login recency (days before churn log) ===');
  const loginBuckets = { never: 0, '0-30': 0, '31-90': 0, '91-180': 0, '181-365': 0, '365+': 0 };
  for (const r of records) {
    const d = r._loginStaleDays;
    if (d === null) loginBuckets.never++;
    else if (d <= 30) loginBuckets['0-30']++;
    else if (d <= 90) loginBuckets['31-90']++;
    else if (d <= 180) loginBuckets['91-180']++;
    else if (d <= 365) loginBuckets['181-365']++;
    else loginBuckets['365+']++;
  }
  for (const [k, v] of Object.entries(loginBuckets)) {
    console.log(`  ${k.padEnd(10)}: ${v.toString().padStart(4)} (${pct(v, records.length)})`);
  }
  const inactive = loginBuckets.never + loginBuckets['91-180'] + loginBuckets['181-365'] + loginBuckets['365+'];
  console.log(`  INACTIVE (never or 90+ days): ${inactive} (${pct(inactive, records.length)})`);

  // ===== 4. Mail opening rate =====
  console.log('\n=== Mail open rate distribution ===');
  const mailBuckets = { 'missing': 0, '0': 0, '1-25': 0, '26-50': 0, '51-75': 0, '76-100': 0 };
  let mailSum = 0, mailCount = 0;
  for (const r of records) {
    const m = r._mailOpen;
    if (m === null) { mailBuckets.missing++; continue; }
    mailSum += m; mailCount++;
    if (m === 0) mailBuckets['0']++;
    else if (m <= 25) mailBuckets['1-25']++;
    else if (m <= 50) mailBuckets['26-50']++;
    else if (m <= 75) mailBuckets['51-75']++;
    else mailBuckets['76-100']++;
  }
  for (const [k, v] of Object.entries(mailBuckets)) {
    console.log(`  ${k.padEnd(8)}: ${v.toString().padStart(4)} (${pct(v, records.length)})`);
  }
  console.log(`  avg (excl. missing): ${(mailSum / (mailCount || 1)).toFixed(1)}%`);

  // ===== 5. MRR distribution =====
  console.log('\n=== Lost MRR ===');
  const totalMrr = records.reduce((s, r) => s + r._mrr, 0);
  const mrrs = records.map(r => r._mrr).sort((a, b) => a - b);
  console.log(`  Total lost MRR: ${totalMrr.toFixed(0)} kr/mo (${(totalMrr * 12).toFixed(0)} kr/yr)`);
  console.log(`  Mean: ${(totalMrr / records.length).toFixed(0)}   Median: ${mrrs[Math.floor(mrrs.length / 2)]}`);
  const top10 = [...records].sort((a, b) => b._mrr - a._mrr).slice(0, 10);
  console.log('  Top 10 by MRR:');
  for (const r of top10) {
    console.log(`    ${r._mrr.toFixed(0).padStart(6)} kr  ${r.CustomerName.padEnd(45)} ${r.ChurnReason}`);
  }

  // ===== 6. Warning counts =====
  console.log('\n=== Warnings at churn ===');
  const warnBuckets = { '0 warnings': 0, '1': 0, '2': 0, '3': 0, '4+': 0 };
  for (const r of records) {
    const w = r._configWarnings + r._perfWarnings;
    if (w === 0) warnBuckets['0 warnings']++;
    else if (w === 1) warnBuckets['1']++;
    else if (w === 2) warnBuckets['2']++;
    else if (w === 3) warnBuckets['3']++;
    else warnBuckets['4+']++;
  }
  for (const [k, v] of Object.entries(warnBuckets)) {
    console.log(`  ${k.padEnd(12)}: ${v.toString().padStart(4)} (${pct(v, records.length)})`);
  }
  const anyWarning = records.filter(r => r._configWarnings + r._perfWarnings > 0).length;
  console.log(`  ANY warning: ${anyWarning} (${pct(anyWarning, records.length)})`);
  const anyPerfWarning = records.filter(r => r._perfWarnings > 0).length;
  console.log(`  ANY perf warning: ${anyPerfWarning} (${pct(anyPerfWarning, records.length)})`);

  // Per-product warning prevalence among churners
  console.log('\n=== Per-product warnings among churners ===');
  console.log('  product                         configW  perfW  users  perfW%users');
  for (const p of PRODUCTS) {
    let c = 0, pw = 0, users = 0;
    for (const r of records) {
      const hc = bool(r[`Has${p}ConfigWarning`]);
      const hp = bool(r[`Has${p}PerformanceWarning`]);
      if (hc) c++;
      if (hp) pw++;
      if (r._productsUsed.includes(p)) users++;
    }
    const perfPctUsers = users ? ((100 * pw / users).toFixed(0) + '%') : '—';
    console.log(`  ${p.padEnd(32)} ${c.toString().padStart(6)}  ${pw.toString().padStart(5)}  ${users.toString().padStart(5)}  ${perfPctUsers.padStart(6)}`);
  }

  // ===== 7. Severity breakdown =====
  console.log('\n=== Performance warning severity (across all products) ===');
  const sevCount = {};
  for (const r of records) {
    for (const p of PRODUCTS) {
      const sev = r[`${p}PerformanceWarningSeverity`];
      if (sev) sevCount[sev] = (sevCount[sev] || 0) + 1;
    }
  }
  for (const [k, v] of Object.entries(sevCount).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)}: ${v}`);
  }

  // ===== 8. Cross tab — reason × signal =====
  console.log('\n=== Signals broken down by churn reason (top 5 reasons) ===');
  const topReasons = reasons.slice(0, 5).map(([r]) => r);
  console.log('  reason                     n     avgLife  avgMRR  stale>90d  anyPerfW   open<25%');
  for (const reason of topReasons) {
    const sub = records.filter(r => (r.ChurnReason || '(blank)') === reason);
    const n = sub.length;
    const avgLife = sub.reduce((s, r) => s + r._lifetime, 0) / n;
    const avgMrr = sub.reduce((s, r) => s + r._mrr, 0) / n;
    const stale = sub.filter(r => r._loginStaleDays === null || r._loginStaleDays > 90).length;
    const anyPerf = sub.filter(r => r._perfWarnings > 0).length;
    const lowOpen = sub.filter(r => r._mailOpen !== null && r._mailOpen < 25).length;
    console.log(`  ${reason.padEnd(26)} ${n.toString().padStart(3)}   ${avgLife.toFixed(1).padStart(6)}  ${avgMrr.toFixed(0).padStart(6)}  ${pct(stale, n).padStart(6)}     ${pct(anyPerf, n).padStart(6)}    ${pct(lowOpen, n).padStart(6)}`);
  }

  // ===== 9. Notice period =====
  console.log('\n=== Notice period (days between churn log and subscription end) ===');
  const notice = records.map(r => r._noticeDays).filter(n => n !== null).sort((a, b) => a - b);
  if (notice.length) {
    console.log(`  min ${notice[0]}  p25 ${notice[Math.floor(notice.length * .25)]}  median ${notice[Math.floor(notice.length * .5)]}  p75 ${notice[Math.floor(notice.length * .75)]}  max ${notice[notice.length - 1]}`);
  }

  // ===== 10. Early churners (first year) vs veterans =====
  console.log('\n=== Early churners (≤12mo) vs veterans (>12mo) ===');
  const early = records.filter(r => r._lifetime <= 12);
  const vets = records.filter(r => r._lifetime > 12);
  function summary(label, sub) {
    if (!sub.length) return;
    const avgMrr = sub.reduce((s, r) => s + r._mrr, 0) / sub.length;
    const stale = sub.filter(r => r._loginStaleDays === null || r._loginStaleDays > 90).length;
    const perfW = sub.filter(r => r._perfWarnings > 0).length;
    const konkurs = sub.filter(r => (r.ChurnReason || '').toLowerCase().includes('konkurs')).length;
    const noDividend = sub.filter(r => (r.ChurnReason || '').toLowerCase().includes('udbytte')).length;
    console.log(`  ${label.padEnd(22)} n=${sub.length.toString().padStart(3)}  avgMRR=${avgMrr.toFixed(0).padStart(5)}  stale>90d=${pct(stale, sub.length).padStart(6)}  perfW=${pct(perfW, sub.length).padStart(6)}  konkurs=${pct(konkurs, sub.length).padStart(6)}  Manglende_udbytte=${pct(noDividend, sub.length).padStart(6)}`);
  }
  summary('Early (≤12mo)', early);
  summary('Veteran (>12mo)', vets);
}

analyze();
