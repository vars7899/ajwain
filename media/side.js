// The sidebar's Home view: your day at a glance, a way into each board view, the running timer, and your open
// issues with one-click actions. Same host protocol as the board: host(method, ...args) → the extension.
import { fmtDuration, streak, issuesWhere, PRIORITIES } from '../pm.mjs';
import { icon, mascot } from './icons.mjs';
import { workdayBox, tickWorkday } from './workday.mjs';

const vsc = acquireVsCodeApi();
const pending = new Map();
let seq = 0;
const host = (method, ...args) => new Promise((resolve, reject) => {
  pending.set(++seq, { resolve, reject });
  vsc.postMessage({ id: seq, method, args });
});
const api = (path, opts) => host('req', path, opts);
const list = (d) => (Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : []);
const idOf = (v) => (v && typeof v === 'object' ? v.id : v);
const norm = (i) => {
  if (i.status && typeof i.status === 'object') i.status_detail ??= i.status;
  for (const k of ['status', 'sprint', 'project']) i[k] = idOf(i[k]);
  return i;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const same = (a, b) => String(a ?? '') === String(b ?? '');
const cap = (s) => (s ? s[0] + s.slice(1).toLowerCase().replace(/_/g, ' ') : '');
const $ = (s) => document.querySelector(s);
const ic = (name, size = 14, ink) => icon(name, { size, ink });
const today = () => new Date().toLocaleDateString('en-CA');
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
const dayOf = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00`);
const fmtDate = (d) => (d ? dayOf(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const report = (where, e) => host('log', `side ${where}: ${e?.stack ?? e?.message ?? e}`).catch(() => {});
window.addEventListener('error', (e) => report('error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => report('unhandled', e.reason));

const S = {
  me: null, workspace: null, scope: null, projects: [], issues: [], statuses: {}, sprints: {}, timer: null,
  q: '', loading: true, error: '', events: [], commits: 0, shut: vsc.getState()?.shut ?? {}, loadedAt: 0,
};

window.addEventListener('message', ({ data }) => {
  if (data.id) {
    const p = pending.get(data.id);
    pending.delete(data.id);
    return data.error ? p?.reject(new Error(data.error)) : p?.resolve(data.result);
  }
  if (['refresh', 'reinit', 'scope'].includes(data.type)) start();
  // You came back, or it's been a while: reload if what's shown is stale and you're not typing in the filter.
  if (data.type === 'wake' && S.me && Date.now() - S.loadedAt > 30e3 && document.activeElement?.id !== 'q') start();
  if (data.type === 'timer') { S.timer = data.timer; render(); }
  if (data.type === 'attendance') { S.att = data.attendance; render(); }
  if (data.type === 'journal') host('journal').then((j) => { S.events = j?.events ?? S.events; render(); }).catch(() => {});
});

// ---------- data ----------
const statusesFor = async (pid) => (S.statuses[pid] ??= list(await api(`/api/projects/${pid}/statuses/`).catch(() => [])));
const sprintsFor = async (pid) => (S.sprints[pid] ??= list(await api(`/api/sprints/?project=${pid}`).catch(() => [])));
const pages = async (q) => (await issuesWhere(api, q)).map(norm);
async function init() {
  try {
    const { me, workspace, project, timer } = await host('init');
    S.att = await host('attendance').catch(() => null);
    Object.assign(S, { me, workspace, scope: project ?? null, timer, error: '', statuses: {}, sprints: {} });
    if (me) {
      const [projects, issues, journal, commits] = await Promise.all([
        api(`/api/projects/?workspace=${workspace}`).then(list),
        pages(new URLSearchParams({ workspace, assignee: me.id, open: 'true' })),
        host('journal').catch(() => null),
        host('todayCommits').catch(() => []),
      ]);
      S.projects = projects.filter((p) => !p.workspace || same(idOf(p.workspace), workspace));
      if (!S.projects.some((p) => same(p.id, S.scope))) S.scope = null;
      S.issues = issues;
      S.events = journal?.events ?? [];
      S.commits = commits.length;
      await Promise.all([...new Set(issues.map((i) => i.project)), ...(S.scope ? [S.scope] : [])].flatMap((pid) => [statusesFor(pid), sprintsFor(pid)]));
    }
  } catch (e) {
    S.error = e.message;
  }
  S.loading = false;
  S.loadedAt = Date.now();
  render();
}
let again;
const start = () => { clearTimeout(again); again = setTimeout(init, 120); }; // refreshes come in bursts

// ---------- helpers ----------
const statusOf = (i) => (S.statuses[i.project] ?? []).find((s) => same(s.id, i.status)) ?? i.status_detail ?? null;
const catOf = (i) => statusOf(i)?.category ?? 'TODO';
const CAT = { TODO: 'var(--todo)', IN_PROGRESS: 'var(--progress)', DONE: 'var(--done)', NONE: 'var(--none)' };
const colorOf = (s) => (!s?.color ? CAT[s?.category] ?? CAT.NONE : /^(#|rgb|hsl)/.test(s.color) ? s.color : `var(--c-${String(s.color).replace(/[^\w-]/g, '')}, ${CAT[s.category] ?? CAT.NONE})`);
const overdue = (i) => !!i.due_date && String(i.due_date).slice(0, 10) < today();
const dueSoon = (i) => !!i.due_date && !overdue(i) && String(i.due_date).slice(0, 10) <= plusDays(7);
const mine = () => S.issues.filter((i) => !S.scope || same(i.project, S.scope));
const hms = (start) => { const s = Math.max(0, Math.floor((Date.now() - start) / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const keyOfProject = (pid) => S.projects.find((p) => same(p.id, pid))?.key ?? '';
const SKY = { morning: '#F5C451', afternoon: '#F28C28', evening: '#8B5CF6', night: '#3B82F6' };
const skyOf = (h) => (h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'night');
const VIEWS = [['today', 'Today', 'sun'], ['board', 'Board', 'board'], ['list', 'List', 'list'], ['sprints', 'Sprints', 'sprint'], ['mine', 'My work', 'user']];
// Same order as "Up next" on the board: priority, then the nearest due date.
const byUrgency = (a, b) => (overdue(b) - overdue(a)) || PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || String(a.due_date ?? '9').localeCompare(String(b.due_date ?? '9'));

// ---------- render ----------
function render() {
  const keep = $('#q') === document.activeElement;
  document.body.innerHTML = !S.me
    ? (S.loading ? '<div class="side-loading"><div class="skeleton"></div><div class="skeleton"></div></div>' : signedOut())
    : `<div class="side">${hello()}${workdayBox(S.att)}${timerBlock()}${nav()}${pulse()}${issuesBlock()}</div>${dock()}`;
  const q = $('#q');
  if (q) { q.value = S.q; if (keep) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
}

const signedOut = () => `<div class="side-out">${mascot(96, 'wave')}
  <h2>Your tickets live here</h2>
  <p class="muted">Boards, sprints, timers and your day, without leaving the editor.</p>
  ${S.error ? `<p class="danger small">${esc(S.error)}</p>` : ''}
  <button class="btn primary wide" data-act="signin">${ic('user', 14, 'currentColor')}Sign in</button></div>`;

function hello() {
  const xs = mine(), h = new Date().getHours(), part = skyOf(h);
  const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const prog = xs.filter((i) => catOf(i) === 'IN_PROGRESS').length, late = xs.filter(overdue).length;
  const mood = h >= 22 || h < 5 ? 'sleepy' : late ? 'sweat' : prog ? 'wink' : 'happy';
  const cell = (v, label, cls = '') => `<div class="cell ${cls}"><b>${esc(v)}</b><span>${label}</span></div>`;
  return `<section class="hello" style="--sky:${SKY[part]}">
    <div class="hello-top"><span class="label">${esc(new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>
      <select id="scope" data-change="scope" aria-label="Project">${[['', 'All projects'], ...S.projects.map((p) => [p.id, `${p.key} · ${p.name}`])]
        .map(([v, l]) => `<option value="${esc(v)}" ${same(v, S.scope ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <div class="hello-main"><span class="hello-sky">${mascot(44, mood)}</span><div class="grow"><b>${greet}, ${esc(S.me.first_name || S.me.username)}</b>
      <div class="muted small">${S.loading ? 'Loading…' : `${xs.length} open · ${S.commits} commit${S.commits === 1 ? '' : 's'} today`}</div></div></div>
    <div class="cells">${cell(prog, 'Active')}${cell(xs.filter(dueSoon).length, 'Due 7d', 'soon')}${cell(late, 'Overdue', late ? 'late' : '')}${cell(streak(S.events), 'Streak', 'streak')}</div>
  </section>`;
}

const timerBlock = () => (S.timer ? `<section class="now" data-act="open" data-key="${esc(S.timer.key)}" title="Open ${esc(S.timer.key)}">
  <span class="rec"></span><div class="grow"><div class="now-head"><span class="key">${esc(S.timer.key)}</span><span class="now-clock" id="clock">${hms(S.timer.start)}</span></div>
  <div class="now-title">${esc(S.timer.title ?? '')}</div></div>
  <button class="icon-btn now-stop" data-act="timer-stop" title="Stop and log">${ic('stop', 12)}</button></section>` : '');

const nav = () => `<nav class="nav">${VIEWS.map(([v, label, iconName]) => `<button class="tile" data-act="view" data-view="${v}" title="Open ${label}">${ic(iconName, 18)}<span>${label}</span></button>`).join('')}
  <button class="tile lucky" data-act="lucky" title="Let the slot machine pick your next ticket">${ic('dice', 18)}<span>Lucky dip</span></button></nav>`;

function pulse() {
  const sp = S.scope && (S.sprints[S.scope] ?? []).find((s) => s.state === 'ACTIVE');
  if (!sp?.start_date || !sp?.end_date) return '';
  const total = Math.max(1, Math.round((dayOf(sp.end_date) - dayOf(sp.start_date)) / 864e5) + 1);
  const passed = Math.round((dayOf(today()) - dayOf(sp.start_date)) / 864e5), left = total - passed;
  return `<section class="side-pulse" data-act="view" data-view="sprints" title="${esc(sp.name)}: day ${Math.min(total, Math.max(1, passed + 1))} of ${total}">
    <span class="label">${esc(sp.name)}</span><b class="mono ${left <= 1 ? 'hot' : ''}">${left > 1 ? `${left}d left` : left === 1 ? 'last day' : 'ended'}</b>
    <span class="days">${Array.from({ length: Math.min(total, 31) }, (_, n) => `<i class="${n < passed ? 'past' : n === passed ? 'today' : ''}"></i>`).join('')}</span></section>`;
}

const GROUPS = [['IN_PROGRESS', 'In progress'], ['TODO', 'To do'], ['NONE', 'Other']];
function issuesBlock() {
  const q = S.q.trim().toLowerCase();
  const xs = mine().filter((i) => !q || i.key.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)).sort(byUrgency);
  const groups = GROUPS.map(([cat, label]) => [cat, label, xs.filter((i) => (cat === 'NONE' ? !['IN_PROGRESS', 'TODO'].includes(catOf(i)) : catOf(i) === cat))]).filter(([, , ys]) => ys.length);
  const body = S.error ? `<p class="danger small pad">${esc(S.error)}</p>`
    : S.loading && !S.issues.length ? '<div class="skeleton"></div><div class="skeleton"></div>'
    : !xs.length ? `<div class="side-empty">${mascot(56, q ? 'look' : 'happy')}<span class="muted small">${q ? `Nothing matches "${esc(S.q)}"` : 'Nothing open is assigned to you.'}</span></div>`
    : groups.map(([cat, label, ys]) => `<div class="grp ${S.shut[cat] ? 'shut' : ''}">
        <button class="grp-head" data-act="fold" data-cat="${cat}" aria-expanded="${!S.shut[cat]}">${ic('chevron', 12, 'currentColor')}<span>${label}</span><span class="count">${ys.length}</span></button>
        ${S.shut[cat] ? '' : ys.map(row).join('')}</div>`).join('');
  return `<section class="mine">
    <label class="side-search">${ic('search', 13)}<input id="q" placeholder="Filter my issues" aria-label="Filter my issues" autocomplete="off"><span class="kbd">/</span></label>
    ${body}</section>`;
}

function row(i) {
  const st = statusOf(i), live = S.timer?.key === i.key;
  const pct = i.estimate_minutes ? Math.min(100, ((i.logged_minutes ?? 0) / i.estimate_minutes) * 100) : 0;
  const due = i.due_date ? `<span class="due ${overdue(i) ? 'late' : dueSoon(i) ? 'soon' : ''}">${fmtDate(i.due_date)}</span>` : '';
  return `<div class="issue prio-${esc(String(i.priority ?? 'MEDIUM').toLowerCase())} ${live ? 'live' : ''}" tabindex="0" data-act="open" data-key="${esc(i.key)}" title="${esc(`${i.key} ${i.title}`)}">
    <div class="issue-top">${icon(`t_${String(i.issue_type ?? 'TASK').toLowerCase()}`, { size: 14 })}<span class="key">${esc(i.key)}</span>${icon(`p_${String(i.priority ?? 'MEDIUM').toLowerCase()}`, { size: 12 })}
      <span class="st" style="--sc:${colorOf(st)}">${esc(st?.name ?? '')}</span><span class="grow"></span>${due}
      <span class="acts"><button class="icon-btn" data-act="timer" title="${live ? 'Stop the timer' : 'Start a timer'}">${ic(live ? 'stop' : 'clock', 13)}</button><button class="icon-btn" data-act="start" title="Start work: branch, assign, In Progress">${ic('branch', 13)}</button><button class="icon-btn" data-act="more" title="More actions">${ic('list', 13)}</button></span></div>
    <div class="issue-title">${esc(i.title)}</div>
    ${i.estimate_minutes ? `<span class="fuse ${i.logged_minutes > i.estimate_minutes ? 'over' : ''}" style="--p:${pct}%" title="${fmtDuration(i.logged_minutes) || '0m'} of ${fmtDuration(i.estimate_minutes)} logged"></span>` : ''}
  </div>`;
}

const dock = () => `<footer class="dock">
  <button class="btn primary" data-act="new" title="New issue">${ic('plus', 14, 'currentColor')}New issue</button>
  <button class="icon-btn" data-act="standup" title="Write my standup">${ic('comment', 15)}</button>
  <button class="icon-btn" data-act="focus" title="Start a 25-minute focus session">${ic('eye', 15)}</button>
  <button class="icon-btn" data-act="winddown" title="Wind down for the day">${ic('moon', 15)}</button>
  <button class="icon-btn" data-act="palette" title="Open the board's command palette">${ic('command', 15)}</button></footer>`;

setInterval(() => { const el = document.getElementById('clock'); if (el && S.timer) el.textContent = hms(S.timer.start); tickWorkday(S.att); }, 1000);

// ---------- actions ----------
const issueOf = (el) => S.issues.find((i) => i.key === el.closest('[data-key]')?.dataset.key);
const actions = {
  signin: () => host('signIn'),
  view: (el) => host('openBoard', { view: el.dataset.view }),
  lucky: () => host('openBoard', { view: 'today', lucky: true }),
  open: (el) => host('openBoard', { key: el.closest('[data-key]').dataset.key }),
  new: () => host('create'),
  standup: () => host('openBoard', { view: 'today', standup: true }),
  winddown: () => host('openBoard', { view: 'today', shutdown: true }),
  focus: () => host('focus'),
  palette: () => host('openBoard', { palette: true }),
  timer: async (el) => { S.timer = await host('timerToggle', issueOf(el)); render(); },
  'timer-stop': async () => { S.timer = await host('timerToggle', { key: S.timer.key, id: S.timer.id, title: S.timer.title }); render(); },
  start: (el) => host('startWork', issueOf(el)),
  more: (el) => host('actions', { key: issueOf(el).key }),
  // Attendance: a punch only ever comes from a person clicking this.
  'att-punch': async (el) => { el.disabled = true; S.att = await host('punchByHand', el.dataset.dir).catch((e) => (report('punch', e), S.att)); render(); },
  'att-connect': () => host('connectZoho'),
  fold: (el) => { S.shut = { ...S.shut, [el.dataset.cat]: !S.shut[el.dataset.cat] }; vsc.setState({ shut: S.shut }); render(); },
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  e.stopPropagation();
  Promise.resolve(actions[el.dataset.act](el, e)).catch((err) => report('action', err));
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.change === 'scope') host('setScope', { project: e.target.value || '' }).catch((err) => report('scope', err));
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  S.q = e.target.value;
  render();
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q')?.focus(); }
  if (e.key === 'Escape' && e.target.id === 'q') { S.q = ''; e.target.blur(); render(); }
  if (e.key === 'Enter' && e.target.classList?.contains('issue')) actions.open(e.target);
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.target.classList?.contains('issue') || e.target.id === 'q')) {
    e.preventDefault();
    const rows = [...document.querySelectorAll('.issue')], n = rows.indexOf(e.target);
    rows[e.key === 'ArrowDown' ? n + 1 : Math.max(0, n - 1)]?.focus();
  }
});

render();
init();
