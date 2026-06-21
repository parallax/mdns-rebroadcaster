# mDNS Rebroadcast — Project Brief

## Summary

A self-hosted utility that **discovers**, **caches**, and **selectively rebroadcasts**
mDNS / DNS-SD service advertisements. The primary use case is **keeping mDNS
services discoverable on a single network segment whose switching/AP hardware
drops or prunes multicast traffic** — specifically TP-Link Deco mesh routers,
whose IGMP snooping interferes with mDNS so that announcements don't reliably
reach all clients.

The strategy is deliberately blunt: discover the services once (during a good
window), cache their full record sets, and then **re-announce them frequently**
("spam" the segment) so that a rebroadcast lands during whatever intermittent
windows the snooping hardware is actually forwarding multicast.

This is a same-segment tool. It is **not** a cross-subnet reflector and does no
address rewriting — the rebroadcaster, the real devices, and the consuming
clients all live on the same L2 broadcast domain.

The system has two parts:

1. **Web app** — a UI for discovering services on the local network and choosing
   which ones to rebroadcast.
2. **Worker** — a background process that periodically re-announces the selected
   services to the network.

A local SQLite database is the shared source of truth between the two.

---

## Background: mDNS / DNS-SD

mDNS (Multicast DNS, RFC 6762) lets devices resolve names and discover services
on a local link without a central DNS server. DNS-SD (RFC 6763) layers service
discovery on top. Traffic flows over multicast group **224.0.0.251** (IPv4) /
**ff02::fb** (IPv6) on **UDP port 5353**.

A single discoverable service is described by a set of DNS records:

- **PTR** — maps a service type (e.g. `_http._tcp.local`) to a service instance
  name (e.g. `My Printer._http._tcp.local`).
- **SRV** — gives the target host, port, priority, and weight for an instance.
- **TXT** — arbitrary key/value metadata for the instance.
- **A / AAAA** — resolves the target host to an IP address.

To **rebroadcast** a service we must cache and re-emit this full record set, not
just a single field.

---

## Why this is needed: IGMP snooping vs. mDNS

mDNS uses the **link-local** multicast group `224.0.0.251`, which sits inside the
`224.0.0.0/24` reserved range. By spec, switches are **not** supposed to apply
IGMP snooping to this range — link-local multicast should always be flooded to
every port. Many consumer mesh systems, **Deco included, get this wrong**: their
IGMP snooping prunes `224.0.0.251` to ports that haven't recently issued an IGMP
membership report, so mDNS announcements and queries get dropped intermittently.
The usual symptoms are AirPlay/Chromecast/printers/HomeKit devices that appear
and disappear or are only visible from some clients.

The clean fix is to disable IGMP snooping, but the Deco app typically doesn't
expose that toggle — hence this workaround.

**How rebroadcasting helps (and its limits):**

- The forwarding state for a multicast group on a snooping switch is *timed out*,
  not permanently off. By re-announcing every few seconds and by issuing our own
  queries, we (a) keep refreshing the group membership for our segment and (b)
  maximise the chance that *some* of our frequent re-announcements land while the
  switch happens to be forwarding the group to a given client.
- This is probabilistic mitigation, not a guarantee. If the Deco is *hard*
  dropping `224.0.0.251` to a port, no amount of multicast spam from another
  port will reach it. In practice the behaviour is intermittent forwarding, which
  is exactly what frequent rebroadcasting papers over.
- Because we're on the same segment, our own ability to *receive* the original
  announcements is subject to the same pruning. Discovery should therefore be
  re-runnable and ideally run periodically (see below), so the cache is built
  from whatever windows happen to be open.

---

## Goals

- Discover services currently advertised on the local network, on demand.
- Persist discovered services so the list survives restarts.
- Let the user select a subset of cached services to rebroadcast.
- Rebroadcast selected services on a configurable interval (default **5s**).
- **Handle IPv4 and IPv6 equally** — discover and rebroadcast over both
  `224.0.0.251` and `ff02::fb`, caching A *and* AAAA records. Many of the worst
  Deco mDNS offenders (Apple/HomeKit/AirPlay) are IPv6-heavy, so IPv6 is in scope
  from the start, not a follow-up.
- Run as a long-lived, low-footprint daemon suitable for a homelab / appliance.

## Non-goals (initial version)

- Routing/reflecting *all* mDNS traffic transparently (that's what tools like
  `avahi-daemon` reflector mode or `mdns-repeater` do — this is the curated,
  opt-in alternative).
- Cross-subnet / cross-VLAN reflection and any address rewriting. Everything is
  on one L2 segment; advertised hosts are already reachable.
- Authentication / multi-tenant access control on the web UI.

---

## Architecture

```
                ┌─────────────────────────────────────────┐
                │              Web App (HTTP)               │
                │  - Discover button → triggers a browse    │
                │  - Live list of discovered services       │
                │  - Toggle "rebroadcast" per service        │
                │  - Settings (interval, etc.)               │
                └──────────────┬────────────────────────────┘
                               │ reads / writes
                               ▼
                ┌─────────────────────────────────────────┐
                │           SQLite (local file)             │
                │  services, records, settings              │
                └──────────────┬────────────────────────────┘
                               │ reads
                               ▼
                ┌─────────────────────────────────────────┐
                │               Worker                      │
                │  - Loop every N seconds                    │
                │  - For each service flagged rebroadcast,   │
                │    emit its cached PTR/SRV/TXT/A records    │
                │  - Respond to queries for those names      │
                └─────────────────────────────────────────┘
                               │
                               ▼
                       UDP 5353 multicast
```

### Discovery (web app)

The "Discover" button kicks off an active **browse**: send a PTR query for
`_services._dns-sd._udp.local` (the meta-query that enumerates advertised
service *types*), then a PTR query for each discovered type to enumerate
instances, then resolve each instance's SRV/TXT/A records.

We do **active querying** rather than purely passive listening because:
- Passive listening only catches services during their (infrequent) announcement
  windows, so the list fills in slowly and unpredictably.
- An active browse populates the list within a second or two of pressing the
  button.

We can *also* keep a passive listener running to opportunistically catch
announcements between browses, but active query is the primary mechanism.

Each discovered service and its records are upserted into SQLite. Re-running
discovery refreshes existing entries rather than duplicating them.

### Rebroadcasting (worker)

The worker reads the set of services flagged `rebroadcast = true` and, on each
tick, multicasts their cached resource records as **unsolicited announcements**
(authoritative responses). It should also **listen for queries** matching those
service names and reply directly, since well-behaved clients query rather than
wait for announcements.

Interval is read from the settings table and is configurable; default **5s**.
A 5s interval is far more aggressive than normal mDNS (which backs off to ~once
an hour) — that aggression is the whole point here, to punch through intermittent
multicast forwarding. Keep it tunable so it can be dialled up or relaxed.

**A and AAAA are announced as a unit.** Each rebroadcast tick emits a service's
full record set together — PTR, SRV, TXT, and *both* its A and AAAA records in the
same announcement — so a client never receives a fresh IPv4 answer paired with a
stale (or missing) IPv6 one. The two address families are treated as one logical
service, not scheduled independently.

**Freshness — lower risk here given static IPs.** Because the real device is still
on the segment, re-announcing records that are *identical* to the live device's is
harmless: it's not a conflict, it just reinforces them. Re-announcing **stale**
records (changed IP or port) would create a genuine mDNS conflict and could poison
client caches. In this deployment device IPs are **statically assigned**, so the
A/AAAA staleness risk is largely designed out — but we still keep cheap guards:

- Honour record TTLs.
- Re-run discovery in the background every **60 seconds** (not just on the button
  press) to refresh the cache and update `last_seen`.
- Surface services not seen in recent discovery runs as "stale" in the UI.

---

## Data model (SQLite)

```sql
-- A discovered service instance.
CREATE TABLE services (
  id            INTEGER PRIMARY KEY,
  instance_name TEXT NOT NULL,      -- "My Printer._http._tcp.local"
  service_type  TEXT NOT NULL,      -- "_http._tcp.local"
  host          TEXT,               -- "printer.local"
  port          INTEGER,
  rebroadcast   INTEGER NOT NULL DEFAULT 0,  -- boolean: included in rebroadcast
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  UNIQUE(instance_name)
);

-- Raw resource records backing each service, so we can re-emit faithfully.
CREATE TABLE records (
  id          INTEGER PRIMARY KEY,
  service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,        -- "PTR" | "SRV" | "TXT" | "A" | "AAAA"
  name        TEXT NOT NULL,
  ttl         INTEGER NOT NULL,
  data        TEXT NOT NULL,        -- JSON-encoded rdata
  UNIQUE(service_id, type, name, data)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- e.g. ('rebroadcast_interval_seconds', '5'),
--      ('rediscovery_interval_seconds', '60')
```

---

## Web UI

Minimal, single-page:

- **Discover** button — triggers a browse; shows a spinner / live count while
  results stream in.
- **Service list** — table of cached services: instance name, type, host:port,
  last seen, and a **rebroadcast** toggle per row.
- **Settings** — rebroadcast interval (seconds), and a master enable/disable for
  rebroadcasting.
- Optional: a "stale" indicator for services not seen in the last discovery run.

---

## Suggested stack

Recommendation — **Node.js**, because the mDNS ecosystem there is mature and the
web-app-plus-worker split is idiomatic:

- **mDNS:** [`multicast-dns`](https://github.com/mafintosh/multicast-dns) for
  low-level query/response control (needed for faithful rebroadcasting), or
  [`bonjour-service`](https://github.com/onlxltd/bonjour-service) for a
  higher-level browse/publish API.
- **Web:** Fastify or Express + a small frontend (plain HTML/HTMX is plenty;
  no SPA framework required).
- **DB:** [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)
  (synchronous, fast, simple).
- **Worker:** a separate process (own entrypoint) sharing the SQLite file, or a
  `worker_thread`. Separate process is cleaner for independent restart and for
  the privileged socket binding.

> Alternatives worth a look if Node isn't preferred: **Go** (`hashicorp/mdns`,
> `grandcat/zeroconf`, single static binary — great for an appliance) or
> **Python** (`zeroconf`).

---

## Operational notes / gotchas

- **Dual-stack sockets:** the worker must bind UDP 5353 and join **both** the
  IPv4 group `224.0.0.251` and the IPv6 group `ff02::fb`. In practice this means
  separate IPv4 and IPv6 sockets (a single dual-stack socket handles multicast
  membership awkwardly across OSes). IPv6 link-local multicast also requires
  picking the right outgoing **interface/scope id** to join and send on — this is
  the fiddliest part of IPv6 support and worth verifying early.
- **Port 5353 binding:** on a host already running Avahi/Bonjour, the port may be
  in use — binding with `SO_REUSEPORT`/`SO_REUSEADDR` is typically required, and
  behaviour differs by OS. Applies to both the v4 and v6 sockets.
- **Privileges & network mode:** multicast send/receive generally needs to be on
  the host network. If containerised, run with `--network host` (Docker bridge
  networking will not pass multicast as-is).
- **Conflicts from stale data (the big one):** since the real device shares the
  segment, re-announcing *identical* records is fine (RFC 6762 only treats
  differing rdata as a conflict), but re-announcing *stale* records will conflict
  with the live device and can poison client caches. See the freshness measures
  in "Rebroadcasting" above.
- **Cache-flush bit:** be careful with the cache-flush bit on rebroadcasts. We
  are *not* the authoritative owner; aggressively flushing could stomp the real
  device's records. Prefer plain shared-record announcements unless there's a
  clear reason otherwise.
- **TTL:** honour record TTLs so genuinely-departed services age out instead of
  being kept alive forever by our rebroadcasts.

---

## Settled decisions

- **IPv4 + IPv6 both**, with each service's A and AAAA announced together as a unit.
- **Rebroadcast interval:** 5s default, configurable.
- **Re-discovery interval:** 60s background browse, configurable.
- **Deployment:** bare metal first; Docker later (must use `--network host` —
  multicast won't traverse bridge networking — with host 5353 free of
  Avahi/Bonjour).
- **Staleness:** device IPs are statically assigned, so A/AAAA stale-record
  conflicts are largely designed out; TTL + 60s re-discovery are the only guards
  needed.
- **No authentication** on the UI (trusted LAN).

## Open questions

- None blocking. The only judgement call left for implementation is whether to
  ever re-confirm A/AAAA live before a tick rather than trusting the cache — with
  static IPs this is almost certainly unnecessary.

---

## Milestones

1. **Discovery + cache** — browse on demand, persist to SQLite, render the list.
2. **Selection** — per-service rebroadcast toggle, settings table.
3. **Worker rebroadcast** — periodic re-announcement of selected services.
4. **Query responses** — reply to live queries for rebroadcast names.
5. **Freshness** — periodic background re-discovery, TTL handling, stale-record
   detection so we never spam outdated A records.
6. **Polish** — interval tuning UI, packaging (Docker w/ host networking).
