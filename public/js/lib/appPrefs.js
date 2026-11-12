// Per-device app options from the Mobile App page (badge, start screen, keep
// the screen on in the console, haptics). Stored in localStorage: they belong
// to this phone or browser, not to the account. Storage can be unavailable
// (private mode, blocked site data), so every access falls back to defaults.

const DEFAULTS = { badge: true, wakelock: false, haptics: true, start: '/' };
const KEY = (name) => `oxyx.app.${name}`;

export function getPref(name) {
  try {
    const raw = localStorage.getItem(KEY(name));
    if (raw === null) return DEFAULTS[name];
    return typeof DEFAULTS[name] === 'boolean' ? raw === '1' : raw;
  } catch {
    return DEFAULTS[name];
  }
}

export function setPref(name, value) {
  try {
    localStorage.setItem(KEY(name), typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  } catch {
    /* not saved; the default applies next time */
  }
}
