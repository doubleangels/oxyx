'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'data/', 'data-*/', 'public/css/', 'docker-minecraft-server/', 'discovery/'] },
  js.configs.recommended,
  {
    // Node.js server code + build/QA scripts + tests (CommonJS).
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Errors, not warnings - problems fail the build honestly instead of being
      // promoted by a --max-warnings flag. `_`-prefixed and rest-sibling
      // (destructure-to-omit) vars are the standard "intentionally unused" opt-out;
      // `next` is Express's error-forwarding param that asyncHandler drives.
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_|^next$', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Off (not lazily): several input-sanitization regexes match control chars
      // on purpose; enabling this would force noise-only disable comments on each.
      'no-control-regex': 'off',
      'no-useless-escape': 'error',
    },
  },
  {
    // Shipped server code must go through src/logger.js - no stray console.* in
    // request/boot/background paths where it would bypass structured logging.
    files: ['src/**/*.js'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // These three run before the logger is usable: preflight runs before
    // anything (writes straight to stderr), instrument loads before config, and
    // config/index.js prints its first-run secret notice before the logger
    // exists. They are allowed console/stdout/stderr.
    files: ['src/preflight.js', 'src/instrument.js', 'src/config/index.js'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Browser client code (ES modules).
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Intentional: ANSI/control-char handling in console + MOTD rendering.
      'no-control-regex': 'off',
      // API calls go through public/js/lib/api.js (JSON, timeout, sign-in
      // redirect, friendly errors). See the grandfathered list below.
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            "Call the panel's API through api() from public/js/lib/api.js, which adds a timeout and friendly errors.",
        },
      ],
    },
  },
  {
    // Files that still call fetch() directly from before lib/api.js existed.
    // Migrate them page by page and remove each from this list; never add one.
    // Long uploads/downloads with progress may stay here on purpose.
    files: [
      'public/js/app.js',
      'public/js/lib/avatar.js',
      'public/js/lib/backupEdit.js',
      'public/js/lib/dockerSettings.js',
      'public/js/lib/itemBrowser.js',
      'public/js/lib/progress.js',
      'public/js/lib/retention.js',
      'public/js/lib/taskTray.js',
      'public/js/lib/twoFactor.js',
      'public/js/lib/undo.js',
      'public/js/lib/zipImport.js',
      'public/js/pages/activity.js',
      'public/js/pages/analytics.js',
      'public/js/pages/backups.js',
      'public/js/pages/blueprints.js',
      'public/js/pages/chat.js',
      'public/js/pages/commands.js',
      'public/js/pages/console.js',
      'public/js/pages/dashboard.js',
      'public/js/pages/files.js',
      'public/js/pages/health.js',
      'public/js/pages/history.js',
      'public/js/pages/integrations.js',
      'public/js/pages/inventory.js',
      'public/js/pages/investigation.js',
      'public/js/pages/modpacks.js',
      'public/js/pages/mods.js',
      'public/js/pages/permissions.js',
      'public/js/pages/player-detail.js',
      'public/js/pages/players.js',
      'public/js/pages/schedules.js',
      'public/js/pages/server-backups.js',
      'public/js/pages/server-settings.js',
      'public/js/pages/server-updates.js',
      'public/js/pages/settings.js',
      'public/js/pages/setup.js',
      'public/js/pages/storage.js',
      'public/js/pages/updates.js',
      'public/js/pages/wizard.js',
      'public/js/pages/world-controls.js',
      'public/js/pages/worlds-tab.js',
      'public/js/pages/worlds.js',
    ],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
];
