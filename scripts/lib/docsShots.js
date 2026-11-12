'use strict';
/* global document, window, PushManager, Notification -- page.evaluate() callbacks run in the browser */

// The screenshot list for scripts/docs-screenshots.js. Each entry names its
// output file (docs/images by default, docs/screenshots with dir: 'shots') and
// a run(page) that brings the page into the state the doc describes. Entries
// marked firstRun run against the empty panel, before the demo is seeded.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

module.exports = function shots({ base, demo }) {
  const go = (p) => async (page) => {
    await page.goto(base + p, { waitUntil: 'networkidle' });
  };
  // Scroll an element to just under the sticky topbar.
  const reveal =
    (sel, offset = 80) =>
    async (page) => {
      await page.waitForSelector(sel);
      await page.evaluate(
        ([s, o]) => {
          const el = document.querySelector(s);
          window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - o, behavior: 'instant' });
        },
        [sel, offset]
      );
    };
  const steps =
    (...fns) =>
    async (page) => {
      for (const fn of fns) await fn(page);
    };
  const click = (sel) => async (page) => {
    await page.click(sel);
  };
  const waitFor = (sel) => async (page) => {
    await page.waitForSelector(sel, { state: 'visible' });
  };
  const S = 'srv_harbor';
  const F = 'srv_fabric';
  const N = 'srv_nexus';
  // Responses that would come from Modrinth, Hangar or mclo.gs: answered here
  // so the screenshots never depend on (or touch) a third-party service.
  const fake = (pattern, body) => async (page) => {
    await page.route(pattern, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    );
  };

  // The Mobile App page with push "on" for this browser. Headless Chromium has
  // no push service, so the browser side is stubbed to own the demo endpoint
  // seeded in docsDemo.js; everything else is the real page and API.
  const mobileApp = (viewport, anchor) => async (page) => {
    await page.setViewportSize(viewport);
    await page.addInitScript((endpoint) => {
      const fake = {
        endpoint,
        toJSON: () => ({ endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'demoauthsecret00demo' } }),
        unsubscribe: async () => true,
      };
      if (window.PushManager) PushManager.prototype.getSubscription = async () => fake;
      // Headless Chromium always reports notifications as denied.
      if (window.Notification) Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    }, demo.DEMO_ENDPOINT);
    await demo.signIn(page, base);
    await go('/settings/app')(page);
    await page.waitForSelector('[data-push-prefs]:not(.hidden)');
    if (anchor) await reveal(anchor, 70)(page);
  };

  return [
    // ---- First run (empty panel) -------------------------------------------
    {
      file: 'setup-system-check.png',
      firstRun: true,
      fresh: true,
      run: steps(go('/setup'), click('[data-step="0"] [data-next]'), waitFor('[data-step="1"]')),
      settle: 1200,
    },

    // ---- Overview pages ------------------------------------------------------
    { file: '01-dashboard.png', dir: 'shots', run: go('/') },
    { file: 'dashboard.png', run: go('/') },
    { file: 'servers-list.png', run: go('/servers') },
    { file: '03-server-overview.png', dir: 'shots', run: go(`/servers/${S}`) },
    { file: 'server-overview.png', run: go(`/servers/${S}`) },
    { file: 'world-controls.png', run: steps(go(`/servers/${S}`), reveal('#world-controls, [data-world-controls]')) },
    {
      file: 'monitoring-live.png',
      run: async (page) => {
        // The charts are fed by the stats WebSocket: stream a minute of samples.
        await page.routeWebSocket(/\/ws\/stats\//, (ws) => {
          let rx = 900 * 1024 * 1024;
          let tx = 300 * 1024 * 1024;
          let i = 0;
          const timer = setInterval(() => {
            if (i++ >= 60) return clearInterval(timer);
            const wave = Math.sin(i / 6);
            rx += (180 + 60 * wave) * 1024 * 0.05;
            tx += (70 + 25 * Math.cos(i / 5)) * 1024 * 0.05;
            ws.send(
              JSON.stringify({
                kind: 'stats',
                cpuPct: Math.round(34 + 9 * wave + (i % 7)),
                memUsedBytes: (3050 + 90 * Math.sin(i / 9) + i * 2) * 1024 * 1024,
                netRx: rx,
                netTx: tx,
                perf: {
                  tps1: 19.9 - (i % 13 === 0 ? 1.4 : 0),
                  tps5: 19.9,
                  tps15: 19.9,
                  mspt: 18 + 6 * Math.abs(wave),
                  source: 'paper',
                },
                perfSupported: true,
              })
            );
          }, 50);
        });
        await go(`/servers/${S}/metrics`)(page);
        await page.waitForTimeout(3600);
      },
      after: async (page) => page.unrouteAll({ behavior: 'ignoreErrors' }),
    },
    { file: '10-history.png', dir: 'shots', run: go(`/servers/${S}/history`) },
    { file: 'activity.png', run: go('/activity') },
    { file: 'updates.png', run: go('/updates') },
    { file: 'storage.png', run: go('/storage') },
    { file: '15-storage.png', dir: 'shots', run: go('/storage') },
    { file: 'schedules.png', run: go('/schedules') },
    { file: '14-schedules.png', dir: 'shots', run: go('/schedules') },
    { file: 'backups.png', run: go('/backups') },
    { file: 'blueprints.png', run: go('/blueprints') },
    { file: '13-blueprints.png', dir: 'shots', run: go('/blueprints') },
    { file: 'worlds.png', run: go('/worlds') },
    { file: 'modpacks.png', run: go('/modpacks') },

    // ---- Create wizard -------------------------------------------------------
    { file: 'create-wizard.png', run: go('/servers/new'), settle: 1200 },
    { file: '02-create-wizard.png', dir: 'shots', run: go('/servers/new'), settle: 1200 },

    // ---- Console, chat, commands, chatbot ------------------------------------
    { file: 'server-console.png', run: go(`/servers/${S}/console`), settle: 1200 },
    { file: '05-console.png', dir: 'shots', run: go(`/servers/${S}/console`), settle: 1200 },
    {
      file: '04-chat.png',
      dir: 'shots',
      run: steps(go(`/servers/${S}/chat`), async (page) => {
        for (const text of [
          'Server restart in 10 minutes, find a safe spot!',
          'Build contest results are up at spawn.',
        ]) {
          await page.fill('#chat-input', text);
          await page.press('#chat-input', 'Enter');
          await page.waitForTimeout(400);
        }
      }),
      settle: 900,
    },
    { file: 'chat-commands.png', run: go(`/servers/${S}/commands`) },
    { file: '11-chat-commands.png', dir: 'shots', run: go(`/servers/${S}/commands`) },
    { file: 'integrations-chatbot.png', run: go(`/servers/${S}/chatbot`) },
    { file: 'chatbot-transcripts.png', run: steps(go(`/servers/${S}/chatbot`), reveal('#ig-wz-transcripts')) },

    // ---- Players -------------------------------------------------------------
    { file: 'players.png', run: go(`/servers/${S}/players`), settle: 900 },

    // ---- Content -------------------------------------------------------------
    { file: 'mods.png', run: go(`/servers/${F}/mods`) },
    { file: '06-mods.png', dir: 'shots', run: go(`/servers/${F}/mods`) },
    {
      file: 'mods-revert.png',
      run: async (page) => {
        // The revert offer appears once a mod remembers the build it came from.
        require('../../src/db').run(
          "UPDATE server_content SET previous_library_id = 'lib_mod2', previous_version = '0.6.12', previous_at = datetime('now', '-2 days') WHERE id = 'sc_mod1'"
        );
        await go(`/servers/${F}/mods`)(page);
      },
    },
    {
      file: 'mods-add-by-link.png',
      run: steps(go(`/servers/${F}/mods`), click('#mods-add-url'), waitFor('.modal, [role="dialog"]')),
      after: async (page) => page.keyboard.press('Escape'),
    },
    {
      file: 'mods-search-hangar.png',
      run: steps(
        fake('**/api/mods/search**', {
          ok: true,
          results: [
            {
              platform: 'hangar',
              projectId: 'luckperms',
              ref: 'Luck/LuckPerms',
              name: 'LuckPerms',
              description: 'A permissions plugin for Minecraft servers.',
              downloads: 2981442,
              iconUrl: null,
            },
            {
              platform: 'hangar',
              projectId: 'permissionsex',
              ref: 'PEX/PermissionsEx',
              name: 'PermissionsEx',
              description: 'Permissions manager with groups, inheritance and per-world rules.',
              downloads: 412308,
              iconUrl: null,
            },
            {
              platform: 'hangar',
              projectId: 'griefprevention',
              ref: 'RoboMWM/GriefPrevention',
              name: 'GriefPrevention',
              description: 'Land claims with permissions for trusted players.',
              downloads: 1203556,
              iconUrl: null,
            },
          ],
        }),
        go(`/servers/${S}/mods`),
        click('#mods-search'),
        waitFor('#mr-q'),
        click('[data-platform="hangar"]'),
        async (page) => {
          await page.fill('#mr-q', 'permissions');
          await page.waitForSelector('#mr-results .font-semibold', { state: 'visible' });
        }
      ),
      after: async (page) => {
        await page.unroute('**/api/mods/search**');
        await page.keyboard.press('Escape');
      },
      settle: 900,
    },
    {
      file: 'mrpack-import.png',
      run: async (page) => {
        await go(`/servers/${F}/mods`)(page);
        const file = path.join(os.tmpdir(), 'demo-pack.mrpack');
        fs.writeFileSync(file, await demo.mrpack());
        const input = await page.$('input[type="file"]');
        await input.setInputFiles(file);
        await page.waitForSelector('.modal, [role="dialog"]', { state: 'visible' });
      },
      after: async (page) => page.keyboard.press('Escape'),
      settle: 1200,
    },
    { file: 'server-versions.png', run: go(`/servers/${F}/updates`), settle: 900 },
    { file: '16-versions.png', dir: 'shots', run: go(`/servers/${F}/updates`), settle: 900 },
    {
      file: 'server-versions-expanded.png',
      run: steps(
        go(`/servers/${F}/updates`),
        async (page) => {
          await page.waitForSelector('#compat-versions details, #compat-versions [data-version]');
          const rows = await page.$$('#compat-versions details summary, #compat-versions [data-version] button');
          if (rows.length) await rows[rows.length - 1].click();
        },
        reveal('#compat-versions')
      ),
      settle: 900,
    },
    { file: '07-worlds.png', dir: 'shots', run: go(`/servers/${S}/worlds`) },
    {
      file: 'world-shrink.png',
      run: steps(go('/servers/srv_emerald/worlds'), click('[data-world-shrink]'), waitFor('.modal, [role="dialog"]')),
      after: async (page) => page.keyboard.press('Escape'),
    },

    // ---- Data ----------------------------------------------------------------
    { file: 'server-backups.png', run: go(`/servers/${S}/backups`) },
    { file: '08-backups.png', dir: 'shots', run: go(`/servers/${S}/backups`) },
    {
      file: 'backup-rename.png',
      run: steps(go(`/servers/${S}/backups`), click('[data-backup-rename]'), waitFor('.modal, [role="dialog"]')),
      after: async (page) => page.keyboard.press('Escape'),
    },
    {
      file: 'server-retention.png',
      run: steps(
        go(`/servers/${S}/backups`),
        async (page) => {
          await page.click('[data-retention-form] summary, details:has([data-retention-form]) > summary');
        },
        reveal('[data-retention-form]', 120)
      ),
    },
    { file: 'server-files.png', run: go(`/servers/${S}/files`) },

    // ---- Crashes -------------------------------------------------------------
    { file: 'crash-mclogs-card.png', run: steps(go(`/servers/${N}/history`), reveal('[data-crash-card]', 140)) },
    {
      file: 'crash-insights.png',
      run: steps(
        fake('**/crashes/*/insights', {
          ok: true,
          insights: {
            url: 'https://mclo.gs/aB3dE9f',
            title: 'Forge 47.3.0 crash report',
            type: 'Forge server crash report',
            version: '1.20.1',
            problems: [
              {
                message: 'The mod "Create" (create) threw a NullPointerException while ticking an entity.',
                counter: 2,
                solutions: [
                  'Update Create to the latest 1.20.1 build.',
                  'Remove the contraption entity at -1240 64 382 with a world editor.',
                ],
              },
            ],
            information: [
              { label: 'Java', value: '17.0.12' },
              { label: 'Forge', value: '47.3.0' },
              { label: 'Mods', value: '184' },
              { label: 'Memory', value: '6144 MB' },
            ],
          },
        }),
        go(`/servers/${N}/history`),
        click('[data-crash-action="insights"]'),
        async (page) => {
          // Publishing to mclo.gs is confirmed first; accept it.
          const confirm = await page.waitForSelector('.modal .btn-primary, [role="dialog"] .btn-primary');
          await confirm.click();
          await page.waitForSelector('text=mclo.gs', { state: 'visible' }).catch(() => {});
        }
      ),
      after: async (page) => {
        await page.unroute('**/crashes/*/insights');
        await page.keyboard.press('Escape');
      },
      settle: 900,
    },

    // ---- Server settings -----------------------------------------------------
    { file: 'server-settings.png', run: go(`/servers/${S}/settings`) },
    { file: '09-settings.png', dir: 'shots', run: go(`/servers/${S}/settings`) },
    { file: 'server-port.png', run: steps(go(`/servers/${S}/settings`), reveal('[data-port-card]')) },
    {
      file: 'port-restart.png',
      run: steps(go(`/servers/${S}/settings`), reveal('[data-port-card]'), async (page) => {
        await page.fill('#st-port', '25600');
        await page.click('#st-port-save');
        await page.waitForSelector('.modal, [role="dialog"]', { state: 'visible' });
      }),
      after: async (page) => page.keyboard.press('Escape'),
    },
    { file: 'integrations-discord.png', run: go(`/servers/${S}/discord`) },

    // ---- Panel settings, users and permissions -------------------------------
    { file: 'settings-defaults.png', run: steps(go('/settings'), reveal('#sec-defaults')) },
    { file: 'settings-retention.png', run: steps(go('/settings'), reveal('#retention-card')) },
    {
      file: 'retention-preview.png',
      run: steps(go('/settings'), reveal('#retention-card'), async (page) => {
        const field = await page.$('#retention-card [data-retention-key]');
        await field.fill('1');
        await page.click('#retention-card [data-retention-save]');
        await page.waitForSelector('.modal, [role="dialog"]', { state: 'visible' });
      }),
      after: async (page) => page.keyboard.press('Escape'),
      settle: 900,
    },
    { file: 'settings-public-api.png', run: steps(go('/settings'), reveal('#api-tokens-card')) },
    { file: 'settings-users.png', run: go('/settings/permissions') },
    { file: 'settings-permissions.png', run: steps(go('/settings/permissions'), reveal('#permissions-table')) },
    {
      file: 'permissions-editor.png',
      run: steps(
        go('/settings/permissions'),
        reveal('#permissions-table'),
        click('[data-perm-cell]'),
        waitFor('.modal, [role="dialog"], [data-perm-editor]')
      ),
      after: async (page) => page.keyboard.press('Escape'),
    },
    {
      file: 'permissions-reference.png',
      run: steps(
        go('/settings/permissions'),
        click('#permissions-reference details summary'),
        reveal('#permissions-reference')
      ),
    },

    // ---- Mobile App ----------------------------------------------------------
    {
      file: 'mobile-app.png',
      fresh: true,
      run: mobileApp({ width: 1440, height: 900 }),
      settle: 900,
    },
    {
      file: 'mobile-app-phone.png',
      fresh: true,
      run: mobileApp({ width: 390, height: 844 }, '#app-push'),
      settle: 900,
    },

    // ---- Account -------------------------------------------------------------
    {
      file: '2fa-user-menu.png',
      run: steps(go('/'), click('[data-menu="user-menu"]'), waitFor('[data-open-2fa]')),
      after: async (page) => page.keyboard.press('Escape'),
    },
    {
      file: 'profile-picture.png',
      run: steps(
        go('/'),
        click('[data-menu="user-menu"]'),
        click('[data-open-avatar-picker]'),
        waitFor('.modal, [role="dialog"]')
      ),
      after: async (page) => page.keyboard.press('Escape'),
      settle: 900,
    },
    {
      file: '2fa-enroll.png',
      run: steps(go('/'), click('[data-menu="user-menu"]'), click('[data-open-2fa]'), waitFor('#tf-confirm-code')),
      settle: 900,
    },
    {
      file: '2fa-backup-codes.png',
      // Continues from the enrollment dialog above: confirm with a real code.
      run: async (page) => {
        const secret = await page.inputValue('#tf-secret');
        await page.fill('#tf-confirm-code', require('../../src/services/totp').codeAt(secret));
        await page.fill('#tf-confirm-password', demo.ADMIN.password);
        await page.click('.modal .btn-primary, [role="dialog"] .btn-primary');
        await page.waitForSelector('text=Copy All', { state: 'visible' });
      },
      after: async (page) => page.keyboard.press('Escape'),
      settle: 900,
    },
    {
      file: 'login.png',
      fresh: true,
      run: go('/login'),
    },
    {
      file: '2fa-login-challenge.png',
      fresh: true,
      run: async (page) => {
        await go('/login')(page);
        await page.fill('input[name="username"]', 'sam');
        await page.fill('input[name="password"]', 'demo-password-123');
        await page.click('button[type="submit"]');
        await page.waitForURL(/2fa/);
      },
    },
  ];
};
