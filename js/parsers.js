// parsers.js — read CSV / Excel / PDF statements into normalised transactions.
// Sign convention: amount < 0 = money out (spending), amount > 0 = money in.
import { parseDate } from './util.js';

const PDFJS_URL = new URL('../vendor/pdf.min.mjs', import.meta.url).href;
const PDFJS_WORKER = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
let _pdfjs = null;
async function pdfjs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import(PDFJS_URL);
  _pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return _pdfjs;
}

const num = (s) => { const v = parseFloat(String(s).replace(/[, ]/g, '')); return isNaN(v) ? null : v; };
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

// ---------- public entry ----------
export async function parseFile(file, name) {
  const fname = name || file.name;
  const ext = fname.split('.').pop().toLowerCase();
  try {
    if (ext === 'pdf')  return await parsePdf(file, fname);
    if (ext === 'csv')  return parseDelimited(await asText(file), fname);
    if (ext === 'xls' || ext === 'xlsx') return parseExcel(await asBuffer(file), fname);
    return { transactions: [], warnings: [`Unsupported file type: ${ext}`], bank: '?' };
  } catch (err) {
    return { transactions: [], warnings: [`Failed to read: ${err.message}`], bank: '?' };
  }
}

const asText = (f) => f.text ? f.text() : new Response(f).text();
const asBuffer = (f) => f.arrayBuffer ? f.arrayBuffer() : new Response(f).arrayBuffer();

// =====================================================================
//  CSV / delimited
// =====================================================================
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  }
  out.push(cur); return out.map(s => s.trim());
}

export function parseDelimited(text, fname) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return { transactions: [], warnings: ['Empty file'], bank: '?' };
  const header = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const find = (...keys) => header.findIndex(h => keys.some(k => h.includes(k)));

  const iDate = find('date');
  const iDesc = find('description', 'details', 'narrative', 'particulars', 'reference', 'memo');
  const iAmt  = find('amount');
  const iDebit = find('debit', 'withdrawal', 'money out');
  const iCredit = find('credit', 'deposit', 'money in');
  const iAcct = find('account #', 'account', 'card member');
  const iCardMember = header.findIndex(h => h.includes('card member'));

  // AMEX activity export: Date,Description,Card Member,Account #,Amount (amount +ve = charge)
  const isAmex = iCardMember >= 0 && header.some(h => h.includes('account #'));
  const bank = isAmex ? 'AMEX' : (fname.toLowerCase().includes('anz') ? 'ANZ' : 'Bank');

  const transactions = [], warnings = [];
  for (let r = 1; r < lines.length; r++) {
    const c = splitCsvLine(lines[r]);
    if (c.length < 2) continue;
    const date = parseDate(c[iDate], true);
    if (!date || typeof date !== 'string') continue;
    const desc = (iDesc >= 0 ? c[iDesc] : c.slice(1).join(' ')) || '';

    let amount = null;
    if (iAmt >= 0) {
      const raw = num(c[iAmt]);
      if (raw === null) continue;
      amount = isAmex ? -raw : raw;         // AMEX: +ve charge → outflow (negative)
    } else if (iDebit >= 0 || iCredit >= 0) {
      const d = num(c[iDebit]) || 0, cr = num(c[iCredit]) || 0;
      amount = cr - d;
    } else continue;

    let account = iAcct >= 0 && c[iAcct] ? c[iAcct] : bank;
    if (isAmex) account = 'AMEX' + (c[header.findIndex(h=>h.includes('account #'))] || '');
    const cardMember = iCardMember >= 0 ? c[iCardMember] : '';

    transactions.push({ bank, account, date, description: desc.trim(), amount, cardMember, sourceFile: fname });
  }
  if (!transactions.length) warnings.push('No transactions detected (unrecognised columns).');
  return { transactions, warnings, bank };
}

// =====================================================================
//  Excel  (via SheetJS, loaded globally)
// =====================================================================
export function parseExcel(buffer, fname) {
  if (typeof XLSX === 'undefined') return { transactions: [], warnings: ['Excel library not loaded'], bank: '?' };
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const all = [], warnings = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' });
    // Locate a header row containing "date".
    let hIdx = rows.findIndex(r => r.some(c => /date/i.test(String(c))));
    if (hIdx < 0) continue;
    const csv = rows.slice(hIdx).map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const res = parseDelimited(csv, fname);
    all.push(...res.transactions);
    warnings.push(...res.warnings.map(w => `[${sheetName}] ${w}`));
  }
  const bank = fname.toLowerCase().includes('anz') ? 'ANZ' : (fname.toLowerCase().includes('amex') ? 'AMEX' : 'Bank');
  all.forEach(t => t.bank = t.bank === 'Bank' ? bank : t.bank);
  return { transactions: all, warnings, bank };
}

// =====================================================================
//  PDF  — positional reconstruction, then bank-specific row parsing
// =====================================================================
async function parsePdf(file, fname) {
  const lib = await pdfjs();
  const data = await asBuffer(file);
  const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
  const rows = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    rows.push(...pageItemsToRows(tc.items, p));
  }
  return dispatchRows(rows, fname);
}

// Turn raw pdf.js text items into ordered visual rows (exported for testing).
export function pageItemsToRows(rawItems, page = 1) {
  const items = rawItems.filter(it => it.str !== '').map(it => ({
    str: it.str, x: it.transform[4], y: it.transform[5],
    w: it.width || 0, h: it.height || Math.abs(it.transform[3]) || 8,
  }));
  const buckets = new Map();
  for (const it of items) {
    const key = Math.round(it.y / 2);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  return [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([, its]) => {
    its.sort((a, b) => a.x - b.x);
    let text = '';
    for (let i = 0; i < its.length; i++) {
      if (i > 0) {
        const gap = its[i].x - (its[i-1].x + its[i-1].w);
        if (gap > its[i].h * 0.28) text += ' ';
      }
      text += its[i].str;
    }
    return { page, text: text.replace(/\s+/g, ' ').trim(), items: its };
  }).filter(r => r.text);
}

export function dispatchRows(rows, fname) {
  const fullText = rows.map(r => r.text).join('\n');
  const c = classify(fullText, fname);
  if (c.parser === 'ANZ')      return parseAnzRows(rows, fname);
  if (c.parser === 'AMEX')     return parseAmexRows(rows, fname);
  if (c.parser === 'KIWIBANK') return parseKiwiRows(rows, fname);
  return parseGenericRows(rows, fname, c.name);
}

// Route to a tuned parser when we recognise the issuer; otherwise fall back to the
// generic engine with a best-effort bank name.
function classify(text, fname) {
  const t = text.toLowerCase(), f = (fname || '').toLowerCase();
  if (f.includes('anz') || /anz bank new zealand|anz\.co\.nz/.test(t)) return { parser: 'ANZ', name: 'ANZ' };
  if (f.includes('amex') || /americanexpress\.co\.nz|american express international|xxxx-xxxxxx-/.test(t)) return { parser: 'AMEX', name: 'AMEX' };
  if (f.includes('kiwibank') || /kiwibank|access number/.test(t)) return { parser: 'KIWIBANK', name: 'KiwiBank' };
  if (/\d{2}-\d{4}-\d{7}-\d{2}/.test(text)) return { parser: 'ANZ', name: 'ANZ' };
  return { parser: 'GENERIC', name: guessBankName(text, fname) };
}

const KNOWN_BANKS = [
  [/westpac/i, 'Westpac'], [/\bbnz\b|bank of new zealand/i, 'BNZ'], [/\basb\b/i, 'ASB'], [/\btsb\b/i, 'TSB'],
  [/co-?operative bank/i, 'Co-operative Bank'], [/rabobank/i, 'Rabobank'], [/heartland/i, 'Heartland'],
  [/hsbc/i, 'HSBC'], [/barclays/i, 'Barclays'], [/lloyds/i, 'Lloyds'], [/natwest/i, 'NatWest'], [/santander/i, 'Santander'],
  [/halifax/i, 'Halifax'], [/monzo/i, 'Monzo'], [/starling/i, 'Starling'], [/revolut/i, 'Revolut'], [/nationwide/i, 'Nationwide'],
  [/bank of america/i, 'Bank of America'], [/chase/i, 'Chase'], [/wells fargo/i, 'Wells Fargo'], [/citibank|citi\b/i, 'Citi'],
  [/capital one/i, 'Capital One'], [/\bpnc\b/i, 'PNC'], [/\btd bank\b/i, 'TD Bank'], [/u\.?s\.? bank/i, 'US Bank'],
  [/hdfc/i, 'HDFC'], [/icici/i, 'ICICI'], [/\bsbi\b|state bank of india/i, 'SBI'], [/axis bank/i, 'Axis'], [/kotak/i, 'Kotak'],
  [/commonwealth bank|commbank/i, 'CommBank'], [/\bnab\b|national australia/i, 'NAB'], [/st\.?george/i, 'St.George'],
  [/bendigo/i, 'Bendigo'], [/\bdbs\b/i, 'DBS'], [/ocbc/i, 'OCBC'], [/\buob\b/i, 'UOB'], [/standard chartered/i, 'Standard Chartered'],
  [/bank of ireland/i, 'Bank of Ireland'], [/\baib\b/i, 'AIB'], [/deutsche bank/i, 'Deutsche Bank'],
];
function guessBankName(text, fname) {
  const head = text.split('\n').slice(0, 12).join('\n');   // match the letterhead, not transaction lines
  const f = fname || '';
  for (const [re, name] of KNOWN_BANKS) if (re.test(head) || re.test(f)) return name;
  const seg = f.split(/[\/\\]/);                            // folder hint, e.g. "HSBC/statement.pdf"
  if (seg.length > 1 && seg[0] && !/\.(pdf|csv|xlsx?)$/i.test(seg[0])) return seg[0];
  const line = (head.split('\n').find(l => /\b(bank|credit union|building society)\b/i.test(l)) || '').trim();
  if (line) return line.replace(/\s+/g, ' ').slice(0, 28);
  const base = (seg[seg.length - 1] || '').replace(/\.(pdf|csv|xlsx?)$/i, '')
    .replace(/[_\-]+/g, ' ').replace(/\b\d{1,4}\b/g, '')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/ig, '')
    .replace(/statement|personal|account/ig, '').replace(/\s+/g, ' ').trim();
  if (base.length >= 3) return base.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 28);
  return 'Bank';
}

// ---------- ANZ ----------
function parseAnzRows(rows, fname) {
  const transactions = [], warnings = [];
  let account = null, running = null, y1 = null, m1 = null, y2 = null, m2 = null, lastTx = null;
  const acctRe = /(\d{2}-\d{4}-\d{7}-\d{2})/;
  const periodRe = /(\d{1,2})\s([A-Za-z]{3})[a-z]*\s(\d{4}).{0,4}?-.{0,4}?(\d{1,2})\s([A-Za-z]{3})[a-z]*\s(\d{4})/;
  const txStart = /^(\d{1,2})\s?([A-Za-z]{3})[a-z]*\b/;
  const TYPES = ['AP','BP','DC','ED','FX','IP','IF','AT','CQ','DD','EP','IA','VT','TFR'];

  const yearFor = (mo) => (m1 && mo >= m1) ? y1 : (y2 || y1);

  for (const row of rows) {
    const text = row.text;

    const per = text.match(periodRe);
    if (per) {
      m1 = MONTHS[per[2].toLowerCase()]; y1 = +per[3];
      m2 = MONTHS[per[5].toLowerCase()]; y2 = +per[6];
    }
    const am = text.match(/Account\s*number\s*(\d{2}-\d{4}-\d{7}-\d{2})/i) || text.match(acctRe);
    if (am && /account/i.test(text)) account = am[1];

    const ob = text.match(/Opening\s*balance\s+([\d,]+\.\d{2})/i);
    if (ob) { running = num(ob[1]); continue; }
    if (/Closing\s*balance|Totals?\s*at|Brought\s*forward/i.test(text)) continue;

    // A card transaction's actual date is on the following "Orig date DD/MM/YYYY" line;
    // use it in place of the posting date so filtering reflects the real transaction date.
    const origLine = text.match(/Orig date (\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (origLine && lastTx && !txStart.test(text)) {
      lastTx.date = `${origLine[3]}-${origLine[2].padStart(2, '0')}-${origLine[1].padStart(2, '0')}`;
    }

    const ts = text.match(txStart);
    if (!ts) continue;
    const mo = MONTHS[ts[2].toLowerCase()];
    if (!mo) continue;
    const year = yearFor(mo);
    if (!year) continue;
    const date = `${year}-${String(mo).padStart(2, '0')}-${String(+ts[1]).padStart(2, '0')}`;

    const nums = text.match(/-?[\d,]+\.\d{2}/g) || [];
    if (!nums.length) continue;

    // Strip leading "day Mon" and an optional 2-letter type code from the detail.
    let detail = text.replace(txStart, '').trim();
    let type = '';
    const tcode = detail.match(/^([A-Z]{2})\b/);
    if (tcode && TYPES.includes(tcode[1])) { type = tcode[1]; detail = detail.slice(2).trim(); }
    detail = detail.replace(/-?[\d,]+\.\d{2}\s*$/, '').replace(/-?[\d,]+\.\d{2}\s*$/, '').trim();
    detail = detail.replace(/Orig date \d{2}\/\d{2}\/\d{4}/i, '').replace(/\s+/g, ' ').trim();

    let amount;
    if (nums.length >= 2 && running !== null) {
      // last = balance, second-last = amount; reconcile direction against running balance.
      const bal = num(nums[nums.length - 1]);
      const val = num(nums[nums.length - 2]);
      if (Math.abs(running - val - bal) < 0.02) amount = -val;
      else if (Math.abs(running + val - bal) < 0.02) amount = val;
      else amount = -val;                    // default to outflow if it doesn't reconcile
      running = bal;
    } else {
      const val = num(nums[nums.length - 1]);
      const inflow = ['DC','IF','AP'].includes(type) || /deposit|salary|credit|refund/i.test(detail);
      amount = inflow ? val : -val;
      if (running !== null) running += amount;
    }
    if (amount === null || isNaN(amount)) continue;
    lastTx = { bank: 'ANZ', account: account || 'ANZ', date,
      description: (type ? type + ' ' : '') + detail, amount, sourceFile: fname };
    transactions.push(lastTx);
  }
  if (!transactions.length) warnings.push('ANZ PDF: no transactions parsed — layout may differ. Review in Transactions.');
  return { transactions, warnings, bank: 'ANZ' };
}

// ---------- AMEX ----------
function parseAmexRows(rows, fname) {
  const transactions = [], warnings = [];
  const dateRe = /^(\d{2})\s*\.\s*(\d{2})\s*\.\s*(\d{2})\b/;
  let member = '';
  for (const row of rows) {
    const mm = row.text.match(/XXXX-XXXXXX-(\d{4,6})|Membership\D*(\d{4,6})/i);
    if (mm) member = mm[1] || mm[2] || member;
  }
  const account = 'AMEX' + (member ? '-' + member : '');

  for (const row of rows) {
    const text = row.text;
    const dm = text.match(dateRe);
    if (!dm) continue;
    // Strip the leading date BEFORE looking for amounts, so the date digits aren't mistaken for one.
    const rest = text.replace(dateRe, '').trim();
    const nums = rest.match(/-?[\d,]+\.\d{2}/g);
    if (!nums) continue;                     // no amount on this row → not a usable transaction line
    const yy = +dm[3];
    const date = `${2000 + yy}-${dm[2]}-${dm[1]}`;
    let detail = rest.replace(/-?[\d,]+\.\d{2}(\s*CR)?\s*$/i, '').replace(/\s+/g, ' ').trim();
    if (!detail || /statement|balance|payment due|credit limit|interest/i.test(detail)) continue;

    const isCredit = /\bCR\b/i.test(rest) || /^-/.test(nums[nums.length - 1]);
    const val = Math.abs(num(nums[nums.length - 1]));
    const amount = isCredit ? val : -val;    // charges are outflow
    transactions.push({ bank: 'AMEX', account, date, description: detail, amount, sourceFile: fname });
  }
  if (!transactions.length) warnings.push('AMEX PDF: no transactions parsed — the CSV export is more reliable if available.');
  return { transactions, warnings, bank: 'AMEX' };
}

// ---------- KiwiBank ----------
function parseKiwiRows(rows, fname) {
  const transactions = [], warnings = [];
  let account = null, running = null, y1 = null, m1 = null, y2 = null, inSection = false, lastTx = null;
  const acctRe = /Account\s*Number:?\s*(\d{2}-\d{4}-\d{7}-\d{2})/i;
  const periodRe = /Statement Period:?\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+to\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i;
  const txStart = /^(\d{1,2})\s([A-Za-z]{3})[a-z]*\b/;
  const moneyRe = /-?\$\s?-?[\d,]+\.\d{2}/g;
  const signedNum = (s) => { const v = num(s.replace(/[$,]/g, '')); return v == null ? null : (s.includes('-') ? -Math.abs(v) : v); };
  const yearFor = (mo) => (m1 && mo >= m1) ? y1 : (y2 || y1);

  for (const row of rows) {
    const text = row.text;
    const pm = text.match(periodRe);
    if (pm) { m1 = MONTHS[pm[2].slice(0, 3).toLowerCase()]; y1 = +pm[3]; y2 = +pm[6]; }
    const am = text.match(acctRe);
    if (am) account = am[1];

    const ob = text.match(/Opening Account Balance[^\d]*?(-?\$?-?[\d,]+\.\d{2})/i);
    if (ob) { running = signedNum(ob[1]); inSection = true; lastTx = null; continue; }
    if (/Closing Account Balance/i.test(text)) { inSection = false; lastTx = null; continue; }
    if (!inSection) continue;

    const nums = (text.match(moneyRe) || []).map(signedNum);
    const ts = text.match(txStart);

    if (nums.length && ts) {
      const mo = MONTHS[ts[2].slice(0, 3).toLowerCase()];
      const year = yearFor(mo);
      if (!mo || !year) continue;
      const date = `${year}-${String(mo).padStart(2, '0')}-${String(+ts[1]).padStart(2, '0')}`;
      const detail = text.replace(txStart, '').replace(moneyRe, '').replace(/\s+/g, ' ').trim();
      const bal = nums[nums.length - 1], val = Math.abs(nums.length >= 2 ? nums[nums.length - 2] : nums[0]);
      let amount;
      if (nums.length >= 2 && running !== null) {
        if (Math.abs(running - val - bal) < 0.02) amount = -val;
        else if (Math.abs(running + val - bal) < 0.02) amount = val;
        else amount = -val;
        running = bal;
      } else { amount = -val; if (running !== null) running += amount; }
      if (amount === null || isNaN(amount)) continue;
      lastTx = { bank: 'KiwiBank', account: account || 'KiwiBank', date, description: detail, amount, sourceFile: fname };
      transactions.push(lastTx);
    } else if (lastTx && !nums.length) {
      // Continuation detail line (e.g. "LOAN PMT", "Transfer to … - 04") — enrich prior transaction.
      const extra = text.replace(txStart, '').replace(/\s+/g, ' ').trim();
      if (extra && !/^\.*$/.test(extra) && !/Date\s+Transaction/i.test(extra))
        lastTx.description = (lastTx.description + ' ' + extra).slice(0, 140).trim();
    }
  }
  if (!transactions.length) warnings.push('KiwiBank PDF: no transactions parsed — layout may differ.');
  return { transactions, warnings, bank: 'KiwiBank' };
}

// ---------- generic engine (any bank) ----------
// Strategy: reconstructed rows already align columns by x. We detect header columns
// (debit/credit/amount/balance) by their x-centres, read money tokens with their x,
// and decide the sign by running-balance reconciliation (falling back to Dr/Cr,
// parentheses, trailing '-', or column position when no balance is available).
const pad2 = (n) => String(n).padStart(2, '0');
const nearestTok = (arr, x) => arr.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));

function parseMoney(str) {
  const s = String(str);
  const neg = /^\(/.test(s.trim()) || /\)\s*$/.test(s) || /\bDR\b/i.test(s) || /-\s*[\d($£€₹]/.test(s) || /\d\s*-\s*$/.test(s);
  const pos = /\bCR\b/i.test(s);
  const v = parseFloat(s.replace(/[^\d.]/g, ''));
  if (isNaN(v)) return { mag: null, sign: null };
  return { mag: Math.abs(v), sign: pos ? 1 : (neg ? -1 : null) };
}

function moneyTokens(row) {
  const out = [];
  for (const it of (row.items || [])) {
    const s = it.str;
    if (!/\d\.\d{2}(?!\d)/.test(s)) continue;                 // must look like money (….dd)
    if (/\d[\/.\-]\d{1,2}[\/.\-]\d/.test(s)) continue;        // skip dates like 10.07.26
    const p = parseMoney(s);
    if (p.mag == null) continue;
    out.push({ x: it.x + (it.w || 0) / 2, mag: p.mag, sign: p.sign });
  }
  return out;
}

function detectColumns(headerRow) {
  const cols = { debit: null, credit: null, amount: null, balance: null };
  for (const it of (headerRow.items || [])) {
    const w = it.str.toLowerCase().trim(); const x = it.x + (it.w || 0) / 2;
    if (/^bal|balance/.test(w)) cols.balance ??= x;
    else if (/debit|withdraw|paid\s?out|money\s?out|^dr$|^out$/.test(w)) cols.debit ??= x;
    else if (/credit|deposit|paid\s?in|money\s?in|^cr$|^in$/.test(w)) cols.credit ??= x;
    else if (/amount|value/.test(w)) cols.amount ??= x;
  }
  return cols;
}

function firstDate(text) {
  let m;
  if ((m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return { raw: m[0], iso: `${m[1]}-${m[2]}-${m[3]}` };
  if ((m = text.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/))) {
    const iso = parseDate(m[0], true);
    return { raw: m[0], iso: typeof iso === 'string' ? iso : null };
  }
  if ((m = text.match(/\b(\d{1,2})[\s\-](?:of\s)?([A-Za-z]{3,9})\.?(?:[\s\-,]+(\d{2,4}))?\b/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) {
      const d = +m[1];
      if (m[3]) { let y = m[3]; if (y.length === 2) y = (+y > 70 ? '19' : '20') + y; return { raw: m[0], iso: `${y}-${pad2(mo)}-${pad2(d)}` }; }
      return { raw: m[0], iso: null, mo, day: d };
    }
  }
  if ((m = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})\b/))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) { let y = m[3]; if (y.length === 2) y = (+y > 70 ? '19' : '20') + y; return { raw: m[0], iso: `${y}-${pad2(mo)}-${pad2(+m[2])}` }; }
  }
  return null;
}

function parseGenericRows(rows, fname, bank) {
  const tx = [], warnings = [];

  const headerRow = rows.find(r =>
    /\bdate\b/i.test(r.text) &&
    /(balance|amount|debit|credit|withdraw|deposit|paid\s?(in|out)|money\s?(in|out)|\bdr\b|\bcr\b|value)/i.test(r.text));
  const cols = headerRow ? detectColumns(headerRow) : null;

  // Seed running balance from an opening / brought-forward line.
  let running = null;
  for (const r of rows) {
    if (/opening balance|balance brought forward|brought forward|balance b\/?f/i.test(r.text)) {
      const m = r.text.match(/-?\(?[$£€₹]?\s?[\d,]+\.\d{2}\)?/);
      if (m) { const p = parseMoney(m[0]); if (p.mag != null) { running = p.mag * (p.sign || 1); break; } }
    }
  }

  // Fallback year for date formats that omit it.
  const docYear = (() => {
    for (const r of rows) { const m = r.text.match(/\b(20\d{2}|19\d{2})\b/); if (m) return +m[1]; }
    const fm = (fname || '').match(/\b(20\d{2}|19\d{2})\b/); return fm ? +fm[1] : null;
  })();

  const start = headerRow ? rows.indexOf(headerRow) + 1 : 0;
  for (let i = start; i < rows.length; i++) {
    const row = rows[i], text = row.text;
    if (/opening balance|brought forward|balance b\/?f/i.test(text)) {
      const m = text.match(/-?\(?[$£€₹]?\s?[\d,]+\.\d{2}\)?/);
      if (m) { const p = parseMoney(m[0]); if (p.mag != null) running = p.mag * (p.sign || 1); }
      continue;
    }
    if (/closing balance|balance carried|balance c\/?f|^totals?\b|subtotal|statement period|page \d+\s*(of|\/)/i.test(text)) {
      const m = text.match(/-?\(?[$£€₹]?\s?[\d,]+\.\d{2}\)?/);
      if (m && /carried|c\/?f|closing/i.test(text)) { const p = parseMoney(m[0]); if (p.mag != null) running = p.mag * (p.sign || 1); }
      continue;
    }
    const d = firstDate(text);
    if (!d) continue;
    const date = d.iso || (docYear && d.mo ? `${docYear}-${pad2(d.mo)}-${pad2(d.day)}` : null);
    if (!date) continue;

    const monies = moneyTokens(row);
    if (!monies.length) continue;

    let balTok = null, amtTok = null, colSign = null;
    if (monies.length >= 2) {
      balTok = (cols && cols.balance != null) ? nearestTok(monies, cols.balance)
                                              : monies.reduce((a, b) => (b.x > a.x ? b : a));
      const rest = monies.filter(m => m !== balTok);
      if (cols && (cols.debit != null || cols.credit != null)) {
        amtTok = rest[0];
        const dd = cols.debit != null ? Math.abs(amtTok.x - cols.debit) : Infinity;
        const cc = cols.credit != null ? Math.abs(amtTok.x - cols.credit) : Infinity;
        colSign = dd <= cc ? -1 : 1;
      } else amtTok = (cols && cols.amount != null) ? nearestTok(rest, cols.amount) : rest[rest.length - 1];
    } else {
      amtTok = monies[0];
      if (cols && (cols.debit != null || cols.credit != null)) {
        const dd = cols.debit != null ? Math.abs(amtTok.x - cols.debit) : Infinity;
        const cc = cols.credit != null ? Math.abs(amtTok.x - cols.credit) : Infinity;
        colSign = dd <= cc ? -1 : 1;
      }
    }

    const amag = amtTok.mag;
    const bal = balTok ? balTok.mag * (balTok.sign || 1) : null;
    let amount;
    if (bal != null && running != null) {
      if (Math.abs(running - amag - bal) < 0.02) amount = -amag;
      else if (Math.abs(running + amag - bal) < 0.02) amount = amag;
      else amount = (amtTok.sign || colSign || -1) * amag;
      running = bal;
    } else {
      amount = (amtTok.sign || colSign || -1) * amag;
      if (bal != null) running = bal;
    }
    if (!isFinite(amount)) continue;

    let desc = text.replace(d.raw, ' ')
      .replace(/-?\(?[$£€₹]?\s?[\d,]+\.\d{2}\)?(\s?(?:CR|DR))?/gi, ' ')
      .replace(/\s+/g, ' ').trim();

    tx.push({ bank, account: bank, date, description: desc, amount, sourceFile: fname });
  }

  if (!tx.length) warnings.push('PDF layout not recognised — no transactions parsed. If the bank offers a CSV/Excel export, that imports most reliably.');
  return { transactions: tx, warnings, bank };
}
