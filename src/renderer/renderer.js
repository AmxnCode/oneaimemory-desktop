/* global window, document, navigator */
const api = window.onecon;
const $ = (id) => document.getElementById(id);

let state = null;
let activeType = '';
/** Guards against the Touch ID auto-prompt re-firing on every re-render. */
let touchIdInFlight = false;

// --- helpers ---------------------------------------------------------------

function icon(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

const EVENT_ICON = {
  browsing: 'globe',
  search: 'search',
  youtube: 'play',
  app: 'window',
  code: 'code',
  file: 'file',
};

function fmtAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtClock(iso) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function cleanIpcError(err) {
  return String(err?.message ?? err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

function emptyState(title, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.appendChild(icon('inbox'));
  const p = document.createElement('p');
  p.textContent = title;
  wrap.appendChild(p);
  if (hint) {
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = hint;
    wrap.appendChild(sub);
  }
  return wrap;
}

/** One event row: icon, title, mono metadata, time, hover-revealed delete. */
function eventRow({ kind, title, meta, time, onDelete, pending }) {
  const row = document.createElement('div');
  row.className = 'event';

  const ic = document.createElement('div');
  ic.className = 'event-icon';
  ic.title = kind;
  ic.appendChild(icon(EVENT_ICON[kind] ?? 'inbox'));

  const body = document.createElement('div');
  body.className = 'event-body';
  const t = document.createElement('div');
  t.className = 'event-title';
  t.textContent = title ?? '';
  t.title = title ?? '';
  if (pending) {
    const b = document.createElement('span');
    b.className = 'badge warn';
    b.classList.add('badge-inline');
    b.textContent = 'not synced';
    t.appendChild(b);
  }
  body.appendChild(t);
  if (meta) {
    const m = document.createElement('div');
    m.className = 'event-meta';
    m.textContent = meta;
    m.title = meta;
    body.appendChild(m);
  }

  const when = document.createElement('div');
  when.className = 'event-time';
  when.textContent = time;

  row.append(ic, body, when);

  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'event-del';
    del.title = 'Delete this event';
    del.appendChild(icon('trash'));
    del.addEventListener('click', onDelete);
    row.appendChild(del);
  } else {
    row.appendChild(document.createElement('span'));
  }
  return row;
}

// --- navigation ------------------------------------------------------------

document.querySelectorAll('.nav-item[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('[data-panel]').forEach((p) => {
      p.classList.toggle('hidden', p.dataset.panel !== btn.dataset.tab);
    });
    if (btn.dataset.tab === 'activity') void loadActivity();
    if (btn.dataset.tab === 'audit') void loadAudit();
    if (btn.dataset.tab === 'ai') {
      void loadIntegrations();
      void loadMcpStatus();
      void loadRemoteAccessStatus();
    }
    if (btn.dataset.tab === 'status') void loadServerStatus();
    if (btn.dataset.tab === 'memory' && state?.settings?.collectAiSessions) void loadMemoryGraph();
  });
});

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeType = btn.dataset.type;
    document.querySelectorAll('.filter').forEach((b) => b.classList.toggle('on', b === btn));
    void loadActivity();
  });
});

// --- render ----------------------------------------------------------------

function render(next) {
  state = next;
  const locked = Boolean(state.locked);

  $('auth').classList.toggle('hidden', state.signedIn || locked);
  $('locked').classList.toggle('hidden', !locked);
  $('main').classList.toggle('hidden', !state.signedIn);

  if (locked) {
    $('lockedWho').textContent = `${state.email} · unlock to resume collecting`;
    $('btnTouchId').classList.toggle('hidden', !state.biometric?.available);
    if (state.biometric?.available) setTimeout(() => void tryTouchId(), 250);
    return;
  }
  if (!state.signedIn) return;

  $('accountEmail').textContent = state.email;
  $('accountEmail').title = state.email;
  $('avatar').textContent = (state.email || '?').slice(0, 1).toUpperCase();
  $('deviceLine').textContent = `${state.deviceName} · ${state.deviceId.slice(0, 22)}…`;

  const pill = $('statusPill');
  pill.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  pill.appendChild(dot);
  if (state.paused) {
    pill.append('Paused');
    pill.className = 'badge warn';
    $('brandStatus').textContent = 'Paused';
  } else if (!state.syncState.online) {
    pill.append('Offline');
    pill.className = 'badge danger';
    $('brandStatus').textContent = 'Offline';
  } else {
    pill.append('Collecting');
    pill.className = 'badge ok';
    $('brandStatus').textContent = 'Collecting';
  }

  $('sCollected').textContent = state.collectorStats.emitted;
  $('sPending').textContent = state.syncState.pendingCount;
  $('sSynced').textContent = state.syncState.syncedTotal;
  $('sBlocked').textContent = state.collectorStats.droppedByFilter;

  $('syncNote').textContent = state.syncState.lastError
    ? `Last sync failed: ${state.syncState.lastError}`
    : `Last sync ${fmtAgo(state.syncState.lastSyncAt)} · last event ${fmtAgo(state.collectorStats.lastEventAt)}`;

  $('btnPause').textContent = state.paused ? 'Resume' : 'Pause';
  $('pauseNote').textContent = state.paused
    ? 'Paused — nothing is being collected.'
    : 'Activity is being collected from this Mac.';

  $('lastDrop').textContent = state.collectorStats.lastDropReason
    ? ` Most recent block: ${state.collectorStats.lastDropReason}.`
    : '';

  const s = state.settings;
  for (const k of ['collectBrowsing', 'collectSearches', 'collectYoutube', 'collectApps', 'collectCode', 'collectAiSessions']) {
    $(k).checked = Boolean(s[k]);
  }
  $('memoryOff').classList.toggle('hidden', Boolean(s.collectAiSessions));
  $('memoryOn').classList.toggle('hidden', !s.collectAiSessions);
  $('requireBiometric').checked = Boolean(state.biometric?.required);
  $('biometricRow').classList.toggle('hidden', !state.biometric?.available);

  renderChips('domainChips', s.blockedDomains, 'blockedDomains');
  renderChips('termChips', s.blockedQueryTerms, 'blockedQueryTerms');

  const ext = state.extension;
  if (ext) {
    $('extToken').value = ext.token;
    $('extensionEnabled').checked = ext.enabled;
    const p = $('extPill');
    p.textContent = !ext.enabled ? 'Disabled' : ext.listening ? 'Listening' : 'Not listening';
    p.className = 'badge ' + (ext.enabled && ext.listening ? 'ok' : 'warn');
    $('extStatus').textContent = ext.listening
      ? `Accepting events on 127.0.0.1:${ext.port} — this machine only.`
      : 'Not accepting events. Sign in and make sure collection is not paused.';
    $('extAccepted').textContent = ext.accepted
      ? `${ext.accepted} received · last ${fmtAgo(ext.lastAt)}`
      : 'No events received yet.';
  }
}

function renderChips(containerId, items, settingKey) {
  const el = $(containerId);
  el.textContent = '';
  if (!items || items.length === 0) {
    const span = document.createElement('span');
    span.className = 'note';
    span.textContent = 'None yet.';
    el.appendChild(span);
    return;
  }
  items.forEach((item) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.appendChild(document.createTextNode(item));
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = `Remove ${item}`;
    x.addEventListener('click', async () => {
      const next = state.settings[settingKey].filter((v) => v !== item);
      render(await api.updateSettings({ [settingKey]: next }));
    });
    chip.appendChild(x);
    el.appendChild(chip);
  });
}

// --- auth ------------------------------------------------------------------

async function doAuth(mode) {
  $('authError').textContent = '';
  // No apiUrl here — the app already knows its own backend (see store.ts).
  // A customer signs in with just their own credentials.
  const args = {
    email: $('email').value.trim(),
    password: $('password').value,
    passphrase: $('passphrase').value,
    mode,
  };
  if (!args.email || !args.password || !args.passphrase) {
    $('authError').textContent = 'All fields are required.';
    return;
  }
  try {
    render(await api.signIn(args));
    $('password').value = '';
    $('passphrase').value = '';
    void loadServerStatus();
    void loadActivity();
  } catch (err) {
    $('authError').textContent = cleanIpcError(err);
  }
}

$('btnLogin').addEventListener('click', () => doAuth('login'));
$('btnRegister').addEventListener('click', () => doAuth('register'));
$('passphrase').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth('login'); });

// --- locked screen ---------------------------------------------------------

async function tryTouchId() {
  if (touchIdInFlight) return;
  touchIdInFlight = true;
  $('lockError').textContent = '';
  try {
    render(await api.biometricUnlock());
    void loadActivity();
  } catch (err) {
    $('lockError').textContent = cleanIpcError(err);
  } finally {
    touchIdInFlight = false;
  }
}

$('btnTouchId').addEventListener('click', () => void tryTouchId());
$('btnPassUnlock').addEventListener('click', async () => {
  const value = $('lockPassphrase').value;
  if (!value) return;
  $('lockError').textContent = '';
  try {
    render(await api.passphraseUnlock(value));
    $('lockPassphrase').value = '';
    void loadActivity();
  } catch (err) {
    $('lockError').textContent = cleanIpcError(err);
  }
});
$('lockPassphrase').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnPassUnlock').click(); });
$('btnLockedSignOut').addEventListener('click', async () => render(await api.signOut()));

// --- actions ---------------------------------------------------------------

$('btnPause').addEventListener('click', async () => render(await api.togglePause()));
$('btnSync').addEventListener('click', async () => {
  $('btnSync').disabled = true;
  render(await api.syncNow());
  await loadServerStatus();
  $('btnSync').disabled = false;
});
$('btnSignOut').addEventListener('click', async () => render(await api.signOut()));
$('btnLockNow').addEventListener('click', async () => render(await api.lock()));
$('btnDataDir').addEventListener('click', () => api.openDataDir());
$('requireBiometric').addEventListener('change', async () => {
  render(await api.updateSettings({ requireBiometric: $('requireBiometric').checked }));
});

for (const k of ['collectBrowsing', 'collectSearches', 'collectYoutube', 'collectApps', 'collectCode', 'collectAiSessions']) {
  $(k).addEventListener('change', async () => {
    render(await api.updateSettings({ [k]: $(k).checked }));
    if (k === 'collectAiSessions' && $(k).checked) void loadMemoryGraph();
  });
}

$('btnAddDomain').addEventListener('click', async () => {
  const v = $('newDomain').value.trim().toLowerCase();
  if (!v) return;
  const next = [...new Set([...state.settings.blockedDomains, v])];
  $('newDomain').value = '';
  render(await api.updateSettings({ blockedDomains: next }));
});
$('btnAddTerm').addEventListener('click', async () => {
  const v = $('newTerm').value.trim().toLowerCase();
  if (!v) return;
  const next = [...new Set([...state.settings.blockedQueryTerms, v])];
  $('newTerm').value = '';
  render(await api.updateSettings({ blockedQueryTerms: next }));
});

// --- activity --------------------------------------------------------------

/** Show exactly what was stored — this is the "what do you have on me" view. */
function describeEvent(ev) {
  const p = ev.payload ?? {};
  const join = (...parts) => parts.filter(Boolean).join(' · ');
  switch (ev.type) {
    case 'browsing': return { title: p.title || p.domain || 'Untitled page', meta: p.url };
    case 'search':   return { title: `"${p.query}"`, meta: join(p.engine, p.url) };
    case 'youtube':  return { title: p.title || 'Video', meta: join(p.channel, p.url) };
    case 'app':      return { title: p.name, meta: join(p.bundleId, p.durationMs ? `${Math.round(p.durationMs / 60000)} min` : null) };
    case 'code':     return { title: p.file || '(file)', meta: join(p.project, p.language, p.editor) };
    case 'file':     return { title: p.name, meta: p.path };
    default:         return { title: ev.type, meta: JSON.stringify(p) };
  }
}

async function loadActivity() {
  const el = $('activityFeed');
  const res = await api.getActivity({ types: activeType ? [activeType] : undefined, limit: 150 });

  el.textContent = '';
  if (res.error === 'locked') { el.appendChild(emptyState('Locked', 'Unlock to view your activity.')); return; }

  if (!res.events || res.events.length === 0) {
    el.appendChild(
      emptyState(
        res.error ? `Could not load history: ${res.error}` : 'Nothing recorded yet',
        res.error ? undefined : 'Browse a page or switch apps — events appear within about 10 seconds.',
      ),
    );
  } else {
    res.events.forEach((ev) => {
      const { title, meta } = describeEvent(ev);
      el.appendChild(
        eventRow({
          kind: ev.type,
          title,
          meta,
          time: fmtClock(ev.timestamp),
          pending: ev.pending,
          onDelete: ev.pending
            ? null
            : async () => { await api.deleteEvents([ev.eventUuid]); void loadActivity(); },
        }),
      );
    });
  }

  if (res.undecryptable > 0) {
    const warn = document.createElement('div');
    warn.className = 'note warn';
    warn.classList.add('blocked-note');
    warn.textContent = `${res.undecryptable} event(s) could not be decrypted — likely from a device using a different passphrase.`;
    el.appendChild(warn);
  }

  const bl = $('blockedFeed');
  bl.textContent = '';
  if (!res.blocked || res.blocked.length === 0) {
    bl.className = 'note';
    bl.textContent = 'Nothing blocked in this session.';
    return;
  }
  bl.className = 'feed';
  res.blocked.forEach((b) => {
    bl.appendChild(eventRow({ kind: b.type, title: 'Blocked', meta: b.reason, time: fmtClock(b.at) }));
  });
}

$('btnRefreshActivity').addEventListener('click', () => void loadActivity());

// --- server status ---------------------------------------------------------

async function loadServerStatus() {
  const el = $('serverStatus');
  const res = await api.getStatus();
  el.textContent = '';
  if (res.error) {
    el.appendChild(emptyState(`Unavailable: ${res.error}`));
    return;
  }

  const total = document.createElement('div');
  total.className = 'list-row';
  const left = document.createElement('div');
  left.innerHTML = '<strong>Total events stored</strong>';
  const right = document.createElement('strong');
  right.textContent = String(res.totalEvents);
  total.append(left, right);
  el.appendChild(total);

  Object.entries(res.breakdown ?? {})
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, n]) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      const l = document.createElement('span');
      l.className = 'muted';
      l.textContent = type;
      const r = document.createElement('span');
      r.textContent = String(n);
      row.append(l, r);
      el.appendChild(row);
    });
}

// --- browser extension -----------------------------------------------------

$('btnCopyToken').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('extToken').value);
  const b = $('btnCopyToken');
  const original = b.textContent;
  b.textContent = 'Copied';
  setTimeout(() => { b.textContent = ''; b.appendChild(icon('copy')); b.append(' Copy'); void original; }, 1400);
});

$('extensionEnabled').addEventListener('change', async () => {
  render(await api.updateSettings({ extensionEnabled: $('extensionEnabled').checked }));
});

$('btnRegenToken').addEventListener('click', async () => {
  if (!confirm('Regenerate the pairing token?\n\nThe extension stops sending until you paste the new token into its options.')) return;
  render(await api.regenerateExtensionToken());
});

$('btnRevealExt').addEventListener('click', () => api.revealExtension());
api.getExtensionPath().then((p) => { $('extPath').textContent = p; });

// --- integrations ----------------------------------------------------------

async function loadIntegrations() {
  const el = $('integrationList');
  const res = await api.listIntegrations();
  el.textContent = '';
  const live = (res.integrations ?? []).filter((i) => !i.revokedAt);
  if (live.length === 0) {
    el.appendChild(emptyState('No active tokens', 'Generate one above to connect Claude or another MCP client.'));
    return;
  }
  live.forEach((i) => {
    const row = document.createElement('div');
    row.className = 'list-row';

    const left = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = i.label;
    const scopes = document.createElement('div');
    scopes.className = 'meta mono';
    scopes.textContent = i.scopes.join(' · ');
    const used = document.createElement('div');
    used.className = 'meta';
    used.textContent = `last used ${i.lastUsedAt ? fmtAgo(i.lastUsedAt) : 'never'}`;
    left.append(name, scopes, used);

    const btn = document.createElement('button');
    btn.className = 'danger sm';
    btn.textContent = 'Revoke';
    btn.addEventListener('click', async () => { await api.revokeIntegration(i.id); void loadIntegrations(); });

    row.append(left, btn);
    el.appendChild(row);
  });
}

// --- MCP server status -----------------------------------------------------

async function loadMcpStatus() {
  const el = $('mcpStatus');
  if (!el) return;

  try {
    const mcpState = await api.getMcpState();
    el.textContent = '';

    const row = document.createElement('div');
    row.className = 'list-row';

    const left = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = 'Embedded MCP Server';
    const desc = document.createElement('div');
    desc.className = 'meta';
    desc.textContent = mcpState.running
      ? `Running (pid ${mcpState.pid}) — AI tools can connect`
      : mcpState.error
        ? `Stopped: ${mcpState.error}`
        : 'Stopped — start it to enable AI access';
    left.append(name, desc);

    const btn = document.createElement('button');
    btn.className = mcpState.running ? 'danger sm' : 'primary sm';
    btn.textContent = mcpState.running ? 'Stop' : 'Start';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        if (mcpState.running) {
          await api.stopMcpServer();
        } else {
          await api.startMcpServer();
        }
        void loadMcpStatus();
      } catch (err) {
        console.error('MCP server toggle failed:', err);
      }
      btn.disabled = false;
    });

    row.append(left, btn);
    el.appendChild(row);

    // Add info about how to connect
    if (mcpState.running) {
      const info = document.createElement('div');
      info.className = 'note mt-sm';
      info.innerHTML = `
        <strong>Connected automatically.</strong> AI tools like Claude Desktop will find the MCP server
        at <code>~/.oneconscious/mcp.json</code>. No manual setup needed.
      `;
      el.appendChild(info);
    }
  } catch (err) {
    el.textContent = `Error: ${err.message}`;
  }
}

// --- remote AI access (ChatGPT etc.) ----------------------------------------

let remoteAccessEnabled = false;

async function loadRemoteAccessStatus() {
  const toggle = $('remoteAccessToggle');
  const subtext = $('remoteAccessSubtext');
  if (!toggle || !subtext) return;

  try {
    const status = await api.getRemoteAccessStatus();
    remoteAccessEnabled = Boolean(status.enabled);
    toggle.checked = remoteAccessEnabled;
    subtext.textContent = remoteAccessEnabled
      ? `Enabled ${status.enabledAt ? fmtAgo(status.enabledAt) : ''}`
      : 'Off — your key never leaves this Mac';
  } catch (err) {
    subtext.textContent = `Error: ${err.message}`;
  }
}

$('remoteAccessToggle')?.addEventListener('change', async (e) => {
  const toggle = e.target;
  const errBox = $('remoteAccessError');
  errBox.textContent = '';

  if (toggle.checked) {
    const ok = confirm(
      'Turning this on lets OneConscious\'s servers decrypt your activity to answer ' +
        'remote AI tools like ChatGPT. Your local AI tools (Claude, Cursor, Kiro) are ' +
        'not affected and stay fully encrypted.\n\nSend a copy of your encryption key to enable this?',
    );
    if (!ok) { toggle.checked = false; return; }

    toggle.disabled = true;
    try {
      await api.enableRemoteAccess();
    } catch (err) {
      errBox.textContent = `Could not enable: ${err.message}`;
      toggle.checked = false;
    }
    toggle.disabled = false;
  } else {
    toggle.disabled = true;
    try {
      await api.disableRemoteAccess();
    } catch (err) {
      errBox.textContent = `Could not disable: ${err.message}`;
      toggle.checked = true;
    }
    toggle.disabled = false;
  }
  void loadRemoteAccessStatus();
});

$('btnConnect').addEventListener('click', async () => {
  $('connectError').textContent = '';
  const scopes = [...document.querySelectorAll('.scope:checked')].map((c) => c.value);
  if (scopes.length === 0) { $('connectError').textContent = 'Select at least one scope.'; return; }
  try {
    const res = await api.connectAiTool({ label: $('integrationLabel').value.trim() || 'AI tool', scopes });
    $('configPath').textContent = res.configPath;
    $('mcpSnippet').textContent = JSON.stringify(
      { mcpServers: { oneconscious: { command: 'node', args: ['<repo>/mcp-server/dist/server.js'] } } },
      null,
      2,
    );
    $('connectResult').classList.remove('hidden');
    void loadIntegrations();
  } catch (err) {
    $('connectError').textContent = cleanIpcError(err);
  }
});

$('btnReveal').addEventListener('click', () => api.revealConfig());

// --- audit -----------------------------------------------------------------

const AI_ACTIONS = new Set(['ai_read_activity', 'ai_read_summary', 'ai_read_devices']);
const ACTION_LABEL = {
  ai_read_activity: 'Read your activity',
  ai_read_summary: 'Read your summary',
  ai_read_devices: 'Read device status',
  login: 'Signed in',
  logout: 'Signed out',
  register: 'Account created',
  export: 'Exported data',
  delete_data: 'Deleted data',
  integration_created: 'Token issued',
  integration_revoked: 'Token revoked',
  preferences_updated: 'Preferences changed',
  passkey_registered: 'Passkey added',
  passkey_removed: 'Passkey removed',
};

async function loadAudit() {
  const el = $('auditList');
  const res = await api.getAudit();
  el.textContent = '';
  if (!res.entries || res.entries.length === 0) {
    el.appendChild(emptyState(res.error ? `Unavailable: ${res.error}` : 'Nothing recorded yet'));
    return;
  }
  res.entries.forEach((e) => {
    const isAi = AI_ACTIONS.has(e.action);
    const meta = [
      e.integrationLabel ?? 'your session',
      e.claimedAiModel ? `claims "${e.claimedAiModel}" (unverified)` : null,
    ].filter(Boolean).join(' · ');

    const row = eventRow({
      kind: isAi ? 'app' : 'file',
      title: ACTION_LABEL[e.action] ?? e.action.replace(/_/g, ' '),
      meta,
      time: fmtClock(e.timestamp),
    });
    // Swap in a semantic icon for the audit context.
    const ic = row.querySelector('.event-icon');
    ic.textContent = '';
    ic.appendChild(icon(isAi ? 'robot' : 'shield'));
    ic.title = isAi ? 'AI' : 'You';
    el.appendChild(row);
  });
}

$('btnRefreshAudit').addEventListener('click', () => void loadAudit());

// --- memory (AI session search + graph) -------------------------------------
//
// No bundler in this renderer and nothing worth pulling a graph library in
// for at a ~300-node cap, so this is a small hand-rolled force simulation
// (repulsion + spring links + centering, d3-force's shape without the
// dependency) run once per load, plus a plain Canvas 2D draw — the same
// hand-rolled-visualization approach the landing page uses for its SVG flow
// diagram rather than a heavy all-in-one library.

let memoryNodes = [];
let memoryEdges = [];
let selectedNodeId = null;
let hoveredNodeId = null;
let draggingNode = null;
let dragMoved = false;

const TOOL_COLOR = { 'claude-code': '#2a78d6', 'codex-cli': '#0f7b43', 'gemini-cli': '#a85a00' };

function simulateForceLayout(nodes, edges, width, height, ticks = 260) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  nodes.forEach((n, i) => {
    if (n.x == null) {
      const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
      const r = Math.min(width, height) * 0.32;
      n.x = width / 2 + Math.cos(angle) * r + (Math.random() - 0.5) * 12;
      n.y = height / 2 + Math.sin(angle) * r + (Math.random() - 0.5) * 12;
    }
    n.vx = 0;
    n.vy = 0;
  });

  const REPULSION = 2200;
  const LINK_DISTANCE = 70;
  const LINK_STRENGTH = 0.08;
  const CENTER_STRENGTH = 0.02;
  let alpha = 1;

  for (let t = 0; t < ticks; t++) {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (a.pinned) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distSq = dx * dx + dy * dy || 0.01;
        const force = (REPULSION * alpha) / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
      }
    }
    for (const e of edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const targetDist = LINK_DISTANCE * (1.3 - Math.min(e.score, 1));
      const diff = (dist - targetDist) * LINK_STRENGTH * alpha;
      const fx = (dx / dist) * diff;
      const fy = (dy / dist) * diff;
      if (!a.pinned) { a.vx += fx; a.vy += fy; }
      if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
    }
    for (const n of nodes) {
      if (n.pinned) continue;
      n.vx += (width / 2 - n.x) * CENTER_STRENGTH * alpha;
      n.vy += (height / 2 - n.y) * CENTER_STRENGTH * alpha;
      n.vx *= 0.75;
      n.vy *= 0.75;
      n.x += n.vx;
      n.y += n.vy;
    }
    alpha *= 0.985;
  }
}

function drawMemoryGraph() {
  const canvas = $('memoryGraphCanvas');
  const wrap = $('memoryGraphWrap');
  const dpr = window.devicePixelRatio || 1;
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const byId = new Map(memoryNodes.map((n) => [n.id, n]));
  for (const e of memoryEdges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    ctx.strokeStyle = `rgba(130,130,145,${0.12 + Math.min(e.score, 1) * 0.35})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (const n of memoryNodes) {
    const active = n.id === selectedNodeId || n.id === hoveredNodeId;
    ctx.beginPath();
    ctx.arc(n.x, n.y, active ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = TOOL_COLOR[n.tool] ?? '#85858f';
    ctx.fill();
    if (n.id === selectedNodeId) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#16161a';
      ctx.stroke();
    }
  }
}

function findMemoryNodeNear(x, y) {
  let best = null;
  let bestDist = 10; // px hit radius
  for (const n of memoryNodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return best;
}

function showMemoryDetail(node) {
  selectedNodeId = node.id;
  $('memoryDetailCard').classList.remove('hidden');
  const el = $('memoryDetail');
  el.textContent = '';
  const meta = document.createElement('div');
  meta.className = 'memory-detail-meta';
  meta.textContent = [node.tool, node.role, node.project, node.createdAt ? fmtClock(node.createdAt) : null]
    .filter(Boolean).join(' · ');
  const text = document.createElement('div');
  text.className = 'memory-detail-text';
  text.textContent = node.content;
  el.append(meta, text);
  drawMemoryGraph();
}

$('btnCloseMemoryDetail').addEventListener('click', () => {
  selectedNodeId = null;
  $('memoryDetailCard').classList.add('hidden');
  drawMemoryGraph();
});

async function loadMemoryGraph() {
  const wrap = $('memoryGraphWrap');
  const empty = $('memoryGraphEmpty');
  const res = await api.getMemoryGraph({});

  if (res.error) {
    memoryNodes = [];
    memoryEdges = [];
    empty.textContent = '';
    empty.appendChild(emptyState(`Unavailable: ${res.error}`));
    empty.classList.remove('hidden');
    $('memoryGraphCount').textContent = '';
    drawMemoryGraph();
    return;
  }

  memoryNodes = res.nodes;
  memoryEdges = res.edges;
  $('memoryGraphCount').textContent = memoryNodes.length ? `${memoryNodes.length} chunk(s)` : '';

  if (memoryNodes.length === 0) {
    empty.textContent = '';
    empty.appendChild(emptyState('Nothing indexed yet', 'Use Claude Code, Codex CLI or Gemini CLI and this fills in as you go.'));
    empty.classList.remove('hidden');
    drawMemoryGraph();
    return;
  }

  empty.classList.add('hidden');
  simulateForceLayout(memoryNodes, memoryEdges, wrap.clientWidth || 600, wrap.clientHeight || 420);
  drawMemoryGraph();
}

async function runMemorySearch() {
  const q = $('memorySearch').value.trim();
  const el = $('memorySearchResults');
  el.textContent = '';
  if (!q) return;
  const res = await api.searchMemory({ query: q, limit: 20 });
  if (res.error) { el.appendChild(emptyState(`Unavailable: ${res.error}`)); return; }
  if (!res.results || res.results.length === 0) { el.appendChild(emptyState('No matches')); return; }
  res.results.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'memory-result';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = `${r.tool} · ${r.role === 'user' ? 'you said' : 'reply'} · ${fmtClock(r.createdAt)}`;
    const snippet = document.createElement('div');
    snippet.className = 'snippet';
    snippet.textContent = r.content.length > 220 ? `${r.content.slice(0, 220)}…` : r.content;
    row.append(who, snippet);
    row.addEventListener('click', () => {
      showMemoryDetail(memoryNodes.find((n) => n.id === r.id) ?? r);
    });
    el.appendChild(row);
  });
}

$('btnMemorySearch').addEventListener('click', () => void runMemorySearch());
$('memorySearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') void runMemorySearch(); });
$('btnRefreshMemory').addEventListener('click', () => void loadMemoryGraph());

const memoryCanvas = $('memoryGraphCanvas');
memoryCanvas.addEventListener('mousedown', (e) => {
  const rect = memoryCanvas.getBoundingClientRect();
  const node = findMemoryNodeNear(e.clientX - rect.left, e.clientY - rect.top);
  if (!node) return;
  draggingNode = node;
  dragMoved = false;
  node.pinned = true;
});
memoryCanvas.addEventListener('mousemove', (e) => {
  const rect = memoryCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (draggingNode) {
    dragMoved = true;
    draggingNode.x = x;
    draggingNode.y = y;
    drawMemoryGraph();
    return;
  }
  const near = findMemoryNodeNear(x, y);
  const nextHover = near?.id ?? null;
  if (nextHover !== hoveredNodeId) {
    hoveredNodeId = nextHover;
    memoryCanvas.style.cursor = near ? 'pointer' : 'grab';
    drawMemoryGraph();
  }
});
window.addEventListener('mouseup', () => {
  if (!draggingNode) return;
  const node = draggingNode;
  const moved = dragMoved;
  draggingNode = null;
  node.pinned = false;
  if (moved) {
    const wrap = $('memoryGraphWrap');
    simulateForceLayout(memoryNodes, memoryEdges, wrap.clientWidth || 600, wrap.clientHeight || 420, 40);
    drawMemoryGraph();
  } else if (!document.querySelector('[data-panel="memory"]').classList.contains('hidden')) {
    showMemoryDetail(node);
  }
});
window.addEventListener('resize', () => { if (memoryNodes.length) drawMemoryGraph(); });

// --- boot ------------------------------------------------------------------

api.onState(render);
api.getState().then((s) => {
  render(s);
  if (s.signedIn) {
    void loadServerStatus();
    void loadActivity();
  }
});

setInterval(() => {
  if (!state?.signedIn) return;
  void loadServerStatus();
  const activityVisible = !document.querySelector('[data-panel="activity"]').classList.contains('hidden');
  if (activityVisible) void loadActivity();
}, 30_000);
