// storage.js — folder access, statement discovery, and persistence of fintide-data.json.
import { DATA_FILE, LEGACY_DATA_FILES } from './config.js';

export const hasFS = typeof window.showDirectoryPicker === 'function';

// --- tiny IndexedDB store to remember the chosen directory handle across sessions ---
const IDB = 'fintide', STORE = 'handles';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readonly'); const rq = tx.objectStore(STORE).get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }

let dirHandle = null;

export async function pickDirectory() {
  dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await idbSet('dir', dirHandle);
  return dirHandle;
}

export async function restoreDirectory() {
  if (!hasFS) return null;
  try {
    const h = await idbGet('dir');
    if (!h) return null;
    const perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') { dirHandle = h; return h; }
    dirHandle = h;                 // needs a user gesture to re-grant → see ensurePermission()
    return h;
  } catch { return null; }
}

export async function ensurePermission() {
  if (!dirHandle) return false;
  if ((await dirHandle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await dirHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export const currentDirName = () => dirHandle?.name || null;

// Recursively collect statement files.
export async function scanDirectory(handle = dirHandle, prefix = '') {
  const out = [];
  if (!handle) return out;
  for await (const [name, h] of handle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'directory') {
      if (name.startsWith('.')) continue;
      out.push(...await scanDirectory(h, path));
    } else {
      const ext = name.split('.').pop().toLowerCase();
      if (['pdf','csv','xls','xlsx'].includes(ext)) out.push({ name, path, ext, handle: h });
    }
  }
  return out;
}

export async function readFileFromHandle(fileEntry) {
  return await fileEntry.handle.getFile();
}

// --- persistence file (lives inside the source folder) ---
export async function loadData() {
  if (!dirHandle) return null;
  for (const fn of [DATA_FILE, ...LEGACY_DATA_FILES]) {
    try {
      const fh = await dirHandle.getFileHandle(fn);
      return JSON.parse(await (await fh.getFile()).text());
    } catch { /* try next */ }
  }
  return null;                     // not present yet
}

export async function saveData(obj) {
  if (!dirHandle) throw new Error('No source folder selected.');
  if (!(await ensurePermission())) throw new Error('Write permission denied.');
  const fh = await dirHandle.getFileHandle(DATA_FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  await w.close();
  return true;
}

// Guest / no-FS fallback persistence in localStorage.
const LS_KEY = 'porul-data', LS_LEGACY = 'fintide-data';
export const loadLocal = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || localStorage.getItem(LS_LEGACY)); } catch { return null; } };
export const saveLocal = (obj) => localStorage.setItem(LS_KEY, JSON.stringify(obj));
