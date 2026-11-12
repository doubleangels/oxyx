// Installable app support: registers the service worker, offers "Install App"
// in the account menu and on the Mobile App page, and keeps the home-screen
// icon badge in step with unread health alerts.
//
// The service worker and notifications need a secure context (HTTPS, or
// localhost); on plain HTTP they stay off. Install App still shows there, to
// explain what to do (and iOS installs over HTTP anyway). Turning
// notifications on lives on the Mobile App page: the one permission covers
// Web Push and the "task finished" notices below.

import { openModal } from './modal.js';
import { toast } from './toast.js';
import { getPref } from './appPrefs.js';
import { html, raw } from './format.js';
import { secure, isIos, isAndroid, isMac, isStandalone, browser } from './platform.js';

// The account menu is cloned from a <template> each time it opens, so the
// items are revealed on the template itself (and on any open copy).
function reveal(selector, show = true) {
  const tpl = /** @type {HTMLTemplateElement | null} */ (document.getElementById('user-menu'));
  const nodes = [...(tpl ? tpl.content.querySelectorAll(selector) : []), ...document.querySelectorAll(selector)];
  for (const el of nodes) el.classList.toggle('hidden', !show);
}

// ---- Service worker ----
if (secure && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* installing still works where the browser does not require a worker */
    });
  });
}

// ---- Install App ----
// Chrome, Edge and Samsung Internet on a secure address hand over their own
// install prompt (beforeinstallprompt); the button then simply opens it.
// Everywhere else the button explains the steps for the browser in use, so it
// always leads somewhere useful. Once running as the installed app it hides.
const coarse = window.matchMedia('(pointer: coarse)').matches;
/** @type {any} */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // keep the browser's mini-infobar quiet; the button asks instead
  deferredPrompt = e;
  reveal('[data-install-app]');
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  reveal('[data-install-app]', false);
  toast('Oxyx is installed. Open it from your home screen or app list.');
  document.dispatchEvent(new CustomEvent('oxyx:app-installed'));
});
if (isStandalone()) reveal('[data-install-app]', false);
else if (isIos || coarse || !secure) reveal('[data-install-app]');

const HOME = raw('<b>Add to Home Screen</b>');
const THEN_NOTIFY = raw(
  'To get notifications, open Oxyx from its new icon and go to <a class="text-link hover:underline" href="/settings/app#app-push">Mobile App</a>.'
);

/**
 * The steps for this browser, and an optional note under them.
 * @returns {{ steps: unknown[], note?: unknown }}
 */
function installGuide() {
  if (isIos) {
    const where =
      browser === 'safari'
        ? raw('Tap <b>Share</b> (the square with an arrow) at the bottom of Safari, or at the top on an iPad.')
        : raw('Tap <b>Share</b> in the address bar, or open the browser menu and choose <b>Share</b>.');
    return {
      steps: [
        where,
        html`Scroll down and tap ${HOME}. If you see <b>Open as Web App</b>, leave it on.`,
        html`Tap <b>Add</b>, then open <b>Oxyx</b> from your Home Screen.`,
      ],
      note:
        browser === 'safari' || browser === 'chrome' || browser === 'edge'
          ? html`Notifications on iPhone and iPad need iOS 16.4 or later and work only in the installed app.
            ${THEN_NOTIFY}`
          : html`If ${HOME} is missing, open this page in Safari and try there.`,
    };
  }
  if (!secure) {
    return {
      steps: [
        raw(
          'Installing Oxyx as an app needs a secure (HTTPS) address. On this address your browser can only add a shortcut that opens in a browser tab.'
        ),
        raw(
          'To install it properly, open the panel through a domain with an HTTPS certificate, for example behind a reverse proxy. The README explains how.'
        ),
      ],
      note: isAndroid ? html`For the shortcut instead, open your browser menu and choose ${HOME}.` : undefined,
    };
  }
  if (isAndroid) {
    if (browser === 'samsung') {
      return {
        steps: [
          raw('Tap the menu button (<b>☰</b>) at the bottom.'),
          raw('Tap <b>Add page to</b>, then <b>Home screen</b>.'),
          raw('Tap <b>Add</b>, then open <b>Oxyx</b> from your home screen.'),
        ],
        note: THEN_NOTIFY,
      };
    }
    if (browser === 'firefox') {
      return {
        steps: [
          raw('Tap the menu button (<b>⋮</b>).'),
          raw('Tap <b>Add app to Home screen</b> (on older versions, <b>Install</b> or <b>Add to Home screen</b>).'),
          raw('Confirm, then open <b>Oxyx</b> from your home screen.'),
        ],
        note: THEN_NOTIFY,
      };
    }
    return {
      steps: [
        raw('Tap the menu button (<b>⋮</b>) next to the address bar.'),
        raw('Tap <b>Add to Home screen</b>, then <b>Install</b>.'),
        raw('Open <b>Oxyx</b> from your home screen or app list.'),
      ],
      note: html`If there is no install option, Oxyx may already be installed. Look for it in your app list.
      ${THEN_NOTIFY}`,
    };
  }
  // Computers.
  if (isMac && browser === 'safari') {
    return {
      steps: [
        raw('In the menu bar, choose <b>File</b>, then <b>Add to Dock</b>.'),
        raw('Click <b>Add</b>. Oxyx opens from the Dock and Launchpad in its own window.'),
      ],
      note: raw('Add to Dock needs macOS Sonoma or later.'),
    };
  }
  if (browser === 'firefox') {
    return {
      steps: [
        raw('Firefox on a computer usually cannot install sites as apps.'),
        raw(
          'Open this page in Chrome or Edge and choose <b>Install App</b> there. Everything else works the same in Firefox.'
        ),
      ],
    };
  }
  if (browser === 'edge') {
    return {
      steps: [
        raw('Click the app icon at the right end of the address bar, or open the menu (<b>…</b>).'),
        raw('Choose <b>Apps</b>, then <b>Install this site as an app</b>.'),
        raw('Click <b>Install</b>. Oxyx opens in its own window.'),
      ],
      note: raw('If there is no install option, Oxyx is probably installed already. Look for it in your apps.'),
    };
  }
  return {
    steps: [
      raw('Click the install icon at the right end of the address bar, or open the menu (<b>⋮</b>).'),
      raw('Choose <b>Cast, save, and share</b>, then <b>Install page as app</b>.'),
      raw('Click <b>Install</b>. Oxyx opens in its own window.'),
    ],
    note: raw('If there is no install option, Oxyx is probably installed already. Look for it in your apps.'),
  };
}

document.addEventListener('click', async (e) => {
  const target = /** @type {Element} */ (e.target);
  if (!target.closest('[data-install-app]')) return;
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => null);
    deferredPrompt = null;
    return;
  }
  const { steps, note } = installGuide();
  const content = document.createElement('div');
  content.innerHTML = html`<ol class="list-decimal space-y-2 pl-5 text-sm">
      ${steps.map((step) => html`<li>${step}</li>`)}
    </ol>
    ${note ? html`<p class="help mt-3">${note}</p>` : ''}`;
  openModal({ title: 'Install Oxyx', content, actions: [{ label: 'Done', kind: 'primary' }] });
});

/**
 * Show a system notification, only while the panel is not in front (a visible
 * page already shows its own toast). Goes through the service worker when
 * there is one: Android cannot construct `new Notification()` in a page.
 */
export function notify(title, { body = '', url = '/' } = {}) {
  if (!secure || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  const opts = {
    body,
    icon: '/icons/oxyx-192.png',
    badge: '/icons/oxyx-badge-96.png',
    data: { url },
    tag: title,
  };
  const viaWorker =
    'serviceWorker' in navigator && navigator.serviceWorker.controller
      ? navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts))
      : Promise.reject(new Error('no worker'));
  viaWorker.catch(() => {
    try {
      new Notification(title, opts);
    } catch {
      /* this browser only notifies from a worker */
    }
  });
}

// ---- Home-screen badge: unread health alerts (Mobile App > App Options) ----
const healthCount = Number(document.body?.dataset.healthCount) || 0;
if ('setAppBadge' in navigator) {
  (healthCount && getPref('badge') ? navigator.setAppBadge(healthCount) : navigator.clearAppBadge()).catch(() => {});
}

// ---- Start screen: the installed app launches at /?launch=app (manifest
// start_url); send it to the page chosen on the Mobile App page, once. ----
{
  const url = new URL(location.href);
  if (url.searchParams.get('launch') === 'app') {
    url.searchParams.delete('launch');
    const start = getPref('start');
    if (start && start !== '/' && start.startsWith('/') && !start.startsWith('//')) location.replace(start);
    else history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
}

// ---- Keep the screen on while a console is open (Screen Wake Lock) ----
if ('wakeLock' in navigator && getPref('wakelock') && /^\/servers\/[^/]+\/console$/.test(location.pathname)) {
  let lock = null;
  const acquire = () => {
    if (document.visibilityState !== 'visible' || lock) return;
    navigator.wakeLock
      .request('screen')
      .then((l) => {
        lock = l;
        l.addEventListener('release', () => (lock = null));
      })
      .catch(() => {});
  };
  acquire();
  // The browser drops the lock whenever the page is hidden; take it back.
  document.addEventListener('visibilitychange', acquire);
}

// ---- Haptics: a short buzz on server power actions (Android) ----
if ('vibrate' in navigator) {
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-server-action]') && getPref('haptics')) navigator.vibrate(15);
  });
}
