# mDNS Rebroadcast

Discover, cache, and selectively **rebroadcast** mDNS / DNS-SD services on a
single network segment. Built as a workaround for mesh routers (e.g. TP-Link
Deco) whose IGMP snooping drops link-local multicast and breaks mDNS discovery,
so AirPlay / Chromecast / HomeKit / printers appear and disappear or are only
visible from some clients.

The approach is deliberately blunt: discover services once (during a good
window), cache their full record sets, then **re-announce them frequently** so a
broadcast lands during whatever intermittent windows the snooping hardware is
actually forwarding multicast.

See [`BRIEF.md`](./BRIEF.md) for the full design rationale and trade-offs.

## What it does

- **Discover** — click a button (or let it run every 60s) to actively browse the
  network for advertised services and cache their full record sets (PTR / SRV /
  TXT / A / AAAA) in SQLite.
- **Select** — toggle which cached services to rebroadcast in the web UI.
- **Rebroadcast** — a background loop re-announces the selected services every
  5s (configurable) and answers live queries for them. IPv4 and IPv6 are handled
  together; a service's A and AAAA records are always announced as a unit.

## Requirements

- **Node.js ≥ 24** recommended (uses the built-in `node:sqlite` — no native build
  step). It works on 22.5–23.x too, but those versions need the
  `--experimental-sqlite` flag (`node --experimental-sqlite src/index.js`); 24+
  needs nothing.
- Must run **on the same L2 segment** as the devices and clients. This is not a
  cross-subnet reflector.
- Needs to send/receive multicast on UDP **5353** (`224.0.0.251` / `ff02::fb`).

## Run (bare metal)

```bash
npm install
npm start
# open http://localhost:3000
```

Then in the UI:

1. Hit **Discover services** — it scans for ~4s and lists what it found.
2. Flip the **Rebroadcast** toggle on the services you want re-announced.
3. (Optional) Adjust the intervals / pause rebroadcasting under **Settings** and
   click **Save**. Changes take effect on the next tick — no restart needed.

The app coexists with a host mDNS stack (macOS `mDNSResponder`, Linux `avahi`)
by binding 5353 with `SO_REUSEADDR`.

## Run (Docker)

Multicast does **not** traverse Docker's bridge network, so the container must
use host networking. The host's 5353 can be shared with an existing mDNS daemon.

### docker compose (recommended)

```bash
docker compose up -d --build
# open http://localhost:3000
```

The bundled [`docker-compose.yml`](./docker-compose.yml) already sets
`network_mode: host`, persists the cache to `./data`, and restarts on boot. To
enable IPv6 on a multi-interface host, uncomment `MDNS_IFACE` and set it to your
LAN interface (e.g. `eth0`).

### plain docker

```bash
docker build -t mdns-rebroadcast .
docker run -d --name mdns-rebroadcast \
  --network host \
  --restart unless-stopped \
  -v "$(pwd)/data:/app/data" \
  mdns-rebroadcast
```

> Host networking is a Linux feature. On Docker Desktop (macOS/Windows) the host
> network is the Linux VM, not your Mac/PC, so multicast won't reach your LAN —
> run it on a Linux host (which is the intended deployment anyway).

## Run (Home Assistant add-on)

This repo doubles as a local Home Assistant add-on (`config.yaml` + `DOCS.md` at
the root). It runs with **host networking** (required for multicast) and serves
its UI through **ingress** (a sidebar panel — no port to expose).

1. Copy this folder into your HA `/addons/` share (via the Samba or
   Studio Code Server / SSH add-on), e.g. `/addons/mdns-rebroadcast/`.
2. **Settings → Add-ons → Add-on Store → ⋮ → Check for updates**, then install
   **mDNS Rebroadcast** from *Local add-ons* and start it.
3. Open it from the sidebar.

Add-on options (Configuration tab): `mdns_interface` (LAN interface for IPv6,
blank = auto-detect) and `log_level`. The rebroadcast/re-discovery intervals are
set inside the app UI and persist in the add-on's `/data`. See [`DOCS.md`](./DOCS.md)
for details.

## Configuration

### Environment variables

| Var            | Default          | Purpose                                            |
| -------------- | ---------------- | -------------------------------------------------- |
| `PORT`         | `3000`           | Web UI / API port                                  |
| `MDNS_DB_PATH` | `./data/mdns.db` | SQLite file location                               |
| `MDNS_IFACE`   | auto-detected    | LAN interface for IPv6 multicast (e.g. `en0`/`eth0`) |
| `DEBUG`        | unset            | `DEBUG=1` logs each announce tick                  |

### Runtime settings (web UI, stored in SQLite)

| Setting                 | Default | Notes                                  |
| ----------------------- | ------- | -------------------------------------- |
| Rebroadcasting on/off   | on      | Master pause switch                    |
| Rebroadcast interval    | 5s      | How often selected services re-announce |
| Re-discovery interval   | 60s     | Background browse cadence to refresh the cache |

## HTTP API

The UI is a thin client over this JSON API:

| Method   | Path                              | Body                  | Purpose                          |
| -------- | --------------------------------- | --------------------- | -------------------------------- |
| `GET`    | `/api/services`                   | —                     | List cached services             |
| `POST`   | `/api/discover?wait=1`            | —                     | Run a discovery browse (`wait=1` blocks for the result) |
| `POST`   | `/api/services/:id/rebroadcast`   | `{ "enabled": true }` | Toggle rebroadcast for a service |
| `DELETE` | `/api/services/:id`               | —                     | Forget a cached service          |
| `GET`    | `/api/settings`                   | —                     | Read settings                    |
| `PUT`    | `/api/settings`                   | `{ "rebroadcast_interval_seconds": "5", ... }` | Update settings |

## How it works

- **One process** runs the web server, the discovery browse, and the rebroadcast
  worker. They share a single pair of mDNS sockets (IPv4 + IPv6), which avoids a
  second bind on :5353 and the IPC a split web/worker pair would need.
- Discovery is an **active browse**: a PTR query for `_services._dns-sd._udp.local`
  enumerates service types, then per-type and per-instance queries resolve the
  SRV / TXT / A / AAAA records, which are cached verbatim so they can be
  re-emitted faithfully.
- Rebroadcasting sends the cached records as **unsolicited authoritative
  announcements** and also replies to live queries for those names.

## Notes & caveats

- **Same-segment only.** Rebroadcasting makes services *discoverable*; the
  advertised host/port must already be reachable. There is no address rewriting.
- **Keep IPs stable.** Re-announcing a *stale* A/AAAA record (e.g. after a DHCP
  change) can conflict with the live device. Static IPs avoid this; the 60s
  re-discovery and TTL handling are the safety net otherwise.
- **`node:sqlite`** is used instead of the brief's suggested `better-sqlite3`, to
  avoid native compilation on very new Node versions.
- **IPv6** depends on the host exposing a usable link-local interface. If the
  IPv6 socket can't bind, the app logs a warning and continues IPv4-only.
- The `data/` directory (SQLite cache) is gitignored; delete it to start fresh.
