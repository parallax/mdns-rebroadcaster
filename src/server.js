// HTTP server: JSON API for the UI plus static hosting of the web app.

import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listServices,
  setRebroadcast,
  deleteService,
  deleteAllServices,
  getAllSettings,
  setSetting,
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const EDITABLE_SETTINGS = new Set([
  'rebroadcast_enabled',
  'rebroadcast_interval_seconds',
  'rediscovery_interval_seconds',
]);

export function createServer(worker, { logger = console } = {}) {
  const app = express();
  app.use(express.json());

  app.get('/api/services', (req, res) => {
    res.json(listServices());
  });

  // Trigger a discovery browse. `wait=1` resolves once the browse completes and
  // returns the count; otherwise it kicks off in the background.
  app.post('/api/discover', async (req, res) => {
    if (req.query.wait === '1') {
      try {
        const count = await worker.runDiscovery();
        res.json({ ok: true, count });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    } else {
      worker.runDiscovery().catch((err) => logger.warn(`[api] discovery: ${err.message}`));
      res.json({ ok: true, started: true });
    }
  });

  app.post('/api/services/:id/rebroadcast', (req, res) => {
    const id = Number(req.params.id);
    const enabled = !!req.body?.enabled;
    if (!setRebroadcast(id, enabled)) {
      return res.status(404).json({ ok: false, error: 'service not found' });
    }
    worker.refreshActiveServices();
    res.json({ ok: true });
  });

  app.delete('/api/services', (req, res) => {
    const removed = deleteAllServices();
    worker.refreshActiveServices();
    res.json({ ok: true, removed });
  });

  app.delete('/api/services/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!deleteService(id)) {
      return res.status(404).json({ ok: false, error: 'service not found' });
    }
    worker.refreshActiveServices();
    res.json({ ok: true });
  });

  app.get('/api/settings', (req, res) => {
    res.json(getAllSettings());
  });

  app.put('/api/settings', (req, res) => {
    const updates = req.body || {};
    for (const [key, value] of Object.entries(updates)) {
      if (EDITABLE_SETTINGS.has(key)) setSetting(key, value);
    }
    res.json(getAllSettings());
  });

  app.use(express.static(PUBLIC_DIR));

  return app;
}
