# mDNS Rebroadcast — Home Assistant add-on

Discover, cache and selectively rebroadcast mDNS/DNS-SD services on your LAN.
Useful when a mesh router (e.g. TP-Link Deco) breaks mDNS discovery via IGMP
snooping, so AirPlay / Chromecast / HomeKit / printers come and go.

## Installation (local add-on)

1. Copy this folder into your Home Assistant `/addons/` share (via the **Samba**
   or **Studio Code Server / SSH** add-on). It should end up as e.g.
   `/addons/mdns-rebroadcast/` containing `config.yaml` and `Dockerfile`.
2. Go to **Settings → Add-ons → Add-on Store**, open the **⋮** menu →
   **Check for updates**, then find **mDNS Rebroadcast** under *Local add-ons*.
3. Click **Install** (it builds the image — this takes a few minutes the first
   time), then **Start**.
4. Open the UI from the sidebar (**mDNS Rebroadcast**) or the add-on's
   **Open Web UI** button.

## Usage

1. Click **Discover services** — it scans for ~4 seconds and lists what it found.
2. Flip the **Rebroadcast** toggle on the services you want re-announced.
3. Adjust the rebroadcast/re-discovery intervals or pause rebroadcasting under
   **Settings** in the UI. These are stored in the add-on's persistent `/data`,
   so they survive restarts and updates.

## Configuration options

| Option           | Default | Description                                                                 |
| ---------------- | ------- | --------------------------------------------------------------------------- |
| `mdns_interface` | (blank) | LAN interface for **IPv6** multicast, e.g. `eth0`. Blank = auto-detect. IPv4 works regardless. |
| `log_level`      | `info`  | Set to `debug` to log every rebroadcast tick.                               |

> The rebroadcast interval (default 5s) and re-discovery interval (default 60s)
> are configured **inside the app's UI**, not here — they're operational toggles
> with live effect and are persisted in the add-on database.

## Notes

- **Network:** the add-on uses host networking (required for multicast). The UI
  is therefore also reachable directly at `http://<home-assistant-host>:3000`
  with no authentication — fine on a trusted LAN, which is the intended use.
- **Same segment only:** this makes services *discoverable*; it does not route
  traffic across subnets/VLANs and does no address rewriting.
- **Keep device IPs stable** (DHCP reservations or static) so re-announced
  records don't go stale.
