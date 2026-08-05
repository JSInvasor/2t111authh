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
  if (!sec) return '<span class="dim">—</span>';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtExpiry(sec) {
  if (!sec) return `<span class="badge">${icon('infinity')} Lifetime</span>`;
  const expired = sec * 1000 < Date.now();
  return expired
    ? `<span class="pill pill-expired">${icon('clock')} expired</span>`
    : fmtDate(sec);
}
/** 1234 → "1,234" (kept short so stat tiles never wrap) */
function fmtNum(n) {
  const v = Number(n);
  if (!isFinite(v)) return esc(n);
  return v.toLocaleString('en-US');
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  const ico = kind === 'ok' ? 'circle-check' : kind === 'err' ? 'circle-alert' : 'info';
  t.innerHTML = `${icon(ico)}<span>${esc(msg)}</span>`;
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
  'layout-dashboard':
    '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  key: '<path d="m15.5 7.5 3 3L22 7l-3-3"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  'key-round':
    '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'log-out': '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  'power-off':
    '<path d="M18.36 6.64A9 9 0 0 1 20.77 15"/><path d="M6.16 6.16a9 9 0 1 0 12.68 12.68"/><path d="M12 2v4"/><path d="m2 2 20 20"/>',
  pause: '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  'circle-user':
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>',
  'lock-keyhole':
    '<circle cx="12" cy="16" r="1"/><rect width="18" height="12" x="3" y="10" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'user-plus':
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  activity:
    '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  fingerprint:
    '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>',
  'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  'circle-x': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  'circle-alert': '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  'sliders-horizontal':
    '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  code: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  'shield-check':
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  coins:
    '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  infinity:
    '<path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z"/>',
  package:
    '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  'chart-column': '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  'triangle-alert':
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  /* Discord's own mark — a filled brand glyph, so it opts out of the stroke
     rendering every other icon here uses (see SOLID_ICONS). */
  discord: '<path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
};

/** Brand glyphs are filled shapes, not outlines — they need the inverse of
 *  the stroke setup the Lucide icons use. */
const SOLID_ICONS = new Set(['discord']);

function icon(name, cls = '') {
  const solid = SOLID_ICONS.has(name);
  const paint = solid ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor"';
  return `<svg class="ico ico-${name} ${cls}" viewBox="0 0 24 24" ${paint} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
    el.classList.add('ico-slot');
    el.removeAttribute('data-icon');
  });
}

/* ===================== small components ===================== */

function statCard(num, label, ico, cls = '') {
  return `<div class="stat ${cls}">
    <span class="stat-ico">${icon(ico)}</span>
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${fmtNum(num)}</div>
  </div>`;
}

/* Checkbox row. The box is adapted from Uiverse.io "checkbox-46" by
   vishnupprajapat (MIT) — the tick strokes itself in and a ring pulses out. */
const CHECK_SVG = '<svg viewBox="0 0 12 10" aria-hidden="true"><polyline points="1.5 6 4.5 9 10.5 1"/></svg>';

function checkRow(id, title, desc, checked, { cls = '', attrs = '' } = {}) {
  return `<div class="check ${cls}">
    <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${attrs} />
    <label for="${id}"><span class="cbx">${CHECK_SVG}</span><span><b>${esc(title)}</b>${esc(desc)}</span></label>
  </div>`;
}

function emptyState(ico, title, text) {
  return `<div class="empty">
    <div class="empty-ico">${icon(ico)}</div>
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
  </div>`;
}

function errorState(msg) {
  return `<div class="empty">
    <div class="empty-ico">${icon('triangle-alert')}</div>
    <h3>Something went wrong</h3>
    <p>${esc(msg)}</p>
  </div>`;
}

function skeleton() {
  return `<div class="skeleton">
    <div class="sk sk-head"></div>
    <div class="sk sk-row"></div>
    <div class="sk sk-panel"></div>
  </div>`;
}

/** Loader snippet: plain text for copying, lightly coloured for display. */
function snippetHTML(text) {
  return esc(text).replace(/&quot;(.*?)&quot;/g, '<span class="k">&quot;$1&quot;</span>');
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

/** Column chart: full bar = attempts, filled part = successes. */
function execChart(days) {
  const max = Math.max(1, ...days.map((d) => d.total));
  const cols = days
    .map((d) => {
      const at = new Date(d.day * 86400 * 1000);
      const h = (d.total / max) * 100;
      const ok = d.total ? (d.successes / d.total) * 100 : 0;
      const tip = `${at.toLocaleDateString()} · ${d.total} run${d.total === 1 ? '' : 's'}, ${d.successes} ok`;
      return `<div class="chart-col" title="${esc(tip)}">
        <div class="chart-slot">
          <div class="chart-bar" style="height:${Math.max(h, 1.5).toFixed(1)}%"><i style="height:${ok.toFixed(1)}%"></i></div>
        </div>
        <span class="chart-day">${esc(at.toLocaleDateString(undefined, { weekday: 'short' }))}</span>
      </div>`;
    })
    .join('');
  return `<div class="chart">${cols}</div>
    <div class="chart-legend">
      <span><i class="sw-ok"></i> Successful</span>
      <span><i class="sw-all"></i> All attempts</span>
    </div>`;
}

/* ===================== theme ===================== */

const THEME_KEY = '2t1auth.theme';

function storedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function resolvedTheme() {
  const s = storedTheme();
  if (s === 'light' || s === 'dark') return s;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Only pins the attribute once the user picks a side — otherwise the CSS
 *  media query keeps following the OS. */
function paintThemeButton() {
  const btn = $('#themeBtn');
  if (!btn) return;
  const dark = resolvedTheme() === 'dark';
  btn.innerHTML = icon(dark ? 'sun' : 'moon');
  btn.title = dark ? 'Switch to light' : 'Switch to dark';
}

function toggleTheme() {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  document.documentElement.dataset.theme = next;
  paintThemeButton();
}

function initTheme() {
  const s = storedTheme();
  if (s === 'light' || s === 'dark') document.documentElement.dataset.theme = s;
  paintThemeButton();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!storedTheme()) paintThemeButton();
  });
}

/* ===================== mobile nav ===================== */

function closeNav() { document.body.classList.remove('nav-open'); }

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
  closeNav();
}

function showApp(me) {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#whoami').innerHTML = `
    <span class="avatar">${esc((me.username || '?').slice(0, 1))}</span>
    <span class="whoami-meta">
      <span class="whoami-name">${esc(me.username)}</span>
      <span class="whoami-role">${esc(me.role === 'reseller' ? 'Reseller' : 'Administrator')}</span>
    </span>`;
  const nav = $('#nav');
  if (me.role === 'reseller') {
    nav.innerHTML = `<a href="#/" class="nav-item active" data-nav="panel">${icon('key-round')} My Keys</a>`;
  } else {
    nav.innerHTML =
      `<a href="#/" class="nav-item" data-nav="dashboard">${icon('layout-dashboard')} Dashboard</a>` +
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
  const btn = $('.login-submit');
  errEl.textContent = '';
  btn.disabled = true;
  try {
    await api('/dashboard/api/login', { method: 'POST', body: { username, password } });
    $('#loginPass').value = '';
    boot();
  } catch (err) {
    errEl.innerHTML = `${icon('circle-alert')}<span>${esc(err.message || 'Login failed')}</span>`;
  } finally {
    btn.disabled = false;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/dashboard/api/logout', { method: 'POST' }); } catch {}
  showLogin();
});

$('#themeBtn').addEventListener('click', toggleTheme);
$('#menuBtn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
$('#scrim').addEventListener('click', closeNav);

/* ===================== router ===================== */

window.addEventListener('hashchange', () => { closeNav(); route(); });

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
  view().innerHTML = skeleton();
  let scripts, ov;
  try {
    [{ scripts }, { overview: ov }] = await Promise.all([
      api('/api/v1/scripts'),
      api('/api/v1/overview'),
    ]);
  } catch (e) { view().innerHTML = errorState(e.message); return; }

  const t = ov.totals;
  const overviewRow = `
    <div class="stats-row">
      ${statCard(t.executions_24h, 'Executions · 24h', 'activity', 'accent')}
      ${statCard(t.active_users_24h, 'Active users · 24h', 'users')}
      ${statCard(t.scripts, 'Scripts', 'code')}
      ${statCard(t.keys, 'Total keys', 'key-round')}
      ${statCard(t.active_keys, 'Active keys', 'circle-check', 'ok')}
      ${statCard(t.bound_keys, 'HWID-bound', 'fingerprint')}
    </div>`;

  const cards = scripts.map((s) => `
    <a class="card script-card" href="#/s/${esc(s.id)}">
      <div class="card-top">
        <h3>${esc(s.name)}</h3>
        <span class="badge badge-mono">v${esc(s.version)}</span>
      </div>
      <div class="card-meta">
        <span>${icon('key-round')} <b>${fmtNum(s.key_count)}</b> keys</span>
        <span>${icon('circle-check')} <b>${fmtNum(s.active_keys)}</b> active</span>
        ${s.obfuscate ? `<span title="Obfuscated on delivery">${icon('shield-check')} protected</span>` : ''}
        ${s.enabled ? '' : `<span class="ico-danger" title="Disabled">${icon('power-off')} disabled</span>`}
      </div>
      <code class="card-id">${esc(s.id)}</code>
      <span class="go">${icon('chevron-right')}</span>
    </a>`).join('');

  view().innerHTML = `
    <div class="page-head">
      <div><h1>Overview</h1><p class="muted">Your projects, keys and live activity</p></div>
      <button class="btn btn-primary" data-action="new-script">${icon('plus')} New script</button>
    </div>
    ${overviewRow}
    <h2 class="section">${icon('package')} Scripts <span class="count">${scripts.length}</span></h2>
    ${scripts.length ? `<div class="grid">${cards}</div>`
      : emptyState('package', 'No scripts yet', 'Create your first script to get a loader and start issuing keys.')}
  `;
}

/* ===================== script detail ===================== */

let currentKeys = [];
let currentScript = null;

async function renderScriptDetail(id) {
  setActiveNav('dashboard');
  state.refresh = () => renderScriptDetail(id);
  view().innerHTML = skeleton();

  let script, stats, keys;
  try {
    [{ script }, { stats }, { keys }] = await Promise.all([
      api(`/api/v1/scripts/${id}`),
      api(`/api/v1/scripts/${id}/stats?days=7`),
      api(`/api/v1/scripts/${id}/keys?limit=1000`),
    ]);
  } catch (e) { view().innerHTML = errorState(e.message); return; }

  currentScript = script;
  currentKeys = keys;
  const ex = stats.executions;
  const kc = stats.keys;
  const snippet = `script_key = "YOUR_KEY_HERE";\nloadstring(game:HttpGet("${location.origin}/loader/${script.id}.lua"))()`;

  view().innerHTML = `
    <a class="back" href="#/">${icon('arrow-left')} Scripts</a>
    <div class="page-head">
      <div>
        <h1>${esc(script.name)}
          <span class="badge badge-mono">v${esc(script.version)}</span>
          ${script.obfuscate ? `<span class="badge badge-accent">${icon('shield-check')} Protected</span>` : ''}
          ${script.enabled ? '' : `<span class="badge badge-danger">${icon('power-off')} Disabled</span>`}
        </h1>
        <p class="muted mono">${esc(script.id)}</p>
      </div>
      <button class="btn btn-primary" data-action="gen-keys">${icon('plus')} Generate keys</button>
    </div>

    <div class="stats-row">
      ${statCard(ex.total, 'Executions · 7d', 'activity', 'accent')}
      ${statCard(ex.unique_hwids, 'Unique HWIDs', 'fingerprint')}
      ${statCard(ex.successes, 'Successful', 'circle-check', 'ok')}
      ${statCard(ex.failures, 'Failed', 'circle-x', 'bad')}
      ${statCard(kc.total, 'Total keys', 'key-round')}
      ${statCard(kc.active, 'Active', 'check')}
      ${statCard(kc.bound, 'HWID-bound', 'lock')}
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>${icon('chart-column')} Executions <span class="sub">last ${stats.window_days} days</span></h2>
      </div>
      <div class="panel-body">${execChart(fillDaily(stats.daily, stats.window_days))}</div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>${icon('terminal')} Loader</h2>
        <button class="btn btn-sm" data-action="copy" data-copy="${esc(snippet)}">${icon('copy')} Copy snippet</button>
      </div>
      <pre class="snippet">${snippetHTML(snippet)}</pre>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>${icon('key-round')} Keys <span class="sub">${fmtNum(currentKeys.length)}</span></h2>
        <div class="panel-actions">
          <div class="input-wrap">
            <span data-icon="search"></span>
            <input id="keySearch" placeholder="Search key, note or HWID" />
          </div>
          <button class="btn btn-sm" data-action="export-csv">${icon('download')} CSV</button>
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
      <div class="panel-head"><h2>${icon('sliders-horizontal')} Settings</h2></div>
      <div class="panel-body">
        <form id="settingsForm">
          <div class="form-grid">
            <div><label for="setName">Name</label><input id="setName" value="${esc(script.name)}" /></div>
            <div><label for="setVersion">Version</label><input id="setVersion" value="${esc(script.version)}" /></div>
            ${checkRow('setHwidLock', 'HWID lock', 'Bind each key to the first device it runs on.', script.hwid_lock, { cls: 'full' })}
            ${checkRow('setObf', 'Obfuscate & encrypt', 'Re-scramble and encrypt the source on every delivery.', script.obfuscate, { cls: 'full' })}
            ${checkRow('setEnabled', 'Enabled', 'Uncheck for maintenance mode — every auth request is rejected.', script.enabled, { cls: 'full' })}
            <div class="full">
              <label for="setSource">Protected script source (Lua)</label>
              <textarea id="setSource" rows="12" spellcheck="false"></textarea>
            </div>
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

  hydrateIcons(view());
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
    body.innerHTML = `<tr><td colspan="7" class="table-empty">${icon('inbox')} No keys to show</td></tr>`;
    return;
  }
  body.innerHTML = keys.map((k) => {
    const banned = k.status === 'banned';
    const statusIco = k.status === 'banned' ? 'ban' : k.status === 'paused' ? 'pause' : 'circle-check';
    return `<tr>
      <td><code>${esc(k.value)}</code></td>
      <td><span class="pill pill-${esc(k.status)}">${icon(statusIco)} ${esc(k.status)}</span></td>
      <td class="hwid-cell" title="${esc(k.hwid || '')}">${k.hwid ? esc(k.hwid) : '—'}</td>
      <td>${fmtExpiry(k.expires_at)}</td>
      <td>${fmtNum(k.total_executions)}</td>
      <td>${fmtDate(k.last_seen)}</td>
      <td class="row-actions">
        <button class="icon-btn" title="Copy key" data-action="copy" data-copy="${esc(k.value)}">${icon('copy')}</button>
        <button class="icon-btn" title="${banned ? 'Unban' : 'Ban'}" data-action="key-${banned ? 'unban' : 'ban'}" data-id="${k.id}">${icon(banned ? 'check' : 'ban')}</button>
        <button class="icon-btn" title="Reset HWID" data-action="key-reset" data-id="${k.id}">${icon('rotate-ccw')}</button>
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
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><span>${title}</span><button class="icon-btn" title="Close" data-action="modal-close">${icon('x')}</button></div>
        <div class="modal-body">${bodyHTML}</div>
        <div class="modal-foot">${footHTML}</div>
      </div>
    </div>`;
  hydrateIcons($('#modalRoot'));
  const first = $('#modalRoot input, #modalRoot textarea, #modalRoot select');
  if (first) first.focus();
}

function openNewScriptModal() {
  openModal(
    'New script',
    `<div class="form-grid">
       <div><label for="nsName">Name</label><input id="nsName" placeholder="My Hub" /></div>
       <div><label for="nsVersion">Version</label><input id="nsVersion" value="1.0.0" /></div>
     </div>
     ${checkRow('nsHwid', 'HWID lock', 'Bind each key to one device.', true)}
     ${checkRow('nsObf', 'Obfuscate & encrypt', 'Protect the source on every delivery.', true)}
     <div><label for="nsSource">Script source (Lua, optional)</label>
       <textarea id="nsSource" rows="6" spellcheck="false" placeholder='print("hello")'></textarea></div>`,
    `<button class="btn" data-action="modal-close">Cancel</button>
     <button class="btn btn-primary" data-action="create-script">${icon('plus')} Create script</button>`
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
       <div><label for="gkCount">How many</label><input id="gkCount" type="number" value="1" min="1" max="1000" /></div>
       <div><label for="gkDays">Expires in (days · 0 = lifetime)</label><input id="gkDays" type="number" value="0" min="0" /></div>
       <div class="full"><label for="gkNote">Note (optional)</label><input id="gkNote" placeholder="e.g. October batch" /></div>
     </div>`,
    `<button class="btn" data-action="modal-close">Cancel</button>
     <button class="btn btn-primary" data-action="do-gen-keys">${icon('key-round')} Generate</button>`
  );
}

function keysResultModal(title, values) {
  openModal(
    title,
    `<div class="keys-output">${values.map((v) => `<div>${esc(v)}</div>`).join('')}</div>`,
    `<button class="btn btn-primary" data-action="copy" data-copy="${esc(values.join('\n'))}">${icon('copy')} Copy all</button>
     <button class="btn" data-action="modal-close-refresh">${icon('check')} Done</button>`
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
    keysResultModal(`${keys.length} key${keys.length === 1 ? '' : 's'} generated`, keys.map((k) => k.value));
  } catch (err) { toast(err.message, 'err'); }
}

/* ===================== resellers (admin) ===================== */

async function renderResellers() {
  setActiveNav('resellers');
  state.refresh = renderResellers;
  view().innerHTML = skeleton();
  let resellers;
  try { ({ resellers } = await api('/api/v1/resellers')); }
  catch (e) { view().innerHTML = errorState(e.message); return; }

  const rows = resellers.map((r) => `
    <tr data-open-reseller="${r.id}" style="cursor:pointer">
      <td><b>${esc(r.username)}</b></td>
      <td>${fmtNum(r.credits)}</td>
      <td>${fmtNum(r.scripts)}</td>
      <td>${fmtNum(r.keys)}</td>
      <td>${r.enabled
        ? `<span class="pill pill-active">${icon('circle-check')} active</span>`
        : `<span class="pill pill-banned">${icon('ban')} disabled</span>`}</td>
      <td class="row-actions"><button class="icon-btn" title="Manage" data-open-reseller="${r.id}">${icon('chevron-right')}</button></td>
    </tr>`).join('');

  view().innerHTML = `
    <div class="page-head">
      <div><h1>Resellers</h1><p class="muted">Sub-accounts that spend credits to issue keys</p></div>
      <button class="btn btn-primary" data-action="new-reseller">${icon('user-plus')} New reseller</button>
    </div>
    ${resellers.length ? `<div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>Username</th><th>Credits</th><th>Scripts</th><th>Keys</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`
      : emptyState('users', 'No resellers yet', 'Create one to delegate key generation without sharing admin access.')}
  `;
}

function openNewResellerModal() {
  openModal('New reseller',
    `<div><label for="nrUser">Username</label><input id="nrUser" placeholder="reseller1" autocapitalize="none" spellcheck="false" /></div>
     <div><label for="nrPass">Password</label><input id="nrPass" type="password" placeholder="min. 6 characters" /></div>
     <div><label for="nrCredits">Starting credits</label><input id="nrCredits" type="number" value="0" min="0" /></div>`,
    `<button class="btn" data-action="modal-close">Cancel</button>
     <button class="btn btn-primary" data-action="create-reseller">${icon('user-plus')} Create</button>`);
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
  view().innerHTML = skeleton();
  let reseller, assigned, allScripts;
  try {
    [{ reseller, scripts: assigned }, { scripts: allScripts }] = await Promise.all([
      api(`/api/v1/resellers/${id}`),
      api('/api/v1/scripts'),
    ]);
  } catch (e) { view().innerHTML = errorState(e.message); return; }

  const assignedIds = new Set(assigned.map((s) => s.id));
  const unassigned = allScripts.filter((s) => !assignedIds.has(s.id));
  const chips = assigned.length
    ? assigned.map((s) => `<div class="chip">${esc(s.name)} <button class="chip-x" title="Unassign" data-unassign="${esc(s.id)}">${icon('x')}</button></div>`).join('')
    : '<span class="hint">No scripts assigned yet.</span>';
  const options = unassigned.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');

  view().innerHTML = `
    <a class="back" href="#/resellers">${icon('arrow-left')} Resellers</a>
    <div class="page-head">
      <div>
        <h1>${esc(reseller.username)}
          ${reseller.enabled ? '' : `<span class="badge badge-danger">${icon('power-off')} Disabled</span>`}
        </h1>
        <p class="muted">Reseller account</p>
      </div>
    </div>

    <div class="stats-row">
      ${statCard(reseller.credits, 'Credits', 'coins', 'accent')}
      ${statCard(reseller.keys, 'Keys created', 'key-round')}
      ${statCard(reseller.scripts, 'Scripts', 'package')}
    </div>

    <div class="panel">
      <div class="panel-head"><h2>${icon('coins')} Credits</h2></div>
      <div class="panel-body">
        <div class="form-actions" style="margin:0">
          <input id="credAmount" type="number" value="10" style="max-width:130px" />
          <button class="btn btn-primary" data-action="add-credits" data-id="${id}">${icon('plus')} Add credits</button>
          <span class="hint">A negative amount removes credits.</span>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>${icon('package')} Assigned scripts</h2></div>
      <div class="panel-body">
        <div class="chips">${chips}</div>
        ${unassigned.length ? `<div class="form-actions">
          <select id="assignScript" style="max-width:260px">${options}</select>
          <button class="btn" data-action="assign-script" data-id="${id}">${icon('plus')} Assign</button></div>` : ''}
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>${icon('settings')} Account</h2></div>
      <div class="panel-body">
        ${checkRow('resEnabled', 'Enabled', 'Allow this account to sign in.', reseller.enabled, {
          attrs: `data-action="toggle-enabled" data-id="${id}"`,
        })}
        <div class="form-grid" style="margin-top:14px">
          <div><label for="resPass">Reset password</label><input id="resPass" type="password" placeholder="new password" /></div>
          <div style="display:flex;align-items:flex-end">
            <button class="btn" data-action="reset-reseller-pass" data-id="${id}">${icon('check')} Set password</button>
          </div>
        </div>
        <div class="form-actions"><span class="spacer"></span>
          <button class="btn btn-danger" data-action="delete-reseller" data-id="${id}" data-name="${esc(reseller.username)}">${icon('trash')} Delete reseller</button>
        </div>
      </div>
    </div>
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
  view().innerHTML = skeleton();
  let me;
  try { me = await api('/api/v1/reseller/me'); }
  catch (e) { view().innerHTML = errorState(e.message); return; }
  state.credits = me.credits;

  if (!me.scripts.length) {
    view().innerHTML = `
      <div class="page-head"><div><h1>My panel</h1><p class="muted">Generate and manage your keys</p></div></div>
      <div class="stats-row">${statCard(me.credits, 'Credits', 'coins', 'accent')}</div>
      ${emptyState('package', 'No scripts assigned', 'Ask the admin to assign a script to your account before generating keys.')}`;
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
      <div><h1>My panel</h1><p class="muted">Signed in as ${esc(state.username)}</p></div>
      <button class="btn btn-primary" data-action="reseller-gen">${icon('plus')} Generate keys</button>
    </div>

    <div class="stats-row">
      ${statCard(me.credits, 'Credits', 'coins', 'accent')}
      ${statCard(currentKeys.length, 'Your keys', 'key-round')}
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>${icon('terminal')} Script &amp; loader</h2>
        <div class="panel-actions">
          <select id="rScript" style="max-width:240px">${opts}</select>
          <button class="btn btn-sm" data-action="copy" data-copy="${esc(snippet)}">${icon('copy')} Copy</button>
        </div>
      </div>
      <pre class="snippet">${snippetHTML(snippet)}</pre>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>${icon('key-round')} Keys <span class="sub">${fmtNum(currentKeys.length)}</span></h2>
        <div class="panel-actions">
          <div class="input-wrap">
            <span data-icon="search"></span>
            <input id="keySearch" placeholder="Search key, note or HWID" />
          </div>
          <button class="btn btn-primary btn-sm" data-action="reseller-gen">${icon('plus')} Generate</button>
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Key</th><th>Status</th><th>HWID</th><th>Expires</th><th>Execs</th><th>Last seen</th><th></th></tr></thead>
        <tbody id="keysBody"></tbody></table></div>
    </div>
  `;
  hydrateIcons(view());
  renderKeyRows(currentKeys);
  $('#keySearch').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    renderKeyRows(currentKeys.filter((k) => [k.value, k.note, k.hwid].some((v) => v && String(v).toLowerCase().includes(q))));
  });
  $('#rScript').addEventListener('change', (e) => { resellerSelectedScript = e.target.value; renderResellerPanel(); });
}

function openResellerGenModal() {
  openModal('Generate keys',
    `<p class="hint" style="margin:0">Balance: <b>${fmtNum(state.credits)}</b> credits · 1 credit per key</p>
     <div class="form-grid">
       <div><label for="rgCount">How many</label><input id="rgCount" type="number" value="1" min="1" max="1000" /></div>
       <div><label for="rgDays">Expires in (days · 0 = lifetime)</label><input id="rgDays" type="number" value="0" min="0" /></div>
       <div class="full"><label for="rgNote">Note (optional)</label><input id="rgNote" placeholder="customer name…" /></div>
     </div>`,
    `<button class="btn" data-action="modal-close">Cancel</button>
     <button class="btn btn-primary" data-action="reseller-do-gen">${icon('key-round')} Generate</button>`);
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
    keysResultModal(`${keys.length} key${keys.length === 1 ? '' : 's'} generated · ${fmtNum(credits)} credits left`, keys.map((k) => k.value));
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); closeNav(); }
});

/* ===================== start ===================== */
initTheme();
hydrateIcons(); // static icons in index.html (nav, logout, login fields)
boot();
