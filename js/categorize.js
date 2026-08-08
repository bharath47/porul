// categorize.js — rule engine + de-duplication over normalised transactions.
import { normDesc, merchantOf, hash } from './util.js';

// Assign categories in place. `rules`=[{kw,cat}], `manual`={ [normDesc]: cat }.
export function categorize(transactions, rules, manual) {
  const upperRules = rules.map(r => ({ kw: r.kw.toUpperCase(), cat: r.cat }));
  for (const t of transactions) {
    const nd = normDesc(t.description);
    if (manual[nd]) { t.category = manual[nd]; t.categorySource = 'manual'; continue; }
    const desc = ' ' + (t.description || '').toUpperCase() + ' ';
    let hit = null;
    for (const r of upperRules) { if (desc.includes(r.kw)) { hit = r.cat; break; } }
    t.category = hit || 'Uncategorised';
    t.categorySource = hit ? 'rule' : 'uncategorised';
  }
  return transactions;
}

// Duplicate key: same bank+account+date+abs(amount)+normalised description.
export function markDuplicates(transactions) {
  const seen = new Set();
  // Deterministic order so the *first* occurrence is the keeper.
  const order = transactions
    .map((t, i) => ({ t, i }))
    .sort((a, b) =>
      (a.t.date || '').localeCompare(b.t.date || '') ||
      (a.t.sourceFile || '').localeCompare(b.t.sourceFile || '') || a.i - b.i);
  for (const { t } of order) {
    const key = [t.bank, t.account, t.date, Math.abs(t.amount).toFixed(2), normDesc(t.description)].join('|');
    t.id = hash(key + '|' + (t.sourceFile || ''));
    t.dupKey = key;
    if (seen.has(key)) t.isDuplicate = true;
    else { seen.add(key); t.isDuplicate = false; }
    t.merchant = merchantOf(t.description);
  }
  return transactions;
}

// Distinct uncategorised descriptions with counts + totals (for the config screen).
export function uncategorisedGroups(transactions) {
  const map = new Map();
  for (const t of transactions) {
    if (t.isDuplicate || t.category !== 'Uncategorised') continue;
    const nd = normDesc(t.description);
    if (!map.has(nd)) map.set(nd, { nd, sample: t.description, count: 0, total: 0, merchant: t.merchant });
    const g = map.get(nd); g.count++; g.total += Math.abs(t.amount);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}
