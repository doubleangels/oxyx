// What this device and browser can do as an installed app. Shared by the
// install dialog (pwa.js) and the Mobile App page so both make the same call.

const ua = navigator.userAgent;

/** Service workers, install and push all need HTTPS (or localhost). */
export const secure = window.isSecureContext;

/** iPhone, iPod, or an iPad (which reports itself as a Mac with touch). */
export const isIos =
  /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = /android/i.test(ua);
export const isMac = !isIos && /macintosh|mac os x/i.test(ua);

/** True while running as the installed app (opened from its icon). */
export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    /** @type {any} */ (window.navigator).standalone === true
  );
}

/**
 * The browser, as far as installing goes. Order matters: Edge, Opera and
 * Samsung Internet all also say "Chrome", and every iOS browser says "Safari".
 * @returns {'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'opera' | 'other'}
 */
function detectBrowser() {
  if (/SamsungBrowser/i.test(ua)) return 'samsung';
  if (/EdgiOS|EdgA|Edg\//i.test(ua)) return 'edge';
  if (/OPR\/|OPiOS|OPT\//i.test(ua)) return 'opera';
  if (/FxiOS|Firefox\//i.test(ua)) return 'firefox';
  if (/CriOS|Chrome\//i.test(ua)) return 'chrome';
  if (/Safari\//i.test(ua)) return 'safari';
  return 'other';
}
export const browser = detectBrowser();
