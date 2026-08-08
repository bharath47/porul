// dashboard.js — KPIs, charts and tables built from the filtered transaction set.
import { el, money, monthLabel, ym } from './util.js';

const PALETTE = ['#0f2942','#c8a45c','#2e8b6f','#c05252','#35506b','#8a6d3b','#4a7a9b',
  '#a05195','#d18b46','#5c8a72','#7a5c9b','#b0714a','#3d6b7a','#9b7a3d','#6a8caf'];
let charts = {};
function chart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  const ctx = document.getElementById(id);
  if (!ctx) return;
  charts[id] = new Chart(ctx, cfg);
}
const cssVar = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();

export function renderDashboard(rows, { trendGran = 'month' } = {}) {
  const spend = rows.filter(t => t.amount < 0);
  const income = rows.filter(t => t.amount > 0);
  const totalOut = spend.reduce((s, t) => s + -t.amount, 0);
  const totalIn = income.reduce((s, t) => s + t.amount, 0);
  const months = new Set(rows.map(t => ym(t.date)).filter(Boolean));
  const avgMonthly = months.size ? totalOut / months.size : 0;

  renderKpis([
    { label: 'Total spending', value: money(totalOut), cls: 'neg', sub: `${spend.length} transactions` },
    { label: 'Total income',   value: money(totalIn),  cls: 'pos', sub: `${income.length} credits` },
    { label: 'Net',            value: money(totalIn - totalOut, { sign: true }), cls: totalIn - totalOut >= 0 ? 'pos' : 'neg', sub: `${months.size} month(s)` },
    { label: 'Avg. monthly spend', value: money(avgMonthly), cls: '', sub: 'across selected range' },
  ]);

  renderTrend(spend, trendGran);
  renderCategory(spend);
  renderMerchants(spend);
  renderBank(spend);
  renderCashflow(rows);
  renderCatTable(spend, totalOut);
}

function renderKpis(items) {
  const row = document.getElementById('kpiRow');
  row.innerHTML = '';
  for (const k of items) {
    row.appendChild(el('div', { class: 'kpi' },
      el('div', { class: 'k-label' }, k.label),
      el('div', { class: 'k-value ' + k.cls }, k.value),
      el('div', { class: 'k-sub' }, k.sub)));
  }
}

const periodKey = (t, gran) => gran === 'year' ? (t.date || '').slice(0, 4) : ym(t.date);
const periodLabel = (k, gran) => gran === 'year' ? k : monthLabel(k);

function renderTrend(spend, gran = 'month') {
  const m = {};
  for (const t of spend) { const k = periodKey(t, gran); if (!k) continue; m[k] = (m[k] || 0) + Math.abs(t.amount); }
  const keys = Object.keys(m).sort();
  document.getElementById('trendSub').textContent = keys.length ? `${periodLabel(keys[0], gran)} – ${periodLabel(keys.at(-1), gran)}` : '';
  chart('chartTrend', {
    type: 'line',
    data: { labels: keys.map(k => periodLabel(k, gran)), datasets: [{
      data: keys.map(k => m[k]), label: 'Spending', tension: .35, fill: true,
      borderColor: cssVar('--navy'), backgroundColor: 'rgba(200,164,92,.15)',
      pointRadius: 2, borderWidth: 2 }] },
    options: baseOpts({ money: true }),
  });
}

// Grouped money-in / money-out bars per period — used by the Transactions view.
export function renderPeriodChart(canvasId, rows, gran = 'month') {
  const periods = [...new Set(rows.map(t => periodKey(t, gran)).filter(Boolean))].sort();
  const out = {}, inn = {};
  for (const t of rows) { const k = periodKey(t, gran); if (!k) continue; if (t.amount < 0) out[k] = (out[k] || 0) - t.amount; else inn[k] = (inn[k] || 0) + t.amount; }
  chart(canvasId, {
    type: 'bar',
    data: { labels: periods.map(p => periodLabel(p, gran)), datasets: [
      { label: 'Money out', data: periods.map(p => out[p] || 0), backgroundColor: cssVar('--bad'),  borderRadius: 4 },
      { label: 'Money in',  data: periods.map(p => inn[p] || 0), backgroundColor: cssVar('--good'), borderRadius: 4 },
    ] },
    options: baseOpts({ money: true, legend: true }),
  });
}

function aggregate(rows, keyFn) {
  const m = {};
  for (const t of rows) { const k = keyFn(t) || '—'; m[k] = (m[k] || 0) + Math.abs(t.amount); }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function renderCategory(spend) {
  const data = aggregate(spend, t => t.category);
  chart('chartCategory', {
    type: 'doughnut',
    data: { labels: data.map(d => d[0]), datasets: [{ data: data.map(d => d[1]), backgroundColor: PALETTE, borderWidth: 1, borderColor: cssVar('--card') }] },
    options: { plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10 } } },
      tooltip: { callbacks: { label: (c) => `${c.label}: ${money(c.parsed)}` } } }, cutout: '58%' },
  });
}

function renderMerchants(spend) {
  const data = aggregate(spend, t => t.merchant).slice(0, 8);
  chart('chartMerchants', {
    type: 'bar',
    data: { labels: data.map(d => d[0]), datasets: [{ data: data.map(d => d[1]), backgroundColor: cssVar('--slate'), borderRadius: 4 }] },
    options: { indexAxis: 'y', ...baseOpts({ money: true, legend: false }) },
  });
}

function renderBank(spend) {
  const data = aggregate(spend, t => `${t.bank} ${shortAcct(t.account)}`);
  chart('chartBank', {
    type: 'bar',
    data: { labels: data.map(d => d[0]), datasets: [{ data: data.map(d => d[1]), backgroundColor: cssVar('--gold'), borderRadius: 4 }] },
    options: baseOpts({ money: true, legend: false }),
  });
}

function renderCashflow(rows) {
  const months = [...new Set(rows.map(t => ym(t.date)).filter(Boolean))].sort();
  const outByM = {}, inByM = {};
  for (const t of rows) { const k = ym(t.date); if (!k) continue; if (t.amount < 0) outByM[k] = (outByM[k]||0) + -t.amount; else inByM[k] = (inByM[k]||0) + t.amount; }
  chart('chartCashflow', {
    type: 'bar',
    data: { labels: months.map(monthLabel), datasets: [
      { label: 'Income',   data: months.map(m => inByM[m]  || 0), backgroundColor: cssVar('--good'), borderRadius: 4 },
      { label: 'Spending', data: months.map(m => outByM[m] || 0), backgroundColor: cssVar('--bad'),  borderRadius: 4 },
    ] },
    options: baseOpts({ money: true, legend: true }),
  });
}

function renderCatTable(spend, total) {
  const data = aggregate(spend, t => t.category);
  const wrap = document.getElementById('catTable');
  const rows = data.map(([cat, val]) => `<tr><td>${cat}</td><td class="num">${money(val)}</td>
    <td class="num">${total ? ((val/total)*100).toFixed(1) : '0'}%</td></tr>`).join('');
  wrap.innerHTML = `<table><thead><tr><th>Category</th><th class="num">Amount</th><th class="num">Share</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="empty">No spending in range</td></tr>'}</tbody></table>`;
}

const shortAcct = (a) => { const s = String(a || ''); return s.length > 8 ? '…' + s.slice(-6) : s; };

function baseOpts({ money: asMoney = false, legend = false } = {}) {
  return {
    plugins: { legend: legend ? { labels: { boxWidth: 10, font: { size: 11 } } } : { display: false },
      tooltip: { callbacks: { label: (c) => (c.dataset.label ? c.dataset.label + ': ' : '') + (asMoney ? money(c.parsed.y ?? c.parsed.x ?? c.parsed) : c.parsed) } } },
    scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } },
      y: { grid: { color: cssVar('--line') }, ticks: { font: { size: 10 }, callback: (v) => asMoney ? money(v) : v } } },
    maintainAspectRatio: false,
  };
}

export function destroyCharts() { Object.values(charts).forEach(c => c.destroy()); charts = {}; }
