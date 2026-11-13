'use strict';

// Which host address a server container's INTERNAL ports (RCON, BlueMap) are
// published on. Docker publishes on 0.0.0.0 unless told otherwise, and its
// iptables rules bypass host firewalls such as ufw, so without a HostIp these
// ports were reachable from the LAN and often the internet. The panel never
// needs them from outside: RCON runs through `docker exec rcon-cli`, and the
// map proxy reaches BlueMap on the container network or through
// config.mapProxyHost. So publish them only where the panel itself connects.

const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');
const config = require('../config');
const logger = require('../logger')(path.basename(__filename));

const ALL_INTERFACES = new Set(['all', '*', '0.0.0.0', '::']);

/**
 * The HostIp for internal port bindings, or '' to publish on every interface.
 * @returns {Promise<string>}
 */
async function resolveInternalBindIp() {
  const raw = config.internalPortBind;
  if (ALL_INTERFACES.has(raw.toLowerCase())) return '';
  if (raw) return raw;
  const host = config.mapProxyHost;
  if (host === 'localhost') return '127.0.0.1';
  if (net.isIP(host)) return host;
  // Panel in a container: host.docker.internal maps to the host-gateway
  // address. Binding there keeps the port off the LAN while the panel (and
  // only containers on this host) can still reach it.
  try {
    const { address } = await dns.lookup(host, { family: 4 });
    return address;
  } catch (err) {
    logger.warn('Could not resolve the map proxy host, so internal ports are published on loopback only.', {
      host,
      code: err && err.code,
    });
    return '127.0.0.1';
  }
}

module.exports = { resolveInternalBindIp };
