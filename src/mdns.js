// mDNS engine: dual-stack (IPv4 + IPv6) discovery, periodic rebroadcast, and
// live query responses for the services we're rebroadcasting.
//
// We talk to `multicast-dns` at the raw-record level (rather than a high-level
// browse/publish wrapper) because faithful rebroadcasting requires us to cache
// and re-emit the exact PTR/SRV/TXT/A/AAAA records we observed.

import os from 'node:os';
import multicastDns from 'multicast-dns';
import {
  serializeRecord,
  deserializeRecord,
} from './records.js';

// DNS-SD meta-query: a PTR query for this name enumerates the service *types*
// advertised on the link.
const META_QUERY = '_services._dns-sd._udp.local';

export class MdnsManager {
  constructor({ logger = console } = {}) {
    this.log = logger;
    this.sockets = []; // [{ family, mdns }]
    this.activeServices = []; // services currently being rebroadcast (indexed)
    this._collector = null; // non-null while a discovery browse is in progress
  }

  start() {
    this._createSocket('IPv4', { type: 'udp4', ip: '224.0.0.251' });
    // IPv6 link-local multicast (ff02::fb) is link-scoped, so it needs an
    // explicit interface address-with-scope. Auto-detect the primary LAN
    // interface (overridable via MDNS_IFACE). Failure here is non-fatal — we
    // log and continue IPv4-only.
    try {
      const iface = pickIpv6Interface(process.env.MDNS_IFACE);
      if (!iface) {
        this.log.warn('[mdns] no usable IPv6 interface found, continuing IPv4-only');
      } else {
        // Bind the wildcard `::` (not the specific interface address) so we can
        // share :5353 with a host mDNS stack via SO_REUSEADDR; `interface` is
        // still used for group membership and outbound multicast.
        this._createSocket('IPv6', { type: 'udp6', ip: 'ff02::fb', interface: iface, bind: '::' });
        this.log.info(`[mdns] IPv6 bound to interface ${iface}`);
      }
    } catch (err) {
      this.log.warn(`[mdns] IPv6 socket unavailable, continuing IPv4-only: ${err.message}`);
    }
  }

  _createSocket(family, opts) {
    const mdns = multicastDns({
      port: 5353,
      reuseAddr: true, // coexist with a host mDNSResponder/Avahi already on 5353
      loopback: true,
      ...opts,
    });
    mdns.on('error', (err) => this.log.warn(`[mdns:${family}] socket error: ${err.message}`));
    mdns.on('warning', (err) => this.log.warn(`[mdns:${family}] ${err.message}`));
    mdns.on('response', (response) => this._onResponse(response));
    mdns.on('query', (query) => this._onQuery(query));
    this.sockets.push({ family, mdns });
    this.log.info(`[mdns] ${family} socket listening on :5353`);
  }

  _eachSocket(fn) {
    for (const s of this.sockets) {
      try {
        fn(s.mdns);
      } catch (err) {
        this.log.warn(`[mdns:${s.family}] ${err.message}`);
      }
    }
  }

  // --- Discovery ------------------------------------------------------------

  /**
   * Run an active browse for `durationMs`, collecting every record advertised,
   * then return them grouped into services ready for {@link upsertService}.
   */
  async discover(durationMs = 4000) {
    if (this._collector) {
      throw new Error('discovery already in progress');
    }
    const collector = {
      records: new Map(), // dedupe key -> raw record
      queriedTypes: new Set(),
      queriedInstances: new Set(),
      queriedHosts: new Set(),
    };
    this._collector = collector;

    // Kick off the enumeration: ask for the list of service types.
    this._query([{ name: META_QUERY, type: 'PTR' }]);

    await new Promise((resolve) => setTimeout(resolve, durationMs));
    this._collector = null;

    return this._groupIntoServices([...collector.records.values()]);
  }

  _query(questions) {
    this._eachSocket((mdns) => mdns.query({ questions }));
  }

  _onResponse(response) {
    const collector = this._collector;
    if (!collector) return; // only collect while a browse is active

    const all = [...(response.answers || []), ...(response.additionals || [])];
    for (const rec of all) {
      if (!rec || !rec.name) continue;
      const key = `${rec.type}|${rec.name}|${JSON.stringify(serializeRecord(rec).data)}`;
      collector.records.set(key, rec);

      // Drive the next round of queries off what we just learned.
      if (rec.type === 'PTR' && rec.name === META_QUERY) {
        const type = rec.data;
        if (!collector.queriedTypes.has(type)) {
          collector.queriedTypes.add(type);
          this._query([{ name: type, type: 'PTR' }]);
        }
      } else if (rec.type === 'PTR') {
        const instance = rec.data;
        if (!collector.queriedInstances.has(instance)) {
          collector.queriedInstances.add(instance);
          this._query([
            { name: instance, type: 'SRV' },
            { name: instance, type: 'TXT' },
          ]);
        }
      } else if (rec.type === 'SRV') {
        const host = rec.data?.target;
        if (host && !collector.queriedHosts.has(host)) {
          collector.queriedHosts.add(host);
          this._query([
            { name: host, type: 'A' },
            { name: host, type: 'AAAA' },
          ]);
        }
      }
    }
  }

  /** Group a flat record list into one entry per service instance. */
  _groupIntoServices(records) {
    const byName = (type) => records.filter((r) => r.type === type);

    // Map each instance name to the service type that points at it.
    const typeForInstance = new Map();
    for (const ptr of byName('PTR')) {
      if (ptr.name === META_QUERY) continue;
      typeForInstance.set(ptr.data, ptr.name);
    }

    const services = [];
    for (const srv of byName('SRV')) {
      const instanceName = srv.name;
      const serviceType = typeForInstance.get(instanceName) || deriveServiceType(instanceName);
      const host = srv.data?.target;
      const port = srv.data?.port;

      const recs = [];
      recs.push({ name: serviceType, type: 'PTR', ttl: 4500, data: instanceName });
      recs.push(srv);
      const txt = records.find((r) => r.type === 'TXT' && r.name === instanceName);
      if (txt) recs.push(txt);
      for (const addr of records) {
        if ((addr.type === 'A' || addr.type === 'AAAA') && addr.name === host) recs.push(addr);
      }

      services.push({
        instanceName,
        serviceType,
        host: host || null,
        port: port ?? null,
        records: recs.map(serializeRecord),
      });
    }
    return services;
  }

  // --- Rebroadcast ----------------------------------------------------------

  /**
   * Set the services to rebroadcast. `rawList` is the DB shape from
   * `getRebroadcastServicesWithRecords()`; we deserialise and index it here so
   * both the announce loop and the query responder share one representation.
   */
  setActiveServices(rawList) {
    this.activeServices = rawList
      .map((svc) => {
        const records = svc.records.map(deserializeRecord);
        const ptr = records.find((r) => r.type === 'PTR');
        const srv = records.find((r) => r.type === 'SRV');
        const txt = records.find((r) => r.type === 'TXT');
        const addresses = records.filter((r) => r.type === 'A' || r.type === 'AAAA');
        if (!ptr || !srv) return null; // not enough to advertise meaningfully
        return {
          instanceName: svc.instanceName,
          serviceType: ptr.name,
          host: srv.data?.target,
          ptr,
          srv,
          txt,
          addresses,
        };
      })
      .filter(Boolean);
  }

  /** All answers (with A *and* AAAA bundled together) for one service. */
  _answersFor(svc) {
    const answers = [
      { name: META_QUERY, type: 'PTR', ttl: 4500, data: svc.serviceType },
      svc.ptr,
      svc.srv,
    ];
    if (svc.txt) answers.push(svc.txt);
    // A and AAAA are emitted together so a client never gets a fresh IPv4
    // answer paired with a stale or missing IPv6 one.
    answers.push(...svc.addresses);
    return answers;
  }

  /** Send unsolicited announcements for every active service. */
  announce() {
    for (const svc of this.activeServices) {
      const answers = this._answersFor(svc);
      this._eachSocket((mdns) => mdns.respond({ answers }));
    }
    return this.activeServices.length;
  }

  // --- Live query responses -------------------------------------------------

  _onQuery(query) {
    if (this.activeServices.length === 0) return;
    const questions = query.questions || [];
    const answers = [];

    for (const q of questions) {
      const wantType = q.type;
      const matches = (t) => wantType === 'ANY' || wantType === t;

      for (const svc of this.activeServices) {
        // Type enumeration.
        if (q.name === META_QUERY && matches('PTR')) {
          pushUnique(answers, { name: META_QUERY, type: 'PTR', ttl: 4500, data: svc.serviceType });
        }
        // Browse for instances of a type.
        if (q.name === svc.serviceType && matches('PTR')) {
          pushUnique(answers, svc.ptr, svc.srv, svc.txt, ...svc.addresses);
        }
        // Resolve a specific instance.
        if (q.name === svc.instanceName && (matches('SRV') || matches('TXT'))) {
          pushUnique(answers, svc.srv, svc.txt, ...svc.addresses);
        }
        // Resolve a host's addresses.
        if (svc.host && q.name === svc.host && (matches('A') || matches('AAAA'))) {
          pushUnique(answers, ...svc.addresses);
        }
      }
    }

    if (answers.length > 0) {
      this._eachSocket((mdns) => mdns.respond({ answers }));
    }
  }

  destroy() {
    this._eachSocket((mdns) => mdns.destroy());
    this.sockets = [];
  }
}

/**
 * Pick the IPv6 link-local interface address (with %scope suffix) for the
 * primary LAN interface. Skips internal, Apple Wireless Direct (awdl/llw) and
 * tunnel (utun) interfaces, which aren't the real LAN. `preferName` (e.g. from
 * MDNS_IFACE) wins if it has a usable address.
 */
function pickIpv6Interface(preferName) {
  const nets = os.networkInterfaces();
  const skip = /^(awdl|llw|utun|bridge|vmnet|gif|stf|ap\d)/;

  const linkLocalFor = (name) => {
    const net = nets[name];
    if (!net) return null;
    const ll = net.find(
      (i) => i.family === 'IPv6' && !i.internal && i.address.startsWith('fe80'),
    );
    return ll ? `${ll.address}%${name}` : null;
  };

  if (preferName) {
    const found = linkLocalFor(preferName);
    if (found) return found;
  }

  const candidates = Object.keys(nets)
    .filter((name) => !skip.test(name))
    // Prefer the conventional primary interface on macOS.
    .sort((a, b) => (a === 'en0' ? -1 : b === 'en0' ? 1 : 0));

  for (const name of candidates) {
    const found = linkLocalFor(name);
    if (found) return found;
  }
  return null;
}

function deriveServiceType(instanceName) {
  // "Name._http._tcp.local" -> "_http._tcp.local" (best-effort fallback).
  const idx = instanceName.indexOf('._');
  return idx >= 0 ? instanceName.slice(idx + 1) : instanceName;
}

function pushUnique(arr, ...records) {
  for (const rec of records) {
    if (!rec) continue;
    const key = (r) => `${r.type}|${r.name}|${JSON.stringify(r.data)}`;
    const k = key(rec);
    if (!arr.some((a) => key(a) === k)) arr.push(rec);
  }
}
