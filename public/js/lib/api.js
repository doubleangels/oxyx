// One way to call the panel's JSON API from the browser. Use it for every new
// call instead of a bare fetch(): it sends and parses JSON, gives up after a
// timeout (a stalled request otherwise leaves a busy spinner forever), sends an
// expired session back to sign-in once instead of toasting on every call, and
// always throws an Error whose message is safe to show (the server's own
// `error` text, else a friendlyError fallback).
//
//   import { api } from '../lib/api.js';
//   try {
//     const data = await api(`/api/servers/${id}/map/enable`, { method: 'POST', action: 'enable the live map' });
//   } catch (err) {
//     toast(err.message, { kind: 'error' });
//   }
//
// Long uploads and downloads (progress events, streamed bodies) keep their own
// XHR/fetch code. Those files are listed in eslint.config.js.

import { friendlyError } from './errors.js';

export const DEFAULT_TIMEOUT_MS = 30000;

let redirecting = false;

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, timeoutMs?: number, action?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<any>} the parsed JSON body of a 2xx response
 */
export async function api(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, action, signal } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    // eslint-disable-next-line no-restricted-globals -- the one sanctioned fetch
    res = await fetch(path, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal && signal.aborted) throw err; // the caller cancelled: let them see AbortError
    throw Object.assign(new Error(friendlyError(err, { action })), { cause: err, status: 0 });
  }
  if (res.status === 401 && !redirecting) {
    redirecting = true;
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw Object.assign(new Error(data.error || friendlyError(res, { action })), {
      code: data.code,
      status: res.status,
      data,
    });
  }
  return data;
}
