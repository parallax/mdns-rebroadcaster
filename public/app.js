// Front-end logic: talks to the JSON API, renders the service list, and wires
// up discovery + settings controls.

const $ = (sel) => document.querySelector(sel);

const els = {
  discoverBtn: $('#discover-btn'),
  discoverLabel: $('#discover-btn .label'),
  discoverSpinner: $('#discover-btn .spinner'),
  body: $('#services-body'),
  count: $('#count'),
  status: $('#status'),
  rbEnabled: $('#rebroadcast-enabled'),
  rbState: $('#rebroadcast-state'),
  rbInterval: $('#rebroadcast-interval'),
  rdInterval: $('#rediscovery-interval'),
  saveBtn: $('#save-settings'),
  savedMsg: $('#settings-saved'),
};

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function showStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
  els.status.hidden = false;
}
function clearStatus() {
  els.status.hidden = true;
}

function relativeTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function renderServices(services) {
  els.count.textContent = services.length;
  if (services.length === 0) {
    els.body.innerHTML = `<tr class="empty"><td colspan="8">No services cached yet — hit <strong>Discover services</strong> to scan the network.</td></tr>`;
    return;
  }
  els.body.innerHTML = services
    .map((s) => {
      const hostPort = s.host
        ? `${escapeHtml(s.host)}${s.port != null ? ':' + s.port : ''}`
        : '<span class="muted">—</span>';
      return `
      <tr data-id="${s.id}">
        <td class="col-rb">
          <label class="switch">
            <input type="checkbox" class="rb-toggle" ${s.rebroadcast ? 'checked' : ''} />
            <span class="track"></span>
          </label>
        </td>
        <td><span class="type-badge">${escapeHtml(s.service_type)}</span></td>
        <td>${escapeHtml(instanceLabel(s.instance_name, s.service_type))}</td>
        <td class="mono">${hostPort}</td>
        <td class="addrs">${renderAddresses(s.ipv4, s.ipv6)}</td>
        <td class="col-rec muted">${s.record_count}</td>
        <td class="muted" title="${escapeHtml(s.last_seen)}">${relativeTime(s.last_seen)}</td>
        <td class="col-del"><button class="icon-btn del" title="Forget this service">✕</button></td>
      </tr>`;
    })
    .join('');
}

// Render the cached A / AAAA addresses (the IPs that get rebroadcast).
function renderAddresses(ipv4 = [], ipv6 = []) {
  const rows = [];
  for (const ip of ipv4) {
    rows.push(`<div class="addr"><span class="fam fam-4">IPv4</span><span class="mono">${escapeHtml(ip)}</span></div>`);
  }
  for (const ip of ipv6) {
    rows.push(`<div class="addr"><span class="fam fam-6">IPv6</span><span class="mono">${escapeHtml(ip)}</span></div>`);
  }
  return rows.length ? rows.join('') : '<span class="muted">—</span>';
}

// "Living Room._airplay._tcp.local" -> "Living Room"
function instanceLabel(instanceName, serviceType) {
  if (serviceType && instanceName.endsWith('.' + serviceType)) {
    return instanceName.slice(0, -(serviceType.length + 1));
  }
  return instanceName;
}

async function loadServices() {
  try {
    const services = await api('api/services');
    renderServices(services);
  } catch (err) {
    showStatus(`Failed to load services: ${err.message}`, true);
  }
}

async function loadSettings() {
  try {
    const s = await api('api/settings');
    els.rbEnabled.checked = s.rebroadcast_enabled === '1';
    els.rbInterval.value = s.rebroadcast_interval_seconds;
    els.rdInterval.value = s.rediscovery_interval_seconds;
    updateRbState();
  } catch (err) {
    showStatus(`Failed to load settings: ${err.message}`, true);
  }
}

function updateRbState() {
  els.rbState.textContent = els.rbEnabled.checked
    ? `re-announcing every ${els.rbInterval.value}s`
    : 'paused';
}

// --- Events -----------------------------------------------------------------

els.discoverBtn.addEventListener('click', async () => {
  els.discoverBtn.disabled = true;
  els.discoverSpinner.hidden = false;
  els.discoverLabel.textContent = 'Scanning…';
  showStatus('Scanning the network for mDNS services…');
  try {
    const { count } = await api('api/discover?wait=1', { method: 'POST' });
    showStatus(`Discovery complete — ${count} service${count === 1 ? '' : 's'} seen.`);
    await loadServices();
  } catch (err) {
    showStatus(`Discovery failed: ${err.message}`, true);
  } finally {
    els.discoverBtn.disabled = false;
    els.discoverSpinner.hidden = true;
    els.discoverLabel.textContent = 'Discover services';
  }
});

els.body.addEventListener('change', async (e) => {
  if (!e.target.classList.contains('rb-toggle')) return;
  const id = e.target.closest('tr').dataset.id;
  try {
    await api(`api/services/${id}/rebroadcast`, {
      method: 'POST',
      body: JSON.stringify({ enabled: e.target.checked }),
    });
  } catch (err) {
    showStatus(`Failed to update: ${err.message}`, true);
    e.target.checked = !e.target.checked;
  }
});

els.body.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('del')) return;
  const tr = e.target.closest('tr');
  const id = tr.dataset.id;
  try {
    await api(`api/services/${id}`, { method: 'DELETE' });
    tr.remove();
    els.count.textContent = els.body.querySelectorAll('tr[data-id]').length;
  } catch (err) {
    showStatus(`Failed to delete: ${err.message}`, true);
  }
});

els.rbEnabled.addEventListener('change', updateRbState);
els.rbInterval.addEventListener('input', updateRbState);

els.saveBtn.addEventListener('click', async () => {
  try {
    await api('api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        rebroadcast_enabled: els.rbEnabled.checked ? '1' : '0',
        rebroadcast_interval_seconds: String(Math.max(1, Number(els.rbInterval.value) || 5)),
        rediscovery_interval_seconds: String(Math.max(5, Number(els.rdInterval.value) || 60)),
      }),
    });
    updateRbState();
    els.savedMsg.hidden = false;
    setTimeout(() => (els.savedMsg.hidden = true), 1800);
  } catch (err) {
    showStatus(`Failed to save settings: ${err.message}`, true);
  }
});

// --- Init -------------------------------------------------------------------

loadSettings();
loadServices();
// Keep the list fresh (last-seen times, periodic re-discovery results).
setInterval(loadServices, 10000);
