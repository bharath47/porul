// app.js — application controller: state, views, filters, import, persistence.
import { $, $$, el, money, toast, setCurrency, normDesc, ym, monthLabel, parseDate, download } from './util.js';
import { DEFAULT_CATEGORIES, DEFAULT_RULES, SCHEMA_VERSION, RULES_VERSION } from './config.js';
import { parseFile } from './parsers.js';
import { categorize, markDuplicates, uncategorisedGroups } from './categorize.js';
import { renderDashboard, renderPeriodChart } from './dashboard.js';
import { initAuth, renderSecurityPanel } from './auth.js';
import * as store from './storage.js';

const state = {
  mode: 'guest', userName: 'Guest',
  files: [], transactions: [],
  categories: [...DEFAULT_CATEGORIES],
  rules: [...DEFAULT_RULES],
  manual: {},
  settings: { dark: false, currency: '$', excludeCats: null },
  filters: { banks: [], accounts: [], from: '', to: '', type: '', trendGran: 'month', txGran: 'month' },
  view: 'dashboard',
};

// No categories are deselected by default (everything included).
const DEFAULT_EXCLUDE = [];
const allCatNames = () => state.categories.map(c => c.name);
function ensureExclude() { if (!Array.isArray(state.settings.excludeCats)) state.settings.excludeCats = [...DEFAULT_EXCLUDE]; }
// Categories that actually appear in the (non-duplicate) imported data.
function availableCategories() {
  const present = new Set(state.transactions.filter(t => !t.isDuplicate).map(t => t.category));
  const ordered = state.categories.map(c => c.name).filter(n => present.has(n));
  for (const n of present) if (!ordered.includes(n)) ordered.push(n);
  return ordered;
}

// ============================ boot ============================
initAuth(onLogin);

async function onLogin(mode, name) {
  state.mode = mode; state.userName = name;
  $('#authScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#userBadge').innerHTML = `${name}<small>${mode === 'user' ? 'Signed in' : 'Guest session'}</small>`;
  wireEvents();
  await restoreSession();
  applyTheme();
  refreshFilterOptions();
  render();
  maybeAskPersist();
}

async function restoreSession() {
  // Guests start with a clean slate — never load the signed-in user's saved data.
  if (state.mode !== 'user') { recompute(); return; }
  // Reconnect a previously chosen folder (needs a click to re-grant permission).
  const dir = store.hasFS ? await store.restoreDirectory() : null;
  let data = null;
  if (dir) {
    if (await store.ensurePermission()) { data = await store.loadData(); $('#sourceStatus').textContent = `Reconnected: ${store.currentDirName()}`; }
  }
  if (!data) data = store.loadLocal();
  if (data) hydrate(data);
  recompute();
}

// Sign out: wipe in-memory data so nothing lingers on screen, then show the lock screen.
function signOut() {
  state.transactions = []; state.files = []; state.manual = {};
  location.reload();
}

function hydrate(data) {
  if (Array.isArray(data.categories) && data.categories.length) state.categories = data.categories;
  if (data.settings) state.settings = { ...state.settings, ...data.settings };
  if (data.manual) state.manual = data.manual;
  if (Array.isArray(data.transactions)) state.transactions = data.transactions;
  if (Array.isArray(data.files)) state.files = data.files;

  // When the built-in rule set is upgraded, re-seed rules and merge in any new default
  // categories. User manual assignments (state.manual) and custom categories are kept.
  const outdated = (data.rulesVersion || 0) < RULES_VERSION;
  if (outdated) state.rules = [...DEFAULT_RULES];
  else if (Array.isArray(data.rules) && data.rules.length) state.rules = data.rules;
  for (const c of DEFAULT_CATEGORIES) if (!state.categories.some(x => x.name === c.name)) state.categories.push(c);

  // If older data used an include list, convert it back to an exclude list.
  if (!Array.isArray(state.settings.excludeCats)) {
    if (Array.isArray(state.settings.includeCats)) {
      const incl = new Set(state.settings.includeCats);
      state.settings.excludeCats = allCatNames().filter(c => !incl.has(c));
    } else state.settings.excludeCats = [...DEFAULT_EXCLUDE];
  }
  // On upgrade, drop the old default that deselected Interbank Transfers.
  if (outdated && state.settings.excludeCats.length === 1 && state.settings.excludeCats[0] === 'Interbank Transfers')
    state.settings.excludeCats = [];
  delete state.settings.includeCats;
  setCurrency(state.settings.currency);
}

// ============================ events ============================
function wireEvents() {
  $$('.nav-item').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#logoutBtn').addEventListener('click', signOut);

  $('#pickFolder').addEventListener('click', pickFolder);
  $('#addFiles').addEventListener('click', () => $('#hiddenFileInput').click());
  $('#hiddenFileInput').addEventListener('change', (e) => importFiles([...e.target.files]));

  $('#saveBtn').addEventListener('click', persist);
  $('#saveBtn2').addEventListener('click', persist);
  $('#resetFilters').addEventListener('click', resetFilters);

  ['fltAccount','fltFrom','fltTo','fltType'].forEach(id =>
    $('#' + id).addEventListener('change', () => { readFilters(); render(); }));
  $('#fltBank').addEventListener('change', onBankChange);
  $('#catSelectAll').addEventListener('click', () => { state.settings.excludeCats = []; renderCatChips(); render(); });
  $('#catClear').addEventListener('click', () => { state.settings.excludeCats = [...availableCategories()]; renderCatChips(); render(); });
  $('#trendGran').addEventListener('click', (e) => segClick('#trendGran', e, (g) => { state.filters.trendGran = g; render(); }));
  $('#txGran').addEventListener('click', (e) => segClick('#txGran', e, (g) => { state.filters.txGran = g; render(); }));

  $('#txSearch').addEventListener('input', renderTransactions);
  $('#txCatFilter').addEventListener('change', renderTransactions);
  $('#txShowDupes').addEventListener('change', renderTransactions);
  $('#exportCsv').addEventListener('click', exportCsv);

  $('#addRule').addEventListener('click', addRule);
  $('#addCat').addEventListener('click', addCategory);

  $('#darkToggle').addEventListener('change', (e) => { state.settings.dark = e.target.checked; applyTheme(); });
  $('#currencySym').addEventListener('change', (e) => { state.settings.currency = e.target.value || '$'; setCurrency(state.settings.currency); render(); });
  $('#exportJson').addEventListener('click', () => download('fintide-backup.json', JSON.stringify(buildData(), null, 2)));
  $('#importJson').addEventListener('click', () => $('#hiddenJsonInput').click());
  $('#hiddenJsonInput').addEventListener('change', importBackup);
  $('#wipeData').addEventListener('click', wipe);

  $('#persistFolder').addEventListener('click', async () => { hidePersist(); await pickFolder(); setPersistPref({ mode: 'folder' }); });
  $('#persistBrowser').addEventListener('click', () => { setPersistPref({ mode: 'local' }); hidePersist(); toast('Saving to this browser', 'ok'); });
  $('#persistSkip').addEventListener('click', hidePersist);
  $('#persistUrlLoad').addEventListener('click', loadFromUrl);
}

// ============================ import ============================
async function pickFolder() {
  if (!store.hasFS) { toast('Your browser lacks folder access — use “Add files”.', 'err'); return $('#hiddenFileInput').click(); }
  try { await store.pickDirectory(); } catch { return; }
  $('#sourceStatus').textContent = `Scanning ${store.currentDirName()}…`;
  const existing = await store.loadData();
  if (existing) hydrate(existing);
  const found = await store.scanDirectory();
  log(`Found ${found.length} statement file(s) in ${store.currentDirName()}.`);
  await parseAll(found.map(f => ({ ...f, get: () => store.readFileFromHandle(f) })));
  $('#sourceStatus').textContent = `${store.currentDirName()} · ${found.length} files`;
}

async function importFiles(fileObjs) {
  const items = fileObjs.map(f => ({ name: f.name, path: f.name, ext: f.name.split('.').pop().toLowerCase(), get: async () => f }));
  await parseAll(items);
}

async function parseAll(items) {
  switchView('import');
  const parsed = [];
  state.files = state.files.filter(f => !items.some(i => i.path === f.path));
  for (const item of items) {
    try {
      const file = await item.get();
      const res = await parseFile(file, item.path || item.name);
      parsed.push(...res.transactions.map(t => ({ ...t })));
      state.files.push({ name: item.name, path: item.path, ext: item.ext, count: res.transactions.length,
        status: res.transactions.length ? 'ok' : 'warn', warnings: res.warnings });
      log(`${item.name}: ${res.transactions.length} txns${res.warnings.length ? ' · ' + res.warnings.join('; ') : ''}`);
    } catch (err) {
      state.files.push({ name: item.name, path: item.path, ext: item.ext, count: 0, status: 'err', warnings: [err.message] });
      log(`${item.name}: ERROR ${err.message}`, true);
    }
    renderFileList();
  }
  // Merge with any cached transactions from other files, replacing same-source rows.
  const keepSources = new Set(items.map(i => i.path || i.name));
  state.transactions = state.transactions.filter(t => !keepSources.has(t.sourceFile)).concat(parsed);
  recompute();
  refreshFilterOptions();
  toast(`Imported ${parsed.length} transactions`, 'ok');
  render();
  if (state.mode === 'user') persist(true);
}

// ============================ core recompute ============================
function recompute() {
  categorize(state.transactions, state.rules, state.manual);
  markDuplicates(state.transactions);
}

function activeRows() {
  const f = state.filters;
  const banks = new Set(f.banks), accts = new Set(f.accounts), excl = new Set(state.settings.excludeCats);
  return state.transactions.filter(t => {
    if (t.isDuplicate) return false;
    if (banks.size && !banks.has(t.bank)) return false;
    if (accts.size && !accts.has(t.account)) return false;
    if (f.from && ym(t.date) < f.from) return false;
    if (f.to && ym(t.date) > f.to) return false;
    if (excl.has(t.category)) return false;
    if (f.type === 'debit' && t.amount >= 0) return false;
    if (f.type === 'credit' && t.amount < 0) return false;
    return true;
  });
}

// ============================ filters ============================
function refreshFilterOptions() {
  ensureExclude();
  const banks = [...new Set(state.transactions.map(t => t.bank))].sort();
  const accts = [...new Set(state.transactions.map(t => t.account))].sort();
  fillMulti($('#fltBank'), banks, state.filters.banks);
  fillMulti($('#fltAccount'), accts, state.filters.accounts);
  // Date bounds
  const dates = state.transactions.map(t => ym(t.date)).filter(Boolean).sort();
  if (dates.length) {
    $('#fltFrom').min = $('#fltTo').min = dates[0];
    $('#fltFrom').max = $('#fltTo').max = dates.at(-1);
  }
  renderCatChips();
  // tx category dropdown — only categories present in the data
  const sel = $('#txCatFilter'); const cur = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' +
    availableCategories().map(n => `<option>${n}</option>`).join('');
  sel.value = cur;
}

function fillMulti(sel, options, selected) {
  sel.multiple = true; sel.size = 4;
  sel.innerHTML = options.map(o => `<option ${selected.includes(o) ? 'selected' : ''}>${o}</option>`).join('');
}

function readFilters() {
  state.filters.banks = [...$('#fltBank').selectedOptions].map(o => o.value);
  state.filters.accounts = [...$('#fltAccount').selectedOptions].map(o => o.value);
  state.filters.from = $('#fltFrom').value;
  state.filters.to = $('#fltTo').value;
  state.filters.type = $('#fltType').value;
}

// Selecting bank(s) narrows the account list to those banks.
function onBankChange() {
  const banks = [...$('#fltBank').selectedOptions].map(o => o.value);
  const accts = [...new Set(state.transactions.filter(t => !banks.length || banks.includes(t.bank)).map(t => t.account))].sort();
  const keep = new Set([...$('#fltAccount').selectedOptions].map(o => o.value));
  fillMulti($('#fltAccount'), accts, [...keep].filter(a => accts.includes(a)));
  readFilters(); render();
}

function segClick(sel, e, cb) {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  $$(sel + ' .seg-btn').forEach(x => x.classList.toggle('active', x === b));
  cb(b.dataset.g);
}

function resetFilters() {
  state.filters = { banks: [], accounts: [], from: '', to: '', type: '', trendGran: state.filters.trendGran, txGran: state.filters.txGran };
  state.settings.excludeCats = [...DEFAULT_EXCLUDE];
  $('#fltFrom').value = ''; $('#fltTo').value = ''; $('#fltType').value = '';
  refreshFilterOptions(); render();
}

function renderCatChips() {
  const tray = $('#fltIncludeCats'); tray.innerHTML = '';
  const excl = new Set(state.settings.excludeCats);
  const avail = availableCategories();
  if (!avail.length) { tray.appendChild(el('span', { class: 'muted' }, 'Import data to see categories')); return; }
  for (const name of avail) {
    const on = !excl.has(name);
    tray.appendChild(el('span', { class: 'chip' + (on ? ' on' : ''), onclick: () => {
      if (on) state.settings.excludeCats = [...new Set([...state.settings.excludeCats, name])];
      else state.settings.excludeCats = state.settings.excludeCats.filter(x => x !== name);
      renderCatChips(); render();
    } }, name));
  }
}

// ============================ view routing ============================
function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  $('#filterBar').style.display = (view === 'dashboard' || view === 'transactions') ? 'flex' : 'none';
  render();
}

function render() {
  if (state.view === 'dashboard') {
    if (!state.transactions.length) return emptyDashboard();
    renderDashboard(activeRows(), { trendGran: state.filters.trendGran });
  } else if (state.view === 'transactions') renderTransactions();
  else if (state.view === 'categories') renderCategories();
  else if (state.view === 'import') renderFileList();
  else if (state.view === 'settings') renderSettings();
}

function emptyDashboard() {
  $('#kpiRow').innerHTML = `<div class="card span2 empty" style="grid-column:span 4">
    No data yet. Go to <b>Data Sources</b> and choose your statements folder to begin.</div>`;
}

// ============================ transactions view ============================
function renderTransactions() {
  const q = $('#txSearch').value.toLowerCase();
  const catF = $('#txCatFilter').value;
  const showDupes = $('#txShowDupes').checked;
  const f = state.filters, banks = new Set(f.banks), accts = new Set(f.accounts), excl = new Set(state.settings.excludeCats);

  let rows = state.transactions.filter(t => {
    if (!showDupes && t.isDuplicate) return false;
    if (banks.size && !banks.has(t.bank)) return false;
    if (accts.size && !accts.has(t.account)) return false;
    if (f.from && ym(t.date) < f.from) return false;
    if (f.to && ym(t.date) > f.to) return false;
    if (excl.has(t.category)) return false;
    if (f.type === 'debit' && t.amount >= 0) return false;
    if (f.type === 'credit' && t.amount < 0) return false;
    if (catF && t.category !== catF) return false;
    if (q && !(`${t.description} ${t.merchant} ${t.category} ${t.bank}`.toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  renderTxMetrics(rows);
  renderPeriodChart('chartTxTime', rows, state.filters.txGran);

  const shown = rows.slice(0, 600);
  const opts = state.categories.map(c => c.name);
  const table = el('table');
  table.innerHTML = `<thead><tr><th>Date</th><th>Description</th><th>Bank / Account</th>
    <th>Category</th><th class="num">Amount</th></tr></thead>`;
  const tbody = el('tbody');
  for (const t of shown) {
    const tr = el('tr', { class: t.isDuplicate ? 'dupe-row' : '' });
    const catSel = el('select', { class: 'tx-cat-select' },
      ...opts.map(o => el('option', { value: o, selected: o === t.category ? '' : null }, o)));
    catSel.value = t.category;
    catSel.addEventListener('change', () => setManualCategory(t.description, catSel.value));
    tr.append(
      el('td', {}, t.date || '—'),
      el('td', {},
        el('div', {}, (t.description || '—'), ' ',
          el('span', { class: 'info-ic', title: `Source file: ${t.sourceFile || 'unknown'}` }, 'ⓘ')),
        el('small', { class: 'muted' }, t.merchant || '')),
      el('td', {}, `${t.bank}`, el('br'), el('small', { class: 'muted' }, String(t.account))),
      el('td', {}, catSel),
      el('td', { class: 'num ' + (t.amount < 0 ? 'amt-out' : 'amt-in') }, money(t.amount, { sign: true })),
    );
    tbody.appendChild(tr);
  }
  const wrap = $('#txTable'); wrap.innerHTML = '';
  if (!shown.length) wrap.innerHTML = '<div class="empty">No transactions match your filters.</div>';
  else { wrap.appendChild(table); table.appendChild(tbody);
    if (rows.length > shown.length) wrap.appendChild(el('div', { class: 'muted', style: 'padding:10px' }, `Showing first ${shown.length} of ${rows.length}. Refine with search or filters.`)); }
}

function setManualCategory(desc, cat) {
  state.manual[normDesc(desc)] = cat;
  recompute(); refreshFilterOptions(); render();
  if (state.mode === 'user') persist(true);
}

function renderTxMetrics(rows) {
  const out = rows.filter(t => t.amount < 0).reduce((s, t) => s - t.amount, 0);
  const inn = rows.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const net = inn - out;
  const kp = $('#txKpis'); kp.innerHTML = '';
  [
    { label: 'Transactions', value: rows.length.toLocaleString(), cls: '', sub: 'in current view' },
    { label: 'Money out', value: money(out), cls: 'neg', sub: rows.filter(t => t.amount < 0).length + ' debits' },
    { label: 'Money in', value: money(inn), cls: 'pos', sub: rows.filter(t => t.amount > 0).length + ' credits' },
    { label: 'Grand total (net)', value: money(net, { sign: true }), cls: net >= 0 ? 'pos' : 'neg', sub: 'income − spending' },
  ].forEach(k => kp.appendChild(el('div', { class: 'kpi' },
    el('div', { class: 'k-label' }, k.label), el('div', { class: 'k-value ' + k.cls }, k.value), el('div', { class: 'k-sub' }, k.sub))));
}

// ============================ categorisation view ============================
function renderCategories() {
  // Uncategorised groups
  const groups = uncategorisedGroups(state.transactions);
  $('#uncatCount').textContent = groups.length;
  const list = $('#uncatList'); list.innerHTML = '';
  if (!groups.length) list.innerHTML = '<div class="empty">Everything is categorised. 🎉</div>';
  for (const g of groups.slice(0, 100)) {
    const sel = el('select', { class: 'tx-cat-select' },
      el('option', { value: '' }, 'Assign…'),
      ...state.categories.filter(c => c.name !== 'Uncategorised').map(c => el('option', { value: c.name }, c.name)));
    sel.addEventListener('change', () => { if (sel.value) setManualCategory(g.sample, sel.value); });
    list.appendChild(el('div', { class: 'uncat-item' },
      el('div', { class: 'desc' }, el('b', {}, g.sample), el('small', {}, `${g.count}× · ${money(g.total)}`)),
      sel));
  }
  // Rules
  fillCatSelect($('#ruleCategory'));
  const rl = $('#ruleList'); rl.innerHTML = '';
  state.rules.forEach((r, i) => rl.appendChild(el('div', { class: 'rule-item' },
    el('span', { class: 'kw' }, r.kw), el('span', { class: 'arr' }, '→'), el('span', {}, r.cat),
    el('button', { class: 'btn ghost', onclick: () => { state.rules.splice(i, 1); recompute(); render(); persistIfUser(); } }, '✕'))));
  // Category chips
  const chips = $('#catChips'); chips.innerHTML = '';
  for (const c of state.categories) {
    chips.appendChild(el('span', { class: 'chip' }, `${c.name} `, el('span', { class: 'grp' }, c.group || ''),
      c.name !== 'Uncategorised' ? el('span', { class: 'x', title: 'Remove', onclick: () => removeCategory(c.name) }, ' ✕') : ''));
  }
}

function fillCatSelect(sel) {
  sel.innerHTML = state.categories.filter(c => c.name !== 'Uncategorised').map(c => `<option>${c.name}</option>`).join('');
}

function addRule() {
  const kw = $('#ruleKeyword').value.trim(); const cat = $('#ruleCategory').value;
  if (!kw) return toast('Enter a keyword', 'err');
  state.rules.unshift({ kw: kw.toUpperCase(), cat });
  $('#ruleKeyword').value = '';
  recompute(); refreshFilterOptions(); render(); persistIfUser();
  toast('Rule added', 'ok');
}

function addCategory() {
  const name = $('#newCatName').value.trim(); const group = $('#newCatGroup').value.trim();
  if (!name) return toast('Enter a category name', 'err');
  if (state.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) return toast('Category exists', 'err');
  state.categories.push({ name, group: group || 'Custom' });
  $('#newCatName').value = ''; $('#newCatGroup').value = '';
  refreshFilterOptions(); render(); persistIfUser();
}

function removeCategory(name) {
  state.categories = state.categories.filter(c => c.name !== name);
  state.settings.excludeCats = state.settings.excludeCats.filter(c => c !== name);
  state.rules = state.rules.filter(r => r.cat !== name);
  Object.keys(state.manual).forEach(k => { if (state.manual[k] === name) delete state.manual[k]; });
  recompute(); refreshFilterOptions(); render(); persistIfUser();
}

// ============================ import view ============================
function renderFileList() {
  const wrap = $('#fileList'); wrap.innerHTML = '';
  if (!state.files.length) { wrap.innerHTML = '<div class="empty">No statements uploaded yet.</div>'; return; }
  wrap.appendChild(el('div', { class: 'muted', style: 'margin-bottom:6px' },
    `${state.files.length} statement(s) in this dataset`));
  for (const f of state.files) {
    const status = f.status || 'ok';
    wrap.appendChild(el('div', { class: 'file-row' },
      el('span', { class: 'badge ' + (f.ext === 'xls' ? 'xlsx' : f.ext) }, f.ext),
      el('span', { class: 'fname', title: f.path }, f.path),
      el('span', { class: 'cnt' }, `${f.count} txns`),
      el('span', { class: 'st-' + status }, status === 'ok' ? '✓' : status === 'warn' ? '⚠' : '✕'),
      el('button', { class: 'file-remove', title: 'Remove this statement and its transactions',
        onclick: () => removeStatement(f.path) }, '✕')));
  }
}

function removeStatement(path) {
  const f = state.files.find(x => x.path === path);
  if (!confirm(`Remove "${path}"${f ? ` and its ${f.count} transactions` : ''}? Your original file is not deleted.`)) return;
  state.transactions = state.transactions.filter(t => t.sourceFile !== path);
  state.files = state.files.filter(x => x.path !== path);
  recompute(); refreshFilterOptions(); render(); persistIfUser();
  toast('Statement removed', 'ok');
}
function log(msg, err = false) {
  const l = $('#importLog');
  l.appendChild(el('div', { style: err ? 'color:var(--bad)' : '' }, `› ${msg}`));
  l.scrollTop = l.scrollHeight;
}

// ============================ settings ============================
function renderSettings() {
  $('#darkToggle').checked = state.settings.dark;
  $('#currencySym').value = state.settings.currency;
  const nDup = state.transactions.filter(t => t.isDuplicate).length;
  $('#dataStats').textContent =
    `${state.transactions.length} transactions · ${nDup} duplicates ignored · ${state.files.length} files · ${state.rules.length} rules · ${state.categories.length} categories.`;
  renderSecurityPanel($('#securityPanel'), state.userName, () => renderSettings());
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.dark ? 'dark' : 'light');
  const dt = $('#darkToggle'); if (dt) dt.checked = state.settings.dark;
}

// ============================ persistence ============================
function buildData() {
  return {
    schema: 'porul', version: SCHEMA_VERSION, rulesVersion: RULES_VERSION, updatedAt: new Date().toISOString(),
    settings: state.settings, categories: state.categories, rules: state.rules, manual: state.manual,
    files: state.files.map(({ name, path, ext, count, status }) => ({ name, path, ext, count, status })),
    transactions: state.transactions.map(({ id, isDuplicate, dupKey, category, categorySource, merchant, ...keep }) => keep),
  };
}

// Persistence-location prompt (signed-in users choose folder vs browser vs cloud link).
const PERSIST_KEY = 'porul-persist';
const persistPref = () => { try { return JSON.parse(localStorage.getItem(PERSIST_KEY)); } catch { return null; } };
const setPersistPref = (p) => localStorage.setItem(PERSIST_KEY, JSON.stringify(p));
const hidePersist = () => $('#persistModal').classList.add('hidden');
function maybeAskPersist() {
  if (state.mode !== 'user') return;                          // only signed-in users
  if (store.currentDirName && store.currentDirName()) return; // a folder is already connected
  if (persistPref()) return;                                  // already chosen once
  $('#persistModal').classList.remove('hidden');
}
async function loadFromUrl() {
  const url = $('#persistUrlInput').value.trim(); if (!url) return;
  try {
    const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status);
    hydrate(await res.json()); recompute(); refreshFilterOptions(); render();
    setPersistPref({ mode: 'url', url }); hidePersist(); toast('Loaded data from link', 'ok');
  } catch { toast('Could not load from link (blocked or wrong format). Use the folder option.', 'err'); }
}

async function persist(silent) {
  const data = buildData();
  try {
    if (store.hasFS && store.currentDirName()) { await store.saveData(data); if (!silent) toast('Saved to source folder', 'ok'); }
    else { store.saveLocal(data); if (!silent) toast('Saved locally in this browser', 'ok'); }
  } catch (err) { toast('Save failed: ' + err.message, 'err'); }
}
const persistIfUser = () => { if (state.mode === 'user') persist(true); };

async function importBackup(e) {
  const file = e.target.files[0]; if (!file) return;
  try { hydrate(JSON.parse(await file.text())); recompute(); refreshFilterOptions(); render(); toast('Backup imported', 'ok'); }
  catch (err) { toast('Invalid backup: ' + err.message, 'err'); }
  e.target.value = '';
}

function wipe() {
  if (!confirm('Clear all imported data, rules and manual categories from this app? Your original statement files are untouched.')) return;
  state.transactions = []; state.files = []; state.manual = {};
  state.rules = [...DEFAULT_RULES]; state.categories = [...DEFAULT_CATEGORIES];
  state.settings.excludeCats = null;
  store.saveLocal(buildData());
  refreshFilterOptions(); render(); toast('Data cleared');
}

function exportCsv() {
  const rows = activeRows();
  const head = 'Date,Bank,Account,Description,Merchant,Category,Amount';
  const body = rows.map(t => [t.date, t.bank, t.account, `"${(t.description||'').replace(/"/g,'""')}"`,
    `"${t.merchant||''}"`, t.category, t.amount.toFixed(2)].join(',')).join('\n');
  download('fintide-transactions.csv', head + '\n' + body, 'text/csv');
}
