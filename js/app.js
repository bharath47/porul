// app.js — application controller: state, views, filters, import, persistence.
import { $, $$, el, money, toast, setCurrency, normDesc, ym, monthLabel, parseDate, download } from './util.js';
import { DEFAULT_CATEGORIES, DEFAULT_RULES, SCHEMA_VERSION, RULES_VERSION, UNCATEGORISED, CATEGORY_ALIASES } from './config.js';
import { parseFile } from './parsers.js';
import { categorize, markDuplicates, uncategorisedGroups, dupeKey } from './categorize.js';
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
  filters: { banks: [], accounts: [], from: '', to: '', type: '', group: '', parentCat: '', trendGran: 'month', txGran: 'month' },
  view: 'dashboard',
};

// Categories deselected by default (non-spend / internal movements).
const DEFAULT_EXCLUDE = ['Mortgage Payments', 'Bank Deposit', 'Salary', 'Account-to-Account Transfers'];
const allCatNames = () => state.categories.map(c => c.name);
function ensureExclude() { if (!Array.isArray(state.settings.excludeCats)) state.settings.excludeCats = [...DEFAULT_EXCLUDE]; }
// Categories that actually appear in the (non-duplicate) imported data.
function availableCategories() {
  const present = new Set(state.transactions.filter(t => !t.isDuplicate).map(t => t.category));
  let ordered = state.categories.map(c => c.name).filter(n => present.has(n));
  for (const n of present) if (!ordered.includes(n)) ordered.push(n);
  // Narrow to the selected category, else to the selected group.
  const pc = state.filters.parentCat, grp = state.filters.group;
  if (pc) { const pm = subParentMap(); ordered = ordered.filter(n => (pm.get(n) || 'Custom') === pc); }
  else if (grp) { const gm = subGroupMap(); ordered = ordered.filter(n => (gm.get(n) || 'Custom') === grp); }
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

  // On a taxonomy/rules upgrade, re-seed built-in rules & categories and migrate saved
  // leaf names to the new taxonomy. Manual assignments and custom categories are kept.
  const outdated = (data.rulesVersion || 0) < RULES_VERSION;
  if (outdated) {
    state.rules = [...DEFAULT_RULES];
    state.categories = [...DEFAULT_CATEGORIES];
    for (const k of Object.keys(state.manual)) {
      const v = state.manual[k]; if (CATEGORY_ALIASES[v]) state.manual[k] = CATEGORY_ALIASES[v];
    }
    if (Array.isArray(state.settings.excludeCats))
      state.settings.excludeCats = state.settings.excludeCats.map(c => CATEGORY_ALIASES[c] || c);
    // Preserve any user-added categories the migration doesn't cover.
    const known = new Set(state.categories.map(c => c.name));
    if (Array.isArray(data.categories)) for (const c of data.categories) {
      if (!known.has(c.name) && !CATEGORY_ALIASES[c.name]) {
        state.categories.push({ name: c.name, category: c.category || 'Custom', group: c.group || 'Custom' });
        known.add(c.name);
      }
    }
  } else {
    if (Array.isArray(data.rules) && data.rules.length) state.rules = data.rules;
    for (const c of DEFAULT_CATEGORIES) if (!state.categories.some(x => x.name === c.name)) state.categories.push(c);
  }

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
  // On upgrade, add the new default deselections while keeping any existing ones.
  if (outdated) state.settings.excludeCats = [...new Set([...state.settings.excludeCats, ...DEFAULT_EXCLUDE])];
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
  // Parent category also narrows the subcategory chips/dropdowns everywhere.
  $('#fltParentCat').addEventListener('change', () => { readFilters(); refreshFilterOptions(); render(); });
  // Group cascades to Category → Subcategory.
  $('#fltGroup').addEventListener('change', () => {
    readFilters();
    if (state.filters.parentCat && !availableParentCategories().includes(state.filters.parentCat)) {
      state.filters.parentCat = ''; $('#fltParentCat').value = '';
    }
    refreshFilterOptions(); render();
  });
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
  $('#nlApply').addEventListener('click', applyNlRule);
  $('#nlRule').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyNlRule(); });

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
  const keepSources = new Set(items.map(i => i.path || i.name));
  // Keys already in the dataset (excluding files being re-imported) — used to flag duplicates.
  const seen = new Set(state.transactions.filter(t => !keepSources.has(t.sourceFile)).map(dupeKey));
  state.files = state.files.filter(f => !items.some(i => i.path === f.path));
  let totalDup = 0;
  for (const item of items) {
    try {
      const file = await item.get();
      const res = await parseFile(file, item.path || item.name);
      let dup = 0; const samples = [];
      for (const t of res.transactions) {
        const k = dupeKey(t);
        if (seen.has(k)) { dup++; if (samples.length < 5) samples.push(t); }
        else seen.add(k);
      }
      totalDup += dup;
      parsed.push(...res.transactions.map(t => ({ ...t })));
      state.files.push({ name: item.name, path: item.path, ext: item.ext, count: res.transactions.length,
        status: res.transactions.length ? 'ok' : 'warn', warnings: res.warnings });
      log(`${item.name}: ${res.transactions.length} txns${res.warnings.length ? ' · ' + res.warnings.join('; ') : ''}`);
      if (dup) log(`   ${dup} duplicate transaction(s) already present were ignored:`, 'dup');
      for (const t of samples) log(`    ↳ ${t.date} ${(t.description || '').slice(0, 40)} ${money(t.amount, { sign: true })}`, 'dup');
      if (dup > samples.length) log(`    ↳ …and ${dup - samples.length} more`, 'dup');
    } catch (err) {
      state.files.push({ name: item.name, path: item.path, ext: item.ext, count: 0, status: 'err', warnings: [err.message] });
      log(`${item.name}: ERROR ${err.message}`, true);
    }
    renderFileList();
  }
  // Merge with any cached transactions from other files, replacing same-source rows.
  state.transactions = state.transactions.filter(t => !keepSources.has(t.sourceFile)).concat(parsed);
  recompute();
  refreshFilterOptions();
  if (totalDup) log(`Total: ${totalDup} duplicate transaction(s) already present were ignored (not double-counted).`, 'dup');
  toast(`Imported ${parsed.length - totalDup} new${totalDup ? `, ${totalDup} duplicate(s) ignored` : ''}`, 'ok');
  render();
  if (state.mode === 'user') persist(true);
}

// ============================ core recompute ============================
function recompute() {
  categorize(state.transactions, state.rules, state.manual);
  markDuplicates(state.transactions);
}

// Map subcategory (leaf) → parent category / group, and list parents/groups present.
const subParentMap = () => new Map(state.categories.map(c => [c.name, c.category || 'Custom']));
const subGroupMap = () => new Map(state.categories.map(c => [c.name, c.group || 'Custom']));
const leafMetaMap = () => new Map(state.categories.map(c => [c.name, { category: c.category || 'Custom', group: c.group || 'Custom' }]));
function availableGroups() {
  const g = subGroupMap();
  const present = new Set(state.transactions.filter(t => !t.isDuplicate).map(t => g.get(t.category) || 'Custom'));
  return [...new Set(state.categories.map(c => c.group || 'Custom'))].filter(x => present.has(x));
}
function availableParentCategories() {
  const p = subParentMap();
  const present = new Set(state.transactions.filter(t => !t.isDuplicate).map(t => p.get(t.category) || 'Custom'));
  const grp = state.filters.group;
  const catGroup = new Map(state.categories.map(c => [c.category || 'Custom', c.group || 'Custom']));
  return [...new Set(state.categories.map(c => c.category || 'Custom'))]
    .filter(c => present.has(c) && (!grp || (catGroup.get(c) || 'Custom') === grp));
}

function activeRows() {
  const f = state.filters;
  const banks = new Set(f.banks), accts = new Set(f.accounts), excl = new Set(state.settings.excludeCats);
  const gmap = f.group ? subGroupMap() : null;
  const pmap = f.parentCat ? subParentMap() : null;
  return state.transactions.filter(t => {
    if (t.isDuplicate) return false;
    if (banks.size && !banks.has(t.bank)) return false;
    if (accts.size && !accts.has(t.account)) return false;
    if (f.from && ym(t.date) < f.from) return false;
    if (f.to && ym(t.date) > f.to) return false;
    if (excl.has(t.category)) return false;
    if (gmap && (gmap.get(t.category) || 'Custom') !== f.group) return false;
    if (pmap && (pmap.get(t.category) || 'Custom') !== f.parentCat) return false;
    if (f.type === 'debit' && t.amount >= 0) return false;
    if (f.type === 'credit' && t.amount < 0) return false;
    return true;
  });
}

// ============================ filters ============================
// Transaction table sorting
const txSort = { key: 'date', dir: 'desc' };
function setTxSort(key) {
  if (txSort.key === key) txSort.dir = txSort.dir === 'asc' ? 'desc' : 'asc';
  else { txSort.key = key; txSort.dir = (key === 'amount' || key === 'date') ? 'desc' : 'asc'; }
  renderTransactions();
}
function sortTxRows(rows) {
  const s = txSort.dir === 'asc' ? 1 : -1;
  const pm = txSort.key === 'parentCategory' ? subParentMap() : null;
  const val = (t) => txSort.key === 'amount' ? t.amount
    : txSort.key === 'bank' ? `${t.bank} ${t.account}`
    : txSort.key === 'date' ? (t.date || '')
    : txSort.key === 'parentCategory' ? (pm.get(t.category) || '')
    : (t[txSort.key] || '');
  return rows.sort((a, b) => { const av = val(a), bv = val(b); return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))) * s; });
}

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
  // Group dropdown — groups present in the data
  const gsel = $('#fltGroup'); const gcur = gsel.value;
  gsel.innerHTML = '<option value="">All groups</option>' +
    availableGroups().map(g => `<option>${g}</option>`).join('');
  gsel.value = gcur;
  // Parent-category dropdown — categories in the selected group (or all)
  const psel = $('#fltParentCat'); const pcur = psel.value;
  psel.innerHTML = '<option value="">All categories</option>' +
    availableParentCategories().map(c => `<option>${c}</option>`).join('');
  psel.value = pcur;
  // tx subcategory dropdown — only subcategories present in the data
  const sel = $('#txCatFilter'); const cur = sel.value;
  sel.innerHTML = '<option value="">All subcategories</option>' +
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
  state.filters.group = $('#fltGroup').value;
  state.filters.parentCat = $('#fltParentCat').value;
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
  state.filters = { banks: [], accounts: [], from: '', to: '', type: '', group: '', parentCat: '', trendGran: state.filters.trendGran, txGran: state.filters.txGran };
  state.settings.excludeCats = [...DEFAULT_EXCLUDE];
  $('#fltFrom').value = ''; $('#fltTo').value = ''; $('#fltType').value = ''; $('#fltGroup').value = ''; $('#fltParentCat').value = '';
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
    renderDashboard(activeRows(), { trendGran: state.filters.trendGran, catMeta: leafMetaMap() });
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
  const gmap = f.group ? subGroupMap() : null;
  const pmap = f.parentCat ? subParentMap() : null;

  let rows = state.transactions.filter(t => {
    if (!showDupes && t.isDuplicate) return false;
    if (banks.size && !banks.has(t.bank)) return false;
    if (accts.size && !accts.has(t.account)) return false;
    if (f.from && ym(t.date) < f.from) return false;
    if (f.to && ym(t.date) > f.to) return false;
    if (excl.has(t.category)) return false;
    if (gmap && (gmap.get(t.category) || 'Custom') !== f.group) return false;
    if (pmap && (pmap.get(t.category) || 'Custom') !== f.parentCat) return false;
    if (f.type === 'debit' && t.amount >= 0) return false;
    if (f.type === 'credit' && t.amount < 0) return false;
    if (catF && t.category !== catF) return false;
    if (q && !(`${t.description} ${t.merchant} ${t.category} ${t.bank}`.toLowerCase().includes(q))) return false;
    return true;
  });
  sortTxRows(rows);

  renderTxMetrics(rows);
  renderPeriodChart('chartTxTime', rows, state.filters.txGran, (key) => filterByPeriod(key, state.filters.txGran));

  const shown = rows.slice(0, 600);
  const parentOf = subParentMap();
  const table = el('table');
  const cols = [['date', 'Date'], ['description', 'Description'], ['bank', 'Bank / Account'], ['parentCategory', 'Category'], ['category', 'Sub Category'], ['amount', 'Amount']];
  const thead = el('thead'); const htr = el('tr');
  for (const [key, label] of cols) {
    const arrow = txSort.key === key ? (txSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    htr.appendChild(el('th', { class: 'sortable' + (key === 'amount' ? ' num' : '') + (key === 'date' ? ' col-date' : ''), onclick: () => setTxSort(key) }, label + arrow));
  }
  thead.appendChild(htr); table.appendChild(thead);
  const tbody = el('tbody');
  for (const t of shown) {
    const tr = el('tr', { class: t.isDuplicate ? 'dupe-row' : '' });
    const catSel = el('select', { class: 'tx-cat-select' });
    catSel.appendChild(buildCatOptions(t.category, { includeUncat: true }));
    catSel.value = t.category;
    catSel.addEventListener('change', () => setManualCategory(t.description, catSel.value));
    tr.append(
      el('td', { class: 'col-date' }, t.date || '—'),
      el('td', {},
        el('div', {}, (t.description || '—'), ' ',
          el('span', { class: 'info-ic', title: `Source file: ${t.sourceFile || 'unknown'}` }, 'ⓘ'))),
      el('td', {}, `${t.bank}`, el('br'), el('small', { class: 'muted' }, String(t.account))),
      el('td', { class: 'cat-parent' }, parentOf.get(t.category) || '—'),
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

// Clicking a bar in the amount-over-time chart filters everything to that period.
function filterByPeriod(key, gran) {
  if (gran === 'year') { state.filters.from = `${key}-01`; state.filters.to = `${key}-12`; }
  else { state.filters.from = key; state.filters.to = key; }
  $('#fltFrom').value = state.filters.from; $('#fltTo').value = state.filters.to;
  render();
  toast(`Filtered to ${gran === 'year' ? key : monthLabel(key)}`, 'ok');
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
  const groups = uncategorisedGroups(state.transactions);
  $('#uncatCount').textContent = groups.length;
  const list = $('#uncatList'); list.innerHTML = '';
  if (!groups.length) list.innerHTML = '<div class="empty">Everything is categorised. 🎉</div>';
  for (const g of groups.slice(0, 100)) {
    const sel = el('select', { class: 'tx-cat-select' });
    sel.appendChild(buildCatOptions('', { blank: true, blankLabel: 'Assign…' }));
    sel.addEventListener('change', () => { if (sel.value) setManualCategory(g.sample, sel.value); });
    list.appendChild(el('div', { class: 'uncat-item' },
      el('div', { class: 'desc' }, el('b', {}, g.sample), el('small', {}, `${g.count}× · ${money(g.total)}`)),
      sel));
  }
  // Keyword rules
  fillCatSelect($('#ruleCategory'));
  const rl = $('#ruleList'); rl.innerHTML = '';
  state.rules.forEach((r, i) => rl.appendChild(el('div', { class: 'rule-item' },
    el('span', { class: 'kw' }, r.kw), el('span', { class: 'arr' }, '→'), el('span', {}, r.cat),
    el('button', { class: 'btn ghost', onclick: () => { state.rules.splice(i, 1); recompute(); render(); persistIfUser(); } }, '✕'))));
  // Category tree: Group → Category → Subcategory chips
  const tree = $('#catChips'); tree.innerHTML = '';
  const byGroup = new Map();
  for (const c of state.categories) {
    const g = c.group || 'Custom';
    if (!byGroup.has(g)) byGroup.set(g, new Map());
    const cat = c.category || 'Custom';
    const cm = byGroup.get(g);
    if (!cm.has(cat)) cm.set(cat, []);
    cm.get(cat).push(c.name);
  }
  for (const [group, cm] of byGroup) {
    const gEl = el('div', { class: 'cat-group' }, el('div', { class: 'cat-group-h' }, group));
    for (const [cat, subs] of cm) {
      const tray = el('span', { class: 'chip-tray' });
      for (const name of subs) tray.appendChild(el('span', { class: 'chip' }, name,
        name !== UNCATEGORISED ? el('span', { class: 'x', title: 'Remove', onclick: () => removeCategory(name) }, ' ✕') : ''));
      gEl.appendChild(el('div', { class: 'cat-cat' }, el('span', { class: 'cat-cat-h' }, cat), tray));
    }
    tree.appendChild(gEl);
  }
}

// Build grouped <optgroup> options for a category <select>.
function buildCatOptions(selectedValue, { blank = false, blankLabel = '', includeUncat = false } = {}) {
  const frag = document.createDocumentFragment();
  if (blank) frag.appendChild(el('option', { value: '' }, blankLabel));
  if (includeUncat) frag.appendChild(el('option', { value: UNCATEGORISED, selected: selectedValue === UNCATEGORISED ? '' : null }, UNCATEGORISED));
  const byKey = new Map();
  for (const c of state.categories) {
    if (c.name === UNCATEGORISED) continue;
    const key = `${c.group || 'Custom'} ▸ ${c.category || 'Custom'}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c.name);
  }
  for (const [label, names] of byKey) {
    const og = el('optgroup', { label });
    for (const n of names) og.appendChild(el('option', { value: n, selected: n === selectedValue ? '' : null }, n));
    frag.appendChild(og);
  }
  return frag;
}

function fillCatSelect(sel) {
  const cur = sel.value; sel.innerHTML = '';
  sel.appendChild(buildCatOptions(cur));
  if (cur) sel.value = cur;
}

// Natural-language rule. Accepts e.g.:
//  "Spice Rack is sub category - Imported Foods"
//  "WAITOMO as Fuel / EV Charging"
//  'Description contains "LOAN" into a Category "Home Loan" under Group "Shelter & Rent"'
function applyNlRule() {
  const text = $('#nlRule').value.trim(); const hint = $('#nlHint');
  if (!text) return;
  const parsed = parseNlRule(text);
  if (!parsed) { hint.textContent = 'Try: "<merchant> is <subcategory>", or \'Description contains "X" into category "Y" under group "Z"\'.'; return; }
  const { kw, target, parent } = parsed;

  // Resolve where to place the subcategory (parent category + group).
  let category = null, group = null;
  if (parent) {
    const catNames = [...new Set(state.categories.map(c => c.category || 'Custom'))];
    const grpNames = [...new Set(state.categories.map(c => c.group || 'Custom'))];
    const mc = matchInList(parent, catNames);
    if (mc) { category = mc; group = (state.categories.find(c => (c.category || 'Custom') === mc) || {}).group || 'Custom'; }
    else { const mg = matchInList(parent, grpNames); if (mg) { group = mg; category = titleCase(target); } }
    if (!category && !group) { category = group = titleCase(parent); }
  }

  let sub = matchSubcategory(target);
  let created = false;
  if (!sub) {
    sub = titleCase(target);
    state.categories.push({ name: sub, category: category || 'Custom', group: group || 'Custom' });
    created = true;
  } else if (parent && (category || group)) {           // move existing subcategory under the given parent
    const c = state.categories.find(x => x.name === sub);
    if (c) { if (category) c.category = category; if (group) c.group = group; }
  }
  state.rules.unshift({ kw: kw.toUpperCase(), cat: sub });
  $('#nlRule').value = '';
  recompute(); refreshFilterOptions(); render(); persistIfUser();
  const where = parent ? ` under ${category || group}` : '';
  hint.textContent = `Added: “${kw}” → ${sub}${where}${created ? ' (new)' : ''}`;
  toast('Rule added', 'ok');
}
const titleCase = (s) => s.trim().replace(/\b\w/g, c => c.toUpperCase());
function parseNlRule(text) {
  let body = text.trim(), parent = null;
  const pm = body.match(/\s+(?:under|within|in|into)\s+(?:the\s+)?(?:group|categor(?:y|ies)|sub[\s-]?categor(?:y|ies))\s+["']?([^"']+?)["']?\s*$/i);
  if (pm) { parent = pm[1].trim(); body = body.slice(0, pm.index).trim(); }
  let m = body.match(/^\s*categori[sz]?e\s+["']?(.+?)["']?\s+(?:as|under|to|into)\s+(?:an?\s+)?(?:sub[\s-]?categor(?:y|ies)|categor(?:y|ies))?\s*[-:]?\s*["']?(.+?)["']?\s*$/i);
  if (!m) m = body.match(/^\s*(?:description|desc|txn|transaction|it)?\s*(?:contains|containing|has|includes|with)\s+["']?(.+?)["']?\s+(?:into|as|is|to|=>|->|=|maps? to|belongs to)\s+(?:an?\s+)?(?:sub[\s-]?categor(?:y|ies)|categor(?:y|ies))?\s*[-:]?\s*["']?(.+?)["']?\s*$/i);
  if (!m) m = body.match(/^\s*["']?(.+?)["']?\s+(?:is|=>|->|=|belongs to|goes (?:in|to|under)|as|into|maps? to)\s+(?:an?\s+)?(?:sub[\s-]?categor(?:y|ies)|categor(?:y|ies))?\s*[-:]?\s*["']?(.+?)["']?\s*$/i);
  if (!m) return null;
  const kw = m[1].trim().replace(/^["']|["']$/g, '');
  const target = m[2].trim().replace(/^["']|["']$/g, '');
  return (kw && target) ? { kw, target, parent } : null;
}
const _norm = (s) => s.toLowerCase().replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
const _tokens = (s) => _norm(s).split(/[^a-z0-9]+/).filter(t => t && !['and', 'the', 'of', 'a', 'to'].includes(t));
function matchInList(q, list) {
  const qn = _norm(q);
  let hit = list.find(n => _norm(n) === qn); if (hit) return hit;
  hit = list.find(n => { const nn = _norm(n); return nn.includes(qn) || qn.includes(nn); }); if (hit) return hit;
  const qt = _tokens(q);
  return list.find(n => { const nt = _tokens(n); return qt.length && qt.every(t => nt.includes(t)); }) || null;
}
const matchSubcategory = (q) => matchInList(q, state.categories.map(c => c.name));

function addRule() {
  const kw = $('#ruleKeyword').value.trim(); const cat = $('#ruleCategory').value;
  if (!kw) return toast('Enter a keyword', 'err');
  state.rules.unshift({ kw: kw.toUpperCase(), cat });
  $('#ruleKeyword').value = '';
  recompute(); refreshFilterOptions(); render(); persistIfUser();
  toast('Rule added', 'ok');
}

function addCategory() {
  const name = $('#newCatName').value.trim();
  const category = $('#newCatCategory').value.trim() || 'Custom';
  const group = $('#newCatGroup').value.trim() || 'Custom';
  if (!name) return toast('Enter a subcategory name', 'err');
  if (state.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) return toast('Subcategory exists', 'err');
  state.categories.push({ name, category, group });
  $('#newCatName').value = ''; $('#newCatCategory').value = ''; $('#newCatGroup').value = '';
  refreshFilterOptions(); render(); persistIfUser();
  toast('Subcategory added', 'ok');
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
  wrap.appendChild(el('div', { class: 'filelist-head' },
    el('span', { class: 'muted' }, `${state.files.length} statement(s) in this dataset`),
    el('button', { class: 'btn danger sm', onclick: removeAllStatements }, '🗑 Delete all')));
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

function removeAllStatements() {
  if (!state.files.length) return;
  if (!confirm(`Remove all ${state.files.length} statements and their transactions? Your original files are not deleted, and your categories and rules are kept.`)) return;
  state.files = []; state.transactions = [];
  recompute(); refreshFilterOptions(); render(); persistIfUser();
  toast('All statements removed', 'ok');
}
function log(msg, kind = '') {
  const color = (kind === true || kind === 'err') ? 'var(--bad)'
              : kind === 'dup' ? '#b5793a' : '';
  const l = $('#importLog');
  l.appendChild(el('div', { style: color ? `color:${color}` : '' }, `› ${msg}`));
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
