'use strict';

// Post-boot net for faults nothing else caught. Installed only after a
// successful boot, so startup errors stay fatal and visible.
//
// An uncaught EXCEPTION leaves the process in an unknown state (a half-run
// db.transaction, a held op lock, a leaked stream), so the panel logs it,
// records it and exits; the supervisor (the shipped compose file's
// `restart: unless-stopped`, systemd) brings it back clean.
// OXYX_KEEP_ALIVE_ON_FATAL=1 opts out and keeps the old log-and-continue.
//
// An unhandled REJECTION is usually one forgotten `.catch` on a request that
// already failed, so it is logged and recorded and the panel stays up.
// OXYX_EXIT_ON_FATAL=1 makes those exit too.

const logger = require('./logger')('boot');
const { captureError } = require('./instrument');
const { serializeError } = require('./utils/logSanitize');

const truthy = (v) => /^(1|true|yes)$/i.test(v || '');

/**
 * @param {{ exit: (code: number) => void, env?: NodeJS.ProcessEnv }} opts
 */
function installRuntimeGuards({ exit, env = process.env }) {
  const keepAlive = truthy(env.OXYX_KEEP_ALIVE_ON_FATAL || env.MSM_KEEP_ALIVE_ON_FATAL);
  const exitOnRejection = truthy(env.OXYX_EXIT_ON_FATAL || env.MSM_EXIT_ON_FATAL);
  let exiting = false;

  const report = (kind, err, shouldExit) => {
    const info = serializeError(err);
    if (shouldExit)
      logger.fatal('Caught a fatal runtime fault, so the panel is exiting to restart clean.', { kind, err: info });
    else logger.error('Caught a fatal runtime fault and kept the panel alive.', { kind, err: info });
    captureError(err, { scope: 'runtime-guard', kind });
    try {
      require('./events').recordEvent({
        type: 'panel-error',
        actor: 'system',
        summary: `Uncaught ${kind}: ${info.errorMessage}.`.slice(0, 300),
        details: info,
      });
    } catch {
      /* the DB may be exactly what broke - never let reporting throw */
    }
    if (shouldExit && !exiting) {
      exiting = true;
      exit(1);
    }
  };

  process.on('uncaughtException', (err) => report('exception', err, !keepAlive));
  process.on('unhandledRejection', (reason) => report('rejection', reason, exitOnRejection));
}

module.exports = { installRuntimeGuards };
