// Entrypoint: wire up the DB, the mDNS engine, the background worker and the
// web server. Runs as a single process — discovery (triggered from the UI) and
// rebroadcast share one set of mDNS sockets, which avoids a second bind on
// :5353 and the IPC that a split web/worker process pair would otherwise need.

import { existsSync, readFileSync } from 'node:fs';
import { initDb } from './db.js';
import { MdnsManager } from './mdns.js';
import { Worker } from './worker.js';
import { createServer } from './server.js';

// When running as a Home Assistant add-on, the Supervisor writes user options to
// /data/options.json and gives us /data as persistent storage. Detect that and
// translate the options into the env vars the rest of the app already reads, so
// the core stays HA-agnostic.
function applyHomeAssistantOptions() {
  const optionsPath = '/data/options.json';
  if (!existsSync(optionsPath)) return;
  try {
    const opts = JSON.parse(readFileSync(optionsPath, 'utf8'));
    process.env.MDNS_DB_PATH = '/data/mdns.db'; // HA persistent storage
    if (opts.mdns_interface) process.env.MDNS_IFACE = opts.mdns_interface;
    if (opts.log_level === 'debug') process.env.DEBUG = '1';
    console.log('[ha] applied Home Assistant add-on options');
  } catch (err) {
    console.warn(`[ha] could not read ${optionsPath}: ${err.message}`);
  }
}
applyHomeAssistantOptions();

const PORT = Number(process.env.PORT || 3000);
const logger = makeLogger();

function makeLogger() {
  const debug = process.env.DEBUG === '1';
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    debug: debug ? (...a) => console.log(...a) : undefined,
  };
}

initDb();

const manager = new MdnsManager({ logger });
manager.start();

const worker = new Worker(manager, { logger });
worker.start();

const app = createServer(worker, { logger });
const server = app.listen(PORT, () => {
  logger.info(`[http] mDNS Rebroadcast UI on http://localhost:${PORT}`);
});

function shutdown(signal) {
  logger.info(`\n[shutdown] received ${signal}, cleaning up`);
  worker.stop();
  manager.destroy();
  server.close(() => process.exit(0));
  // Don't hang forever if a socket refuses to close.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
