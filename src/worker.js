// Background timers driving rebroadcast and periodic re-discovery.
//
// Both loops self-reschedule with setTimeout and re-read their interval from
// settings each cycle, so changes made in the UI take effect on the next tick
// without a restart.

import {
  getNumberSetting,
  getSetting,
  getRebroadcastServicesWithRecords,
  upsertService,
} from './db.js';

export class Worker {
  constructor(manager, { logger = console } = {}) {
    this.manager = manager;
    this.log = logger;
    this._rebroadcastTimer = null;
    this._rediscoveryTimer = null;
    this._stopped = false;
    this._discovering = false;
  }

  start() {
    this._stopped = false;
    this.refreshActiveServices();
    this._scheduleRebroadcast(0);
    this._scheduleRediscovery(getNumberSetting('rediscovery_interval_seconds', 60) * 1000);
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._rebroadcastTimer);
    clearTimeout(this._rediscoveryTimer);
  }

  /** Reload the rebroadcast set from the DB into the mDNS manager. */
  refreshActiveServices() {
    this.manager.setActiveServices(getRebroadcastServicesWithRecords());
  }

  _scheduleRebroadcast(delayMs) {
    if (this._stopped) return;
    this._rebroadcastTimer = setTimeout(() => this._tickRebroadcast(), delayMs);
  }

  _tickRebroadcast() {
    if (this._stopped) return;
    try {
      if (getSetting('rebroadcast_enabled') === '1') {
        this.refreshActiveServices();
        const count = this.manager.announce();
        if (count > 0) this.log.debug?.(`[worker] announced ${count} service(s)`);
      }
    } catch (err) {
      this.log.warn(`[worker] rebroadcast tick failed: ${err.message}`);
    }
    const intervalMs = getNumberSetting('rebroadcast_interval_seconds', 5) * 1000;
    this._scheduleRebroadcast(Math.max(1000, intervalMs));
  }

  _scheduleRediscovery(delayMs) {
    if (this._stopped) return;
    this._rediscoveryTimer = setTimeout(() => this._tickRediscovery(), delayMs);
  }

  async _tickRediscovery() {
    if (this._stopped) return;
    try {
      await this.runDiscovery();
    } catch (err) {
      this.log.warn(`[worker] re-discovery failed: ${err.message}`);
    }
    const intervalMs = getNumberSetting('rediscovery_interval_seconds', 60) * 1000;
    this._scheduleRediscovery(Math.max(5000, intervalMs));
  }

  /**
   * Run one discovery browse and persist the results. Guarded so the manual
   * (button) and periodic triggers can't overlap.
   * @returns {Promise<number>} number of services seen this run
   */
  async runDiscovery(durationMs = 4000) {
    if (this._discovering) {
      this.log.info('[worker] discovery already running, skipping');
      return 0;
    }
    this._discovering = true;
    try {
      const services = await this.manager.discover(durationMs);
      const now = new Date().toISOString();
      for (const svc of services) {
        upsertService(svc, now);
      }
      this.log.info(`[worker] discovery found ${services.length} service(s)`);
      this.refreshActiveServices();
      return services.length;
    } finally {
      this._discovering = false;
    }
  }
}
