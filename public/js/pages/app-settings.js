// Mobile App page: install status, Web Push for this device (subscribe, choose
// categories, servers and quiet hours, test), the list of the user's devices,
// and per-device app options.
import { api } from '../lib/api.js';
import { html, raw } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { confirmDialog } from '../lib/confirm.js';
import { withBusy } from '../lib/loading.js';
import { getPref, setPref } from '../lib/appPrefs.js';
import { initJumpNav } from '../lib/jumpNav.js';

const root = document.getElementById('app-settings');
if (root) init();

function init() {
  initJumpNav();
  const $ = (sel) => root.querySelector(sel);
  const secure = window.isSecureContext;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIos =
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const pushSupported = secure && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  // ---- Install ----
  const mode = $('[data-app-mode]');
  if (standalone) {
    mode.textContent = 'Installed App';
    mode.classList.add('badge-ok');
    root.querySelector('[data-install-app]').classList.add('hidden');
  } else {
    mode.textContent = 'Running in the Browser';
    mode.classList.add('badge-info');
  }
  if (!secure) $('[data-insecure-notice]').classList.remove('hidden');
  if (isIos && !standalone) $('[data-ios-notice]').classList.remove('hidden');

  // ---- Push ----
  const state = $('[data-push-state]');
  const help = $('[data-push-help]');
  const enableBtn = $('[data-push-enable]');
  const disableBtn = $('[data-push-disable]');
  const testBtn = $('[data-push-test]');
  const prefsBox = $('[data-push-prefs]');
  let config = null;
  let subscription = null;
  let device = null;

  const setState = (label, kind) => {
    state.textContent = label;
    state.className = `badge ${kind ? `badge-${kind}` : ''}`;
  };

  function guessDeviceName() {
    const ua = navigator.userAgent;
    const os = /iphone/i.test(ua)
      ? 'iPhone'
      : /ipad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        ? 'iPad'
        : /android/i.test(ua)
          ? 'Android'
          : /windows/i.test(ua)
            ? 'Windows'
            : /mac os/i.test(ua)
              ? 'Mac'
              : /linux/i.test(ua)
                ? 'Linux'
                : 'Device';
    const browser = /edg\//i.test(ua)
      ? 'Edge'
      : /firefox|fxios/i.test(ua)
        ? 'Firefox'
        : /samsungbrowser/i.test(ua)
          ? 'Samsung Internet'
          : /chrome|crios/i.test(ua)
            ? 'Chrome'
            : /safari/i.test(ua)
              ? 'Safari'
              : '';
    return [os, browser].filter(Boolean).join(' · ');
  }

  function keyBytes(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }

  function renderPrefs(prefs) {
    $('[data-push-categories]').innerHTML = html`${config.categories.map(
      (c) =>
        html`<label class="flex cursor-pointer items-start justify-between gap-4 py-2">
          <span class="min-w-0">
            <span class="block text-sm font-medium text-ink"
              >${c.label}${c.critical ? raw(' <span class="badge badge-danger ml-1">Urgent</span>') : ''}</span
            >
            <span class="mt-0.5 block text-xs leading-relaxed text-ink-faint">${c.help}</span>
          </span>
          <span class="msm-toggle mt-0.5 shrink-0"
            ><input
              type="checkbox"
              data-push-cat="${c.key}"
              ${raw(prefs.categories[c.key] ? 'checked' : '')} /><span></span
          ></span>
        </label>`
    )}`;
    const all = prefs.servers === 'all';
    $('#push-all-servers').checked = all;
    const box = $('[data-push-servers]');
    box.classList.toggle('hidden', all);
    box.innerHTML = config.servers.length
      ? html`${config.servers.map(
          (s) =>
            html`<label class="flex items-center gap-2 rounded-sm border border-line bg-inset px-3 py-2 text-sm">
              <input
                type="checkbox"
                class="msm-check"
                data-push-server="${s.id}"
                ${raw(all || prefs.servers.includes(s.id) ? 'checked' : '')}
              />
              <span class="truncate">${s.name}</span>
            </label>`
        )}`
      : html`<p class="empty-inline">No servers yet.</p>`;
    $('#push-quiet').checked = prefs.quiet.enabled;
    $('#push-quiet-from').value = prefs.quiet.from;
    $('#push-quiet-to').value = prefs.quiet.to;
    $('#push-quiet-critical').checked = prefs.quiet.allowCritical;
    $('[data-push-quiet-times]').classList.toggle('opacity-50', !prefs.quiet.enabled);
  }

  function readPrefs() {
    const categories = {};
    for (const el of root.querySelectorAll('[data-push-cat]')) categories[el.dataset.pushCat] = el.checked;
    const servers = $('#push-all-servers').checked
      ? 'all'
      : [...root.querySelectorAll('[data-push-server]:checked')].map((el) => el.dataset.pushServer);
    return {
      categories,
      servers,
      quiet: {
        enabled: $('#push-quiet').checked,
        from: $('#push-quiet-from').value || '22:00',
        to: $('#push-quiet-to').value || '07:00',
        allowCritical: $('#push-quiet-critical').checked,
      },
    };
  }

  $('#push-all-servers').addEventListener('change', (e) => {
    $('[data-push-servers]').classList.toggle('hidden', e.target.checked);
  });
  $('#push-quiet').addEventListener('change', (e) => {
    $('[data-push-quiet-times]').classList.toggle('opacity-50', !e.target.checked);
  });

  function renderDevices() {
    const list = $('[data-push-devices]');
    if (!config.devices.length) {
      list.innerHTML = html`<p class="empty-inline">
        No devices yet. Turn notifications on above, on each phone or computer you want them on.
      </p>`;
      return;
    }
    list.innerHTML = html`${config.devices.map(
      (d) =>
        html`<div class="flex flex-wrap items-center gap-3 py-3" data-device="${d.id}">
          <span class="grid size-9 shrink-0 place-items-center rounded-md bg-inset text-ink-faint"
            >${raw(d.userAgent && /mobile|android|iphone/i.test(d.userAgent) ? '📱' : '💻')}</span
          >
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
              ${d.deviceName}${device && device.id === d.id ? raw(' <span class="badge badge-ok">This Device</span>') : ''}${d.lastError ? raw(' <span class="badge badge-warn">Delivery Problem</span>') : ''}
            </div>
            <div class="text-xs text-ink-faint">
              Added
              <span data-ts="${d.createdAt}">${d.createdAt}</span
              >${d.lastSentAt ? html` · last notified <span data-ts="${d.lastSentAt}">${d.lastSentAt}</span>` : ''}${d.lastError ? html` · ${d.lastError}` : ''}
            </div>
          </div>
          <button type="button" class="btn btn-sm" data-device-test="${d.id}">Test</button>
          <button type="button" class="btn btn-ghost btn-sm text-danger" data-device-remove="${d.id}">Remove</button>
        </div>`
    )}`;
  }

  async function load() {
    try {
      config = await api(
        `/api/account/push${subscription ? `?endpoint=${encodeURIComponent(subscription.endpoint)}` : ''}`,
        {
          action: 'load your notification settings',
        }
      );
    } catch (err) {
      setState('Unavailable', 'warn');
      help.textContent = err.message;
      return;
    }
    device = config.thisDevice;
    renderDevices();
    addServerStartOptions(config.servers);
    if (!pushSupported) {
      setState('Not Available Here', 'warn');
      help.textContent = !secure
        ? 'Notifications need the panel on a secure (HTTPS) address.'
        : isIos && !standalone
          ? 'Open Oxyx from your Home Screen to turn notifications on.'
          : 'This browser does not support push notifications.';
      return;
    }
    if (Notification.permission === 'denied') {
      setState('Blocked', 'danger');
      help.textContent =
        'Notifications are blocked for this site. Allow them in the browser or system settings, then reload this page.';
      return;
    }
    if (subscription && device) {
      setState('On for This Device', 'ok');
      help.textContent = 'You will be notified even when the app is closed.';
      enableBtn.classList.add('hidden');
      testBtn.classList.remove('hidden');
      disableBtn.classList.remove('hidden');
      prefsBox.classList.remove('hidden');
      $('#push-device-name').value = device.deviceName;
      renderPrefs(device.prefs);
    } else {
      setState('Off for This Device', null);
      help.textContent = 'Turn it on to hear about crashes and problems right away.';
      enableBtn.classList.remove('hidden');
      testBtn.classList.add('hidden');
      disableBtn.classList.add('hidden');
      prefsBox.classList.add('hidden');
    }
  }

  async function start() {
    if (pushSupported) {
      const reg = await navigator.serviceWorker.ready;
      subscription = await reg.pushManager.getSubscription();
    }
    await load();
  }

  enableBtn.addEventListener('click', () =>
    withBusy(enableBtn, 'Turning on…', async () => {
      const permission = await Notification.requestPermission().catch(() => 'denied');
      if (permission !== 'granted') {
        toast('Notifications were not allowed. Allow them in the browser settings to turn them on.', { kind: 'warn' });
        return load();
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        subscription =
          (await reg.pushManager.getSubscription()) ||
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(config.publicKey),
          }));
        await api('/api/account/push/subscribe', {
          method: 'POST',
          body: { subscription: subscription.toJSON(), deviceName: guessDeviceName(), prefs: config.defaults },
          action: 'turn notifications on',
        });
        toast('Notifications are on for this device.');
      } catch (err) {
        toast(err.message || 'Could not turn notifications on. Try again in a moment.', { kind: 'error' });
      }
      await load();
    })
  );

  disableBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Turn notifications off on this device?',
      message: 'This device stops receiving notifications. Your other devices keep theirs.',
      confirmLabel: 'Turn Off',
      danger: true,
    });
    if (!ok) return;
    await withBusy(disableBtn, 'Turning off…', async () => {
      try {
        if (device)
          await api(`/api/account/push/devices/${device.id}`, { method: 'DELETE', action: 'turn notifications off' });
        if (subscription) await subscription.unsubscribe().catch(() => {});
        subscription = null;
        toast('Notifications are off for this device.');
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
      await load();
    });
  });

  async function sendTest(id, btn) {
    await withBusy(btn, 'Sending…', async () => {
      try {
        await api(`/api/account/push/devices/${id}/test`, { method: 'POST', action: 'send a test notification' });
        toast('Test notification sent. It should arrive within a few seconds.');
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
    });
  }
  testBtn.addEventListener('click', () => device && sendTest(device.id, testBtn));

  $('[data-push-save]').addEventListener('click', (e) =>
    withBusy(e.currentTarget, 'Saving…', async () => {
      if (!device) return;
      const prefs = readPrefs();
      if (prefs.servers !== 'all' && !prefs.servers.length) {
        toast('Pick at least one server, or turn All Servers back on.', { kind: 'warn' });
        return;
      }
      try {
        device = (
          await api(`/api/account/push/devices/${device.id}`, {
            method: 'PATCH',
            body: { deviceName: $('#push-device-name').value, prefs },
            action: 'save your notification choices',
          })
        ).device;
        toast('Notification choices saved.');
        await load();
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
    })
  );

  $('[data-push-devices]').addEventListener('click', async (e) => {
    const test = e.target.closest('[data-device-test]');
    const remove = e.target.closest('[data-device-remove]');
    if (test) return sendTest(test.dataset.deviceTest, test);
    if (!remove) return;
    const ok = await confirmDialog({
      title: 'Remove this device?',
      message: 'It stops receiving notifications until notifications are turned on there again.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/account/push/devices/${remove.dataset.deviceRemove}`, {
        method: 'DELETE',
        action: 'remove that device',
      });
      if (device && device.id === remove.dataset.deviceRemove && subscription) {
        await subscription.unsubscribe().catch(() => {});
        subscription = null;
      }
      toast('Device removed.');
      await load();
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  });

  // ---- App options (this device) ----
  for (const [id, name] of [
    ['#app-badge', 'badge'],
    ['#app-wakelock', 'wakelock'],
    ['#app-haptics', 'haptics'],
  ]) {
    const el = $(id);
    el.checked = getPref(name);
    el.addEventListener('change', () => {
      setPref(name, el.checked);
      if (name === 'badge' && !el.checked && 'clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
      toast('Saved on this device.');
    });
  }
  if (!('wakeLock' in navigator)) {
    $('#app-wakelock').disabled = true;
    $('#app-wakelock').closest('label').classList.add('opacity-50');
  }
  const startSel = $('[data-app-start]');
  function addServerStartOptions(servers) {
    if (startSel.dataset.filled) return;
    startSel.dataset.filled = '1';
    for (const s of servers) {
      for (const [suffix, label] of [
        ['', ''],
        ['/console', ' Console'],
      ]) {
        const opt = document.createElement('option');
        opt.value = `/servers/${s.id}${suffix}`;
        opt.textContent = `${s.name}${label}`;
        startSel.appendChild(opt);
      }
    }
    startSel.value = getPref('start');
    if (startSel.value !== getPref('start')) startSel.value = '/';
  }
  startSel.addEventListener('change', () => {
    setPref('start', startSel.value);
    toast('Saved on this device.');
  });

  start();
}
