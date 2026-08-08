// auth.js — local access gate (hashed PIN) + guest mode. No server; profile lives on-device.
import { $, el, toast } from './util.js';

const AUTH_KEY = 'porul-auth', AUTH_LEGACY = 'fintide-auth';
const loadAuth = () => { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || localStorage.getItem(AUTH_LEGACY)); } catch { return null; } };
const saveAuth = (a) => localStorage.setItem(AUTH_KEY, JSON.stringify(a));

async function sha(text) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const rndSalt = () => [...crypto.getRandomValues(new Uint8Array(8))].map(x => x.toString(16).padStart(2,'0')).join('');

export function initAuth(onLogin) {
  const body = $('#authBody');
  const account = loadAuth();
  body.innerHTML = '';

  const guestBtn = el('button', { class: 'btn ghost full', onclick: () => onLogin('guest', 'Guest') }, 'Continue as guest');
  const sep = el('div', { class: 'auth-sep' }, 'or');

  if (account) {
    // Returning user → verify PIN.
    const pin = el('input', { type: 'password', inputmode: 'numeric', placeholder: '••••', autocomplete: 'off' });
    const signIn = async () => {
      const h = await sha(account.salt + pin.value);
      if (h === account.pinHash) onLogin('user', account.name);
      else { toast('Incorrect PIN', 'err'); pin.value = ''; pin.focus(); }
    };
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
    body.append(
      el('div', { class: 'auth-body' },
        el('h2', {}, `Welcome back, ${account.name}`),
        el('p', { class: 'sub' }, 'Enter your PIN to unlock your dashboard.'),
        el('div', { class: 'field' }, el('label', {}, 'PIN'), pin),
        el('button', { class: 'btn primary full', onclick: signIn }, 'Sign in'),
        el('div', { class: 'auth-alt' }, el('button', { class: 'btn-link', style: 'color:var(--slate)', onclick: () => { localStorage.removeItem(AUTH_KEY); initAuth(onLogin); } }, 'Use a different profile')),
      ), sep, guestBtn);
    setTimeout(() => pin.focus(), 50);
  } else {
    // First run → create profile.
    const name = el('input', { type: 'text', placeholder: 'Your name' });
    const pin = el('input', { type: 'password', inputmode: 'numeric', placeholder: 'Choose a PIN (min 4)' });
    const create = async () => {
      if (!name.value.trim()) return toast('Enter a name', 'err');
      if (pin.value.length < 4) return toast('PIN must be at least 4 characters', 'err');
      const salt = rndSalt();
      saveAuth({ name: name.value.trim(), salt, pinHash: await sha(salt + pin.value) });
      onLogin('user', name.value.trim());
    };
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    body.append(
      el('div', { class: 'auth-body' },
        el('h2', {}, 'Create your profile'),
        el('p', { class: 'sub' }, 'Sets a private PIN on this device. Skip it with guest access.'),
        el('div', { class: 'field' }, el('label', {}, 'Name'), name),
        el('div', { class: 'field' }, el('label', {}, 'PIN'), pin),
        el('button', { class: 'btn primary full', onclick: create }, 'Create & sign in'),
      ), sep, guestBtn);
  }
}

export function renderSecurityPanel(container, currentName, onChange) {
  const account = loadAuth();
  container.innerHTML = '';
  if (!account) {
    container.appendChild(el('p', { class: 'muted' }, 'You are browsing as a guest. Sign out and create a profile to set a PIN.'));
    return;
  }
  const oldPin = el('input', { type: 'password', placeholder: 'Current PIN' });
  const newPin = el('input', { type: 'password', placeholder: 'New PIN (min 4)' });
  const change = async () => {
    const h = await sha(account.salt + oldPin.value);
    if (h !== account.pinHash) return toast('Current PIN incorrect', 'err');
    if (newPin.value.length < 4) return toast('New PIN too short', 'err');
    const salt = rndSalt();
    saveAuth({ ...account, salt, pinHash: await sha(salt + newPin.value) });
    oldPin.value = newPin.value = '';
    toast('PIN updated', 'ok'); onChange && onChange();
  };
  container.append(
    el('p', { class: 'muted' }, `Signed in as ${account.name}.`),
    el('div', { class: 'rule-add' }, oldPin, newPin, el('button', { class: 'btn primary', onclick: change }, 'Change PIN')),
    el('button', { class: 'btn danger', onclick: () => { if (confirm('Remove this device profile? Guests can still use the app.')) { localStorage.removeItem(AUTH_KEY); onChange && onChange(); toast('Profile removed'); } } }, 'Remove profile'));
}
