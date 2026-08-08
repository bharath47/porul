// util.js — small helpers shared across modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

let _cur = '$';
export const setCurrency = (s) => { _cur = s || '$'; };
export const money = (n, { sign = false } = {}) => {
  const v = Math.abs(n);
  const s = _cur + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (sign) return (n < 0 ? '-' : '+') + s;
  return (n < 0 ? '-' : '') + s;
};

export const ym = (isoDate) => (isoDate || '').slice(0, 7);           // yyyy-mm
export const monthLabel = (ym) => {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[+m - 1]} ${y}`;
};

// Normalise a description for matching / de-duplication.
export const normDesc = (d) =>
  (d || '')
    .toUpperCase()
    .replace(/\d{2}\/\d{2}\/\d{2,4}/g, ' ')     // strip embedded dates
    .replace(/\b\d{6,}\b/g, ' ')                 // strip long card/ref numbers
    .replace(/[*#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Merchant guess: first meaningful chunk of the description.
export const merchantOf = (d) => {
  const n = normDesc(d);
  const cut = n.replace(/\s{2,}.*$/, '');       // drop trailing location column
  return (cut || n).split(/\s+/).slice(0, 4).join(' ').trim();
};

// Stable hash (djb2) → hex string, used for transaction ids / dedupe keys.
export const hash = (str) => {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

export const toast = (msg, kind = '') => {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
};

export const download = (name, text, type = 'application/json') => {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
};

// Parse many date shapes → ISO yyyy-mm-dd. dmy=true prefers day-first.
export function parseDate(raw, dmy = true) {
  if (!raw) return null;
  if (raw instanceof Date && !isNaN(raw)) return raw.toISOString().slice(0, 10);
  const s = String(raw).trim();
  const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);            // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})/);   // dd/mm/yyyy or mm/dd/yyyy
  if (m) {
    let [ , a, b, y ] = m;
    let d = +a, mo = +b;
    if (!dmy || d <= 12 && mo > 12) { d = +b; mo = +a; }        // fall back if ambiguous
    if (mo > 12) { const t = d; d = mo; mo = t; }
    if (y.length === 2) y = (+y > 70 ? '19' : '20') + y;
    return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  m = s.match(/^(\d{1,2})\s*([A-Za-z]{3})[a-z]*\s*(\d{4})?/);    // 15 Oct 2020
  if (m && months[m[2].toLowerCase()]) {
    const d = +m[1], mo = months[m[2].toLowerCase()], y = m[3];
    if (y) return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    return { day: d, month: mo };                                // year resolved by caller
  }
  const dt = new Date(s);
  return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
}

export const uid = () => Math.random().toString(36).slice(2, 10);
