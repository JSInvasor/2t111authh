'use strict';

/* ===================== helpers ===================== */

const $ = (sel, root = document) => root.querySelector(sel);
const view = () => $('#view');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(sec) {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtExpiry(sec) {
  if (!sec) return '<span class="badge">∞ Lifetime</span>';
  const expired = sec * 1000 < Date.now();
  return `<span class="${expired ? 'pill pill-expired' : ''}">${fmtDate(sec)}${expired ? ' (expired)' : ''}</span>`;
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast ' + kind), 2600);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
  toast('Copied to clipboard', 'ok');
}

/* ===================== icons (Lucide, inlined for CSP) ===================== */

const ICONS = {
  dashboard:
    '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  key: '<path d="m15.5 7.5 3 3L22 7l-3-3"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'log-out':
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  'circle-x': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
};

function icon(name, cls = '') {
  return `<svg class="ico ico-${name} ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
    el.removeAttribute('data-icon');
  });
}

function statCard(num, label, ico, cls = '') {
  return `<div class="stat ${cls}"><span class="stat-ico">${icon(ico)}</span><div class="num">${num}</div><div class="lbl">${esc(label)}</div></div>`;
}

/** Fill missing days with zeros across the window. daily rows: { date(epoch), total, successes }. */
function fillDaily(daily, windowDays) {
  const DAY = 86400;
  const today = Math.floor(Date.now() / 1000 / DAY);
  const start = today - (Math.max(1, windowDays) - 1);
  const map = new Map((daily || []).map((d) => [Math.floor(d.date / DAY), d]));
  const out = [];
  for (let day = start; day <= today; day++) {
    const d = map.get(day);
    out.push({ day, total: d ? d.total : 0, successes: d ? d.successes : 0 });
  }
  return out;
}

/** Small inline bar chart (successes = accent, failures = muted overlay). */
function execChart(days) {
  const max = Math.max(1, ...days.map((d) => d.total));
  const W = 100, H = 40, gap = 1.4;
  const bw = (W - gap * (days.length - 1)) / days.length;
  const bars = days
    .map((d, i) => {
      const x = i * (bw + gap);
      const th = (d.total / max) * (H - 1);
      const sh = (d.successes / max) * (H - 1);
      const label = new Date(d.day * 86400 * 1000).toLocaleDateString();
      const total = `<rect x="${x.toFixed(2)}" y="${(H - th).toFixed(2)}" width="${bw.toFixed(2)}" height="${Math.max(0.4, th).toFixed(2)}" rx="0.5" fill="var(--faint)" opacity="0.5"/>`;
      const ok = sh > 0 ? `<rect x="${x.toFixed(2)}" y="${(H - sh).toFixed(2)}" width="${bw.toFixed(2)}" height="${sh.toFixed(2)}" rx="0.5" fill="var(--accent-2)"/>` : '';
      return `<g><title>${label}: ${d.total} (${d.successes} ok)</title>${total}${ok}</g>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="exec-chart">${bars}</svg>`;
}

/* ===================== api ===================== */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch {}

  if (res.status === 401 && !path.startsWith('/dashboard/api/')) {
    showLogin();
    throw new Error('Session expired');
  }
  if (!res.ok || (data && data.success === false)) {
    throw new Error((data && data.message) || `HTTP ${res.status}`);
  }
  return data;
}

/* ===================== auth / boot ===================== */

const state = { role: 'admin', username: '', credits: 0, keyApiBase: '/api/v1/keys', refresh: null };

async function boot() {
  try {
    const me = await api('/dashboard/api/me');
    state.role = me.role || 'admin';
    state.username = me.username;
    state.credits = me.credits;
    state.keyApiBase = state.role === 'reseller' ? '/api/v1/reseller/keys' : '/api/v1/keys';
    showApp(me);
    route();
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#loginError').textContent = '';
}

function showApp(me) {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#whoami').innerHTML = `Signed in as <b>${esc(me.username)}</b>` + (me.role === 'reseller' ? ' · reseller' : '');
  const nav = $('#nav');
  if (me.role === 'reseller') {
    nav.innerHTML = `<a href="#/" class="nav-item active" data-nav="panel">${icon('key')} My Keys</a>`;
  } else {
    nav.innerHTML =
      `<a href="#/" class="nav-item" data-nav="dashboard">${icon('dashboard')} Dashboard</a>` +
      `<a href="#/resellers" class="nav-item" data-nav="resellers">${icon('users')} Resellers</a>`;
  }
}

function setActiveNav(name) {
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.nav === name));
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  const errEl = $('#loginError');
  errEl.textContent = '';
  try {
    await api('/dashboard/api/login', { method: 'POST', body: { username, password } });
    $('#loginPass').value = '';
    boot();
  } catch (err) {
    errEl.textContent = err.message || 'Login failed';
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/dashboard/api/logout', { method: 'POST' }); } catch {}
  showLogin();
});

/* ===================== router ===================== */

window.addEventListener('hashchange', route);

function route() {
  if ($('#app').classList.contains('hidden')) return;
  if (state.role === 'reseller') return renderResellerPanel();
  const hash = location.hash || '#/';
  let m;
  if ((m = hash.match(/^#\/resellers\/(\d+)/))) return renderResellerDetail(m[1]);
  if (hash.startsWith('#/resellers')) return renderResellers();
  if ((m = hash.match(/^#\/s\/([\w-]+)/))) return renderScriptDetail(m[1]);
  return renderScriptsList();
}

/* ===================== scripts list ===================== */

async function renderScriptsList() {
  setActiveNav('dashboard');
  state.refresh = renderScriptsList;
  view().innerHTML = '<div class="loading">Loading…</div>';
  let scripts, ov;
  try {
    [{ scripts }, { overview: ov }] = await Promise.all([
      api('/api/v1/scripts'),
      api('/api/v1/overview'),
    ]);
  } catch (e) { view().innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  const t = ov.totals;
  const overviewRow = `
    <div class="stats-row">
      ${statCard(t.executions_24h, 'Executions (24h)', 'activity', 'accent')}
      ${statCard(t.active_users_24h, 'Active users (24h)', 'users')}
      ${statCard(t.scripts, 'Scripts', 'code')}
      ${statCard(t.keys, 'Total keys', 'key')}
      ${statCard(t.active_keys, 'Active keys', 'circle-check', 'success')}
      ${statCard(t.bound_keys, 'HWID-bound', 'cpu')}
    </div>`;

  const cards = scripts.map((s) => `
    <a class="card script-card" href="#/s/${esc(s.id)}">
      <div class="card-top">
        <h3>${esc(s.name)}</h3>
        <span class="badge">v${esc(s.version)}</span>
      </div>
      <div class="card-meta">
        <span>${icon('key')} <b>${s.key_count}</b> keys</span>
        <span>${icon('circle-check')} <b>${s.active_keys}</b> active</span>
        <span>${s.obfuscate ? icon('lock') : icon('unlock')}${s.enabled ? '' : ' ' + icon('power', 'danger-ico')}</span>
      </div>
      <code class="card-id">${esc(s.id)}</code>
    </a>`).join('');

  view().innerHTML = `
    <div class="page-head">
      <div><h1>Overview</h1><p class="muted">Manage your projects and keys</p></div>
      <button class="btn btn-primary" data-action="new-script">${icon('plus')} New Script</button>
    </div>
    ${overviewRow}
    <h2 class="section">Scripts</h2>
    ${scripts.length ? `<div class="grid">${cards}</div>`
      : `<div class="empty">No scripts yet. Create your first one to get a loader.</div>`}
  `;
}

/* ===================== script detail ===================== */

let currentKeys = [];
let currentScript = null;

async function renderScriptDetail(id) {
  setActiveNav('dashboard');
  state.refresh = () => renderScriptDetail(id);
  view().innerHTML = '<div class="loading">Loading…</div>';

  let script, stats, keys;
  try {
    [{ script }, { stats }, { keys }] = await Promise.all([
      api(`/api/v1/scripts/${id}`),
      api(`/api/v1/scripts/${id}/stats?days=7`),
      api(`/api/v1/scripts/${id}/keys?limit=1000`),
    ]);
  } catch (e) { view().innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  currentScript = script;
  currentKeys = keys;
  const ex = stats.executions;
  const kc = stats.keys;
  const snippet = `script_key = "YOUR_KEY_HERE";\nloadstring(game:HttpGet("${location.origin}/loader/${script.id}.lua"))()`;

  view().innerHTML = `
    <a class="back" href="#/">${icon('arrow-left')} Scripts</a>
    <div class="page-head">
      <div><h1>${esc(script.name)} <span class="badge">v${esc(script.version)}</span>${
        script.obfuscate ? ` <span class="badge badge-accent">${icon('lock')} Protected</span>` : ''
      }${
        script.enabled ? '' : ` <span class="badge badge-danger">${icon('power')} Disabled</span>`
      }</h1>
        <p class="muted mono">${esc(script.id)}</p></div>
      <button class="btn btn-primary" data-action="gen-keys">${icon('plus')} Generate keys</button>
    </div>

    <div class="stats-row">
      ${statCard(ex.total, 'Executions (7d)', 'activity', 'accent')}
      ${statCard(ex.unique_hwids, 'Unique HWIDs', 'cpu')}
      ${statCard(ex.successes, 'Successful', 'circle-check', 'success')}
      ${statCard(ex.failures, 'Failed', 'circle-x', 'danger')}
      ${statCard(kc.total, 'Total keys', 'key')}
      ${statCard(kc.active, 'Active', 'circle-check')}
      ${statCard(kc.bound, 'HWID-bound', 'lock')}
    </div>

    <div class="panel">
      <div class="panel-head"><h2>${icon('activity')} Executions · last ${stats.window_days}d</h2></div>
      <div class="panel-body">${execChart(fillDaily(stats.daily, stats.window_days))}</div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>${icon('code')} Loader</h2>
        <button class="btn btn-sm" data-action="copy" data-copy="${esc(snippet)}">${icon('copy')} Copy snippet</button></div>
      <pre class="snippet">${esc(snippet)}</pre>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>${icon('key')} Keys (${currentKeys.length})</h2>
        <div class="panel-actions">
          <input id="keySearch" placeholder="Search key / note / HWID" />
          <button class="btn btn-sm" data-action="export-csv">${icon('download')} Export CSV</button>
          <button class="btn btn-primary btn-sm" data-action="gen-keys">${icon('plus')} Generate</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Key</th><th>Status</th><th>HWID</th><th>Expires</th>
            <th>Execs</th><th>Last seen</th><th></th>
          </tr></thead>
          <tbody id="keysBody"></tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>${icon('settings')} Settings</h2></div>
      <div class="panel-body">
        <form id="settingsForm">
          <div class="form-grid">
            <div><label>Name</label><input id="setName" value="${esc(script.name)}" /></div>
            <div><label>Version</label><input id="setVersion" value="${esc(script.version)}" /></div>
            <div class="full check">
              <input type="checkbox" id="setHwidLock" ${script.hwid_lock ? 'checked' : ''} />
              <label style="margin:0">Lock each key to the first device (HWID) it runs on</label>
            </div>
            <div class="full check">
              <input type="checkbox" id="setObf" ${script.obfuscate ? 'checked' : ''} />
              <label style="margin:0">Obfuscate &amp; encrypt the script each time it is delivered</label>
            </div>
            <div class="full check">
              <input type="checkbox" id="setEnabled" ${script.enabled ? 'checked' : ''} />
              <label style="margin:0">Enabled (uncheck for maintenance mode — all auth is rejected)</label>
            </div>
            <div class="full"><label>Protected script source (Lua)</label>
              <textarea id="setSource" rows="10" spellcheck="false"></textarea></div>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${icon('check')} Save changes</button>
            <span class="spacer"></span>
            <button type="button" class="btn btn-danger" data-action="delete-script">${icon('trash')} Delete script</button>
          </div>
        </form>
      </div>
    </div>
  `;

  // set values that shouldn't be HTML-escaped inline
  $('#setSource').value = script.source || '';

  renderKeyRows(currentKeys);

  $('#keySearch').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    renderKeyRows(
      currentKeys.filter((k) =>
        [k.value, k.note, k.hwid, k.discord_id].some((v) => v && String(v).toLowerCase().includes(q))
      )
    );
  });

  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/v1/scripts/${script.id}`, {
        method: 'PATCH',
        body: {
          name: $('#setName').value.trim(),
          version: $('#setVersion').value.trim(),
          hwid_lock: $('#setHwidLock').checked,
          obfuscate: $('#setObf').checked,
          enabled: $('#setEnabled').checked,
          source: $('#setSource').value,
        },
      });
      toast('Settings saved', 'ok');
      renderScriptDetail(script.id);
    } catch (err) { toast(err.message, 'err'); }
  });
}

function renderKeyRows(keys) {
  const body = $('#keysBody');
  if (!body) return;
  if (!keys.length) {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:26px">No keys</td></tr>';
    return;
  }
  body.innerHTML = keys.map((k) => {
    const banned = k.status === 'banned';
    return `<tr>
      <td><code>${esc(k.value)}</code></td>
      <td><span class="pill pill-${esc(k.status)}">${icon(k.status === 'banned' ? 'ban' : k.status === 'paused' ? 'power' : 'circle-check')} ${esc(k.status)}</span></td>
      <td class="hwid-cell" title="${esc(k.hwid || '')}">${k.hwid ? esc(k.hwid) : '—'}</td>
      <td>${fmtExpiry(k.expires_at)}</td>
      <td>${k.total_executions}</td>
      <td>${fmtDate(k.last_seen)}</td>
      <td class="row-actions">
        <button class="icon-btn" title="Copy key" data-action="copy" data-copy="${esc(k.value)}">${icon('copy')}</button>
        <button class="icon-btn" title="${banned ? 'Unban' : 'Ban'}" data-action="key-${banned ? 'unban' : 'ban'}" data-id="${k.id}">${icon(banned ? 'check' : 'ban')}</button>
        <button class="icon-btn" title="Reset HWID" data-action="key-reset" data-id="${k.id}">${icon('reset')}</button>
        <button class="icon-btn danger" title="Delete key" data-action="key-delete" data-id="${k.id}">${icon('trash')}</button>
      </td>
    </tr>`;
  }).join('');
}

/* ===================== key actions ===================== */

async function keyAction(action, id) {
  const base = state.keyApiBase;
  const map = { 'key-ban': ['POST', `${base}/${id}/ban`], 'key-unban': ['POST', `${base}/${id}/unban`], 'key-reset': ['POST', `${base}/${id}/reset-hwid`] };
  try {
    if (action === 'key-delete') {
      if (!confirm('Delete this key permanently?')) return;
      await api(`${base}/${id}`, { method: 'DELETE' });
      toast('Key deleted', 'ok');
    } else {
      const [method, path] = map[action];
      await api(path, { method });
      toast('Done', 'ok');
    }
    if (state.refresh) state.refresh();
  } catch (err) { toast(err.message, 'err'); }
}

/* ===================== modals ===================== */

function closeModal() { $('#modalRoot').innerHTML = ''; }

function openModal(title, bodyHTML, footHTML) {
  $('#modalRoot').innerHTML = `
    <div class="modal-overlay" data-action="modal-backdrop">
      <div class="modal">
        <div class="modal-head"><span>${title}</span><button class="icon-btn" title="Close" data-action="modal-close">${icon('x')}</button></div>
        <div class="modal-body">${bodyHTML}</div>
        <div class="modal-foot">${footHTML}</div>
      </div>
    </div>`;
}

function openNewScriptModal() {
  openModal(
    'New script',
    `<div><label>Name</label><input id="nsName" placeholder="My Hub" /></div>
     <div><label>Version</label><input id="nsVersion" value="1.0.0" /></div>
     <div class="check"><input type="checkbox" id="nsHwid" checked />
       <label style="margin:0">Lock keys to HWID</label></div>
     <div class="check"><input type="checkbox" id="nsObf" checked />
       <label style="margin:0">Obfuscate &amp; encrypt script on delivery</label></div>
     <div><label>Script source (Lua, optional)</label>
       <textarea id="nsSource" rows="6" placeholder='print("hello")'></textarea></div>`,
    `<button class="btn" data-action="modal-close">Cancel</button>
     <button class="btn btn-primary" data-action="create-script">${icon('plus')} Create</button>`
  );
}

async function createScript() {
  const name = $('#nsName').value.trim();
  if (!name) { toast('Name is required', 'err'); return; }
  try {
    const { script } = await api('/api/v1/scripts', {
      method: 'POST',
      body: {
        name,
        version: $('#nsVersion').value.trim() || '1.0.0',
        hwid_lock: $('#nsHwid').checked,
        obfuscate: $('#nsObf').checked,
        source: $('#nsSource').value,
      },
    });
    closeModal();
    toast('Script created', 'ok');
    location.hash = `#/s/${script.id}`;
  } catch (err) { toast(err.message, 'err'); }
}

function openGenKeysModal() {
  openModal(
    'Generate keys',
    `<div class="form-grid">
       <div><label>How many</label><input id="gkCount" type="number" value="1" min="1" max="1000" /></div>
       <div><label>Expires in (days, 0 = lifetime)</label><input id="gkDays" type="number" value="0" min="0" /></div>
       <div class="full"><label>Note (optional)</label><input id="gkNote" placeholder="e.g. October batch" /></div>
     </div>`,
    `<button class="btn" data-action="modal-close">Cancel</button>
     <button class="btn btn-primary" data-action="do-gen-keys">${icon('key')} Generate</button>`
  );
}

async function doGenKeys() {
  const count = parseInt($('#gkCount').value, 10) || 1;
  const days = parseInt($('#gkDays').value, 10) || 0;
  const note = $('#gkNote').value.trim();
  try {
    const { keys } = await api(`/api/v1/scripts/${currentScript.id}/keys`, {
      method: 'POST',
      body: { count, expiresInDays: days > 0 ? days : null, note },
    });
    const values = keys.map((k) => k.value);
    openModal(
      `${keys.length} key(s) generated`,
      `<div class="keys-output">${values.map((v) => `<div>${esc(v)}</div>`).join('')}</div>`,
      `<button class="btn btn-primary" data-action="copy" data-copy="${esc(values.join('\n'))}">${icon('copy')} Copy all</button>
       <button class="btn" data-action="modal-close-refresh">${icon('check')} Done</button>`
    );
  } catch (err) { toast(err.message, 'err'); }
}

/* ===================== resellers (admin) ===================== */

async function renderResellers() {
  setActiveNav('resellers');
  state.refresh = renderResellers;
  view().innerHTML = '<div class="loading">Loading…</div>';
  let resellers;
  try { ({ resellers } = await api('/api/v1/resellers')); }
  catch (e) { view().innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  const rows = resellers.map((r) => `
    <tr data-open-reseller="${r.id}" style="cursor:pointer">
      <td><b>${esc(r.username)}</b></td>
      <td>${r.credits}</td>
      <td>${r.scripts}</td>
      <td>${r.keys}</td>
      <td>${r.enabled
        ? `<span class="pill pill-active">${icon('circle-check')} active</span>`
        : `<span class="pill pill-banned">${icon('ban')} disabled</span>`}</td>
      <td class="row-actions"><button class="icon-btn" title="Manage" data-open-reseller="${r.id}">${icon('settings')}</button></td>
    </tr>`).join('');

  view().innerHTML = `
    <div class="page-head">
      <div><h1>Resellers</h1><p class="muted">Sub-accounts that sell keys using credits</p></div>
      <button class="btn btn-primary" data-action="new-reseller">${icon('plus')} New Reseller</button>
    </div>
    ${resellers.length ? `<div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>Username</th><th>Credits</th><th>Scripts</th><th>Keys</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`
      : `<div class="empty">No resellers yet. Create one to delegate key generation.</div>`}
  `;
}

function openNewResellerModal() {
  openModal('New reseller',
    `<div><label>Username</label><input id="nrUser" placeholder="reseller1" /></div>
     <div><label>Password</label><input id="nrPass" type="password" placeholder="min 6 characters" /></div>
     <div><label>Starting credits</label><input id="nrCredits" type="number" value="0" min="0" /></div>`,
    `<button class="btn" data-action="modal-close">Cancel</button>
     <button class="btn btn-primary" data-action="create-reseller">${icon('plus')} Create</button>`);
}

async function createReseller() {
  const username = $('#nrUser').value.trim();
  const password = $('#nrPass').value;
  const credits = parseInt($('#nrCredits').value, 10) || 0;
  if (!username || !password) { toast('Username and password are required', 'err'); return; }
  try {
    const { reseller } = await api('/api/v1/resellers', { method: 'POST', body: { username, password, credits } });
    closeModal(); toast('Reseller created', 'ok');
    location.hash = `#/resellers/${reseller.id}`;
  } catch (err) { toast(err.message, 'err'); }
}

async function renderResellerDetail(id) {
  setActiveNav('resellers');
  state.refresh = () => renderResellerDetail(id);
  state.resellerDetailId = id;
  view().innerHTML = '<div class="loading">Loading…</div>';
  let reseller, assigned, allScripts;
  try {
    [{ reseller, scripts: assigned }, { scripts: allScripts }] = await Promise.all([
      api(`/api/v1/resellers/${id}`),
      api('/api/v1/scripts'),
    ]);
  } catch (e) { view().innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  const assignedIds = new Set(assigned.map((s) => s.id));
  const unassigned = allScripts.filter((s) => !assignedIds.has(s.id));
  const chips = assigned.length
    ? assigned.map((s) => `<div class="chip">${esc(s.name)} <button class="chip-x" title="Unassign" data-unassign="${esc(s.id)}">${icon('x')}</button></div>`).join('')
    : '<span class="muted">No scripts assigned.</span>';
  const options = unassigned.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');

  view().innerHTML = `
    <a class="back" href="#/resellers">${icon('arrow-left')} Resellers</a>
    <div class="page-head">
      <div><h1>${esc(reseller.username)}${reseller.enabled ? '' : ` <span class="badge badge-danger">${icon('power')} Disabled</span>`}</h1>
        <p class="muted">reseller account</p></div>
    </div>
    <div class="stats-row">
      ${statCard(reseller.credits, 'Credits', 'key', 'accent')}
      ${statCard(reseller.keys, 'Keys created', 'circle-check')}
      ${statCard(reseller.scripts, 'Scripts', 'code')}
    </div>

    <div class="panel"><div class="panel-head"><h2>${icon('key')} Credits</h2></div>
      <div class="panel-body"><div class="form-actions" style="margin:0">
        <input id="credAmount" type="number" value="10" style="max-width:140px" />
        <button class="btn btn-primary" data-action="add-credits" data-id="${id}">${icon('plus')} Add credits</button>
        <span class="muted">Negative amount removes credits.</span>
      </div></div></div>

    <div class="panel"><div class="panel-head"><h2>${icon('code')} Assigned scripts</h2></div>
      <div class="panel-body">
        <div class="chips">${chips}</div>
        ${unassigned.length ? `<div class="form-actions" style="margin-top:16px">
          <select id="assignScript" style="max-width:260px">${options}</select>
          <button class="btn" data-action="assign-script" data-id="${id}">Assign</button></div>` : ''}
      </div></div>

    <div class="panel"><div class="panel-head"><h2>${icon('settings')} Account</h2></div>
      <div class="panel-body">
        <div class="form-grid">
          <div class="full check"><input type="checkbox" id="resEnabled" ${reseller.enabled ? 'checked' : ''} data-action="toggle-enabled" data-id="${id}" />
            <label style="margin:0">Enabled (login allowed)</label></div>
          <div><label>Reset password</label><input id="resPass" type="password" placeholder="new password" /></div>
          <div style="display:flex;align-items:flex-end"><button class="btn" data-action="reset-reseller-pass" data-id="${id}">${icon('check')} Set password</button></div>
        </div>
        <div class="form-actions"><span class="spacer"></span>
          <button class="btn btn-danger" data-action="delete-reseller" data-id="${id}" data-name="${esc(reseller.username)}">${icon('trash')} Delete reseller</button></div>
      </div></div>
  `;
}

async function addCredits(id) {
  const amount = parseInt($('#credAmount').value, 10) || 0;
  try { await api(`/api/v1/resellers/${id}/credits`, { method: 'POST', body: { amount } }); toast('Credits updated', 'ok'); renderResellerDetail(id); }
  catch (e) { toast(e.message, 'err'); }
}
async function assignScript(id) {
  const scriptId = $('#assignScript') && $('#assignScript').value;
  if (!scriptId) return;
  try { await api(`/api/v1/resellers/${id}/scripts`, { method: 'POST', body: { script_id: scriptId } }); toast('Script assigned', 'ok'); renderResellerDetail(id); }
  catch (e) { toast(e.message, 'err'); }
}
async function unassignScript(id, scriptId) {
  try { await api(`/api/v1/resellers/${id}/scripts/${scriptId}`, { method: 'DELETE' }); toast('Unassigned', 'ok'); renderResellerDetail(id); }
  catch (e) { toast(e.message, 'err'); }
}
async function toggleResellerEnabled(id, enabled) {
  try { await api(`/api/v1/resellers/${id}`, { method: 'PATCH', body: { enabled } }); toast(enabled ? 'Enabled' : 'Disabled', 'ok'); }
  catch (e) { toast(e.message, 'err'); renderResellerDetail(id); }
}
async function resetResellerPass(id) {
  const password = $('#resPass').value;
  if (password.length < 6) { toast('Password too short (min 6)', 'err'); return; }
  try { await api(`/api/v1/resellers/${id}`, { method: 'PATCH', body: { password } }); toast('Password updated', 'ok'); $('#resPass').value = ''; }
  catch (e) { toast(e.message, 'err'); }
}
async function deleteReseller(id, name) {
  if (!confirm(`Delete reseller "${name}"? Their keys are kept but unlinked.`)) return;
  try { await api(`/api/v1/resellers/${id}`, { method: 'DELETE' }); toast('Reseller deleted', 'ok'); location.hash = '#/resellers'; }
  catch (e) { toast(e.message, 'err'); }
}

/* ===================== reseller panel (reseller role) ===================== */

let resellerSelectedScript = null;

async function renderResellerPanel() {
  setActiveNav('panel');
  state.refresh = renderResellerPanel;
  view().innerHTML = '<div class="loading">Loading…</div>';
  let me;
  try { me = await api('/api/v1/reseller/me'); }
  catch (e) { view().innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  state.credits = me.credits;

  if (!me.scripts.length) {
    view().innerHTML = `
      <div class="page-head"><div><h1>My Panel</h1><p class="muted">Generate & manage your keys</p></div></div>
      <div class="stats-row">${statCard(me.credits, 'Credits', 'key', 'accent')}</div>
      <div class="empty">No scripts assigned yet. Ask the admin to assign a script to your account.</div>`;
    return;
  }

  if (!resellerSelectedScript || !me.scripts.find((s) => s.id === resellerSelectedScript)) {
    resellerSelectedScript = me.scripts[0].id;
  }
  const sel = resellerSelectedScript;

  let keys = [];
  try { ({ keys } = await api(`/api/v1/reseller/keys?script_id=${encodeURIComponent(sel)}`)); } catch {}
  currentKeys = keys;

  const snippet = `script_key = "YOUR_KEY_HERE";\nloadstring(game:HttpGet("${location.origin}/loader/${sel}.lua"))()`;
  const opts = me.scripts.map((s) => `<option value="${esc(s.id)}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)} (v${esc(s.version)})</option>`).join('');

  view().innerHTML = `
    <div class="page-head">
      <div><h1>My Panel</h1><p class="muted">Signed in as ${esc(state.username)}</p></div>
    </div>
    <div class="stats-row">${statCard(me.credits, 'Credits', 'key', 'accent')}${statCard(currentKeys.length, 'Your keys', 'circle-check')}</div>

    <div class="panel">
      <div class="panel-head"><h2>${icon('code')} Script &amp; loader</h2>
        <select id="rScript" style="max-width:260px">${opts}</select></div>
      <pre class="snippet">${esc(snippet)}</pre>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>${icon('key')} Keys (${currentKeys.length})</h2>
        <div class="panel-actions">
          <input id="keySearch" placeholder="Search key / note / HWID" />
          <button class="btn btn-primary btn-sm" data-action="reseller-gen">${icon('plus')} Generate</button>
        </div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Key</th><th>Status</th><th>HWID</th><th>Expires</th><th>Execs</th><th>Last seen</th><th></th></tr></thead>
        <tbody id="keysBody"></tbody></table></div>
    </div>
  `;
  renderKeyRows(currentKeys);
  $('#keySearch').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    renderKeyRows(currentKeys.filter((k) => [k.value, k.note, k.hwid].some((v) => v && String(v).toLowerCase().includes(q))));
  });
  $('#rScript').addEventListener('change', (e) => { resellerSelectedScript = e.target.value; renderResellerPanel(); });
}

function openResellerGenModal() {
  openModal('Generate keys',
    `<p class="muted" style="margin:0">Balance: <b>${state.credits}</b> credits · 1 credit per key</p>
     <div class="form-grid">
       <div><label>How many</label><input id="rgCount" type="number" value="1" min="1" max="1000" /></div>
       <div><label>Expires in (days, 0 = lifetime)</label><input id="rgDays" type="number" value="0" min="0" /></div>
       <div class="full"><label>Note (optional)</label><input id="rgNote" placeholder="customer name…" /></div>
     </div>`,
    `<button class="btn" data-action="modal-close">Cancel</button>
     <button class="btn btn-primary" data-action="reseller-do-gen">${icon('key')} Generate</button>`);
}

async function resellerDoGen() {
  const count = parseInt($('#rgCount').value, 10) || 1;
  const days = parseInt($('#rgDays').value, 10) || 0;
  const note = $('#rgNote').value.trim();
  try {
    const { keys, credits } = await api('/api/v1/reseller/keys', {
      method: 'POST',
      body: { script_id: resellerSelectedScript, count, expiresInDays: days > 0 ? days : null, note },
    });
    state.credits = credits;
    const values = keys.map((k) => k.value);
    openModal(`${keys.length} key(s) generated · ${credits} credits left`,
      `<div class="keys-output">${values.map((v) => `<div>${esc(v)}</div>`).join('')}</div>`,
      `<button class="btn btn-primary" data-action="copy" data-copy="${esc(values.join('\n'))}">${icon('copy')} Copy all</button>
       <button class="btn" data-action="modal-close-refresh">${icon('check')} Done</button>`);
  } catch (err) { toast(err.message, 'err'); }
}

/* ===================== global click delegation ===================== */

document.addEventListener('click', (e) => {
  // row / chip shortcuts (not data-action)
  const openR = e.target.closest('[data-open-reseller]');
  if (openR) { location.hash = `#/resellers/${openR.dataset.openReseller}`; return; }
  const unassignEl = e.target.closest('[data-unassign]');
  if (unassignEl) { unassignScript(state.resellerDetailId, unassignEl.dataset.unassign); return; }

  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;

  switch (action) {
    case 'new-script': openNewScriptModal(); break;
    case 'create-script': createScript(); break;
    case 'gen-keys': openGenKeysModal(); break;
    case 'do-gen-keys': doGenKeys(); break;
    case 'copy': copy(t.dataset.copy); break;
    case 'export-csv': if (currentScript) window.location.href = `/api/v1/scripts/${currentScript.id}/keys.csv`; break;
    case 'modal-close': closeModal(); break;
    case 'modal-backdrop': if (e.target === t) closeModal(); break;
    case 'modal-close-refresh': closeModal(); if (state.refresh) state.refresh(); break;
    case 'delete-script':
      if (currentScript && confirm(`Delete "${currentScript.name}" and ALL its keys? This cannot be undone.`)) {
        api(`/api/v1/scripts/${currentScript.id}`, { method: 'DELETE' })
          .then(() => { toast('Script deleted', 'ok'); location.hash = '#/'; })
          .catch((err) => toast(err.message, 'err'));
      }
      break;
    // resellers (admin)
    case 'new-reseller': openNewResellerModal(); break;
    case 'create-reseller': createReseller(); break;
    case 'add-credits': addCredits(t.dataset.id); break;
    case 'assign-script': assignScript(t.dataset.id); break;
    case 'toggle-enabled': toggleResellerEnabled(t.dataset.id, t.checked); break;
    case 'reset-reseller-pass': resetResellerPass(t.dataset.id); break;
    case 'delete-reseller': deleteReseller(t.dataset.id, t.dataset.name); break;
    // reseller panel
    case 'reseller-gen': openResellerGenModal(); break;
    case 'reseller-do-gen': resellerDoGen(); break;
    default:
      if (action.startsWith('key-')) keyAction(action, t.dataset.id);
  }
});

/* ===================== start ===================== */
hydrateIcons(); // static icons in index.html (nav, logout, login fields)
boot();
