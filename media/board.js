// Board webview: plain JS + template strings, no framework. Every API call goes through the
// extension host (it holds the login), via host('req', path, opts).
import { parseDuration, fmtDuration, timeFromCommits, previousWorkday, ticketQuality, TEMPLATES, attachmentKind, fmtSize, badges, luckyPick, luckyWeight, luckyMood, luckyPayout, weekStats, tipOfTheDay, streak, issuesWhere, TYPES, PRIORITIES } from '../pm.mjs';
import { icon, mascot } from './icons.mjs';
import { createSfx } from './sfx.mjs';
import { workdayBox, tickWorkday } from './workday.mjs';

const vsc = acquireVsCodeApi();
const pending = new Map();
let seq = 0;
const host = (method, ...args) =>
  new Promise((resolve, reject) => {
    pending.set(++seq, { resolve, reject });
    vsc.postMessage({ id: seq, method, args });
  });
const api = (path, opts) => host('req', path, opts);
const list = (d) => (Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : []);
// Fields may arrive as ids or as nested objects ({id, name…}); the board works with ids throughout.
const idOf = (v) => (v && typeof v === 'object' ? v.id : v);
function norm(i) {
  if (!i || typeof i !== 'object') return i;
  if (i.status && typeof i.status === 'object') i.status_detail ??= i.status;
  for (const k of ['status', 'sprint', 'assignee', 'reporter', 'project', 'parent']) i[k] = idOf(i[k]);
  if (Array.isArray(i.tags)) i.tags = i.tags.map(idOf);
  return i;
}
const report = (where, e) => host('log', `${where}: ${e?.stack ?? e?.message ?? e}`).catch(() => {});
window.addEventListener('error', (e) => report('error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => report('unhandled', e.reason));

window.addEventListener('message', ({ data }) => {
  if (data.id) {
    const p = pending.get(data.id);
    pending.delete(data.id);
    return data.error ? p?.reject(new Error(data.error)) : p?.resolve(data.result);
  }
  if (data.type === 'refresh') S.me ? load({ quiet: true }) : start();
  if (data.type === 'wake') wake();
  if (data.type === 'reinit') start();
  if (data.type === 'scope') run(applyScope(data.project));
  if (data.type === 'celebrate') celebrate(data);
  if (data.type === 'journal') loadFun().then(() => { if (S.view === 'today') renderView(); });
  if (data.type === 'attendance') { S.att = data.attendance; if (S.view === 'today') renderView(); }
  if (data.type === 'timer') { S.timer = data.timer; renderNow(); if (S.drawer?.issue && !S.modal) renderOverlay(); if (S.view === 'today') renderView(); }
  if (data.type === 'intent') handleIntent(data.intent);
});

// ---------- state ----------
const emptyFilters = () => ({ sprint: ['active'], type: [], priority: [], assignee: [], reporter: [], tag: [] });
const S = {
  me: null, workspace: null, projects: [], project: null,
  statuses: {}, sprints: {}, members: {}, tags: [], workspaces: [], myCounts: new Map(),
  issues: [], loading: true, error: '',
  view: 'board', filters: emptyFilters(), q: '', sort: null, lanes: null, sound: true,
  columns: ['key', 'title', 'status', 'assignee', 'priority', 'sprint', 'time', 'due', 'updated'], mineTab: 'assigned', mineGroup: 'project', attn: null, my: null,
  menu: null, drawer: null, modal: null, palette: null, quick: null,
  snaps: {}, baseline: {}, changes: null, recent: [], collapsed: new Set(), fresh: new Map(), loadedAt: 0, showAll: new Set(),
};
const persist = () => host('save', {
  view: S.view, filters: S.filters, sort: S.sort, lanes: S.lanes, sound: S.sound, snaps: S.snaps, recent: S.recent, columns: S.columns, mineTab: S.mineTab, mineGroup: S.mineGroup,
});
let persistTimer;
const persistSoon = () => { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 800); };

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl ';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cap = (s) => (s ? s[0] + s.slice(1).toLowerCase().replace(/_/g, ' ') : '');
const same = (a, b) => String(a ?? '') === String(b ?? '');
const today = () => new Date().toLocaleDateString('en-CA');
const userName = (u) => (u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.username : '');
const nameOf = (id) => (id == null ? '' : userName(S.members[id]) || 'Unknown');
const statusesOf = (pid) => S.statuses[pid] ?? [];
const sprintsOf = (pid) => S.sprints[pid] ?? [];
const statusOf = (i) => statusesOf(i.project).find((s) => same(s.id, i.status)) ?? i.status_detail ?? null;
const sprintOf = (i) => sprintsOf(i.project).find((s) => same(s.id, i.sprint));
const activeSprint = (pid = S.project?.id) => sprintsOf(pid).find((s) => s.state === 'ACTIVE');
const CAT = { TODO: 'var(--todo)', IN_PROGRESS: 'var(--progress)', DONE: 'var(--done)', NONE: 'var(--none)' };
const colorOf = (c, fallback) => (!c ? fallback : /^(#|rgb|hsl)/.test(c) ? c : `var(--c-${String(c).replace(/[^\w-]/g, '')}, ${fallback})`);
const statusColor = (s) => colorOf(s?.color, CAT[s?.category] ?? CAT.NONE);
const isDone = (i) => statusOf(i)?.category === 'DONE';
const fmtDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const overdue = (i) => !!i.due_date && !isDone(i) && String(i.due_date).slice(0, 10) < today();
const findIssue = (id) => (S.drawer?.issue && same(S.drawer.issue.id, id) ? S.drawer.issue : S.issues.find((x) => same(x.id, id)));
const statusesFor = async (pid) => (S.statuses[pid] ??= list(await api(`/api/projects/${pid}/statuses/`)));
const sprintsFor = async (pid) => (S.sprints[pid] ??= list(await api(`/api/sprints/?project=${pid}`)));
const groupBy = (xs, f) => xs.reduce((m, x) => m.set(f(x), [...(m.get(f(x)) ?? []), x]), new Map());

function ago(iso) {
  if (!iso) return '';
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [u, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]])
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), u);
  return 'just now';
}

// Form/select values are strings; map them back to the API's ids (numbers or uuids).
function coerce(field, i, raw) {
  const pick = (arr) => (raw === '' ? null : arr.find((x) => same(x.id, raw))?.id ?? raw);
  if (field === 'status') return pick(statusesOf(i.project));
  if (field === 'sprint') return pick(sprintsOf(i.project));
  if (field === 'assignee') return pick(Object.values(S.members));
  if (field === 'parent') return pick(S.issues);
  if (field === 'estimate_minutes') return raw.trim() ? parseDuration(raw) : null;
  if (field === 'due_date' || field === 'start_date') return raw || null;
  return raw;
}

// ---------- icons: media/icons.mjs (after icon_pack.png) ----------
const ic = (name, color, size = 14) => icon(name, { size, ink: color });
const typeIcon = (t = 'TASK') => `<span class="ti" title="${cap(t)}">${icon(`t_${t.toLowerCase()}`, { size: 16 })}</span>`;
const prioIcon = (p = 'MEDIUM') => `<span class="ti" title="${cap(p)} priority">${icon(`p_${p.toLowerCase()}`, { size: 14 })}</span>`;
const statusIcon = (s) => icon(`s_${(s?.category ?? 'NONE').toLowerCase()}`, { size: 16, accent: statusColor(s) });
const empty = (text, extra = '') => `<div class="state">${mascot(84)}<div>${text}</div>${extra}</div>`;
const tagColor = (t) => colorOf(t.color, 'var(--none)');
const tagChip = (t) => `<span class="tag" style="--c:${tagColor(t)}">${esc(t.title ?? t.name)}</span>`;
const tagsOf = (i) => (i.tags ?? []).map((id) => (typeof id === 'object' ? id : S.tags.find((t) => same(t.id, id)))).filter(Boolean);

function avatar(id, size = 20) {
  if (id == null) return `<span class="av none" style="--s:${size}px" title="Unassigned">${ic('user', 'currentColor', Math.round(size * 0.6))}</span>`;
  const n = nameOf(id);
  const hue = [...n].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  const ini = n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return `<span class="av" style="--s:${size}px;background:hsl(${hue} 55% 42%)" title="${esc(n)}">${esc(ini)}</span>`;
}

function timeBadge(i) {
  if (!i.logged_minutes && !i.estimate_minutes) return '';
  const over = i.estimate_minutes && i.logged_minutes > i.estimate_minutes;
  const txt = i.estimate_minutes ? `${fmtDuration(i.logged_minutes) || '0m'} / ${fmtDuration(i.estimate_minutes)}` : fmtDuration(i.logged_minutes);
  return `<span class="meta ${over ? 'danger' : ''}" title="Logged / estimate">${ic('clock')}${txt}</span>`;
}

const options = (pairs, cur) =>
  pairs.map(([v, l]) => `<option value="${esc(v)}" ${same(v, cur) ? 'selected' : ''}>${esc(l)}</option>`).join('');
const members = () =>
  Object.values(S.members).filter((u) => u.is_active !== false).map((u) => [u.id, userName(u)]).sort((a, b) => a[1].localeCompare(b[1]));
const assigneeOpts = () => [['', 'Unassigned'], ...members()];
const sprintOpts = (pid, cur) => [
  ['', 'No sprint'],
  ...sprintsOf(pid).filter((s) => s.state !== 'CLOSED' || same(s.id, cur)).map((s) => [s.id, s.state === 'ACTIVE' ? `${s.name} (active)` : s.name]),
];
const sel = (field, i, pairs, cls = 'pill') =>
  `<select class="${cls}" data-change="field" data-field="${field}" data-id="${esc(i.id)}" aria-label="${field}">${options(pairs, i[field])}</select>`;
const statusSelect = (i, cls = 'pill') =>
  `<select class="${cls} status" style="--sc:${statusColor(statusOf(i))}" data-change="field" data-field="status" data-id="${esc(i.id)}" aria-label="Status">${options(
    [...(i.status == null ? [['', 'No status']] : []), ...statusesOf(i.project).map((s) => [s.id, s.name])],
    i.status,
  )}</select>`;

// Minimal, escape-first markdown: headings, lists, task lists, code, bold/italic, links.
function md(src) {
  if (!src?.trim()) return '';
  const inline = (s) =>
    s.replace(/!\[([^\]]*)\]\((attachment:[\w-]+|https?:\/\/[^)\s]+)\)/g, (m, alt, src) => (src.startsWith('attachment:')
      ? `<img class="md-img" data-attachment="${src.slice(11)}" alt="${alt}" data-act="lightbox">`
      : `<img class="md-img" src="${src}" alt="${alt}" data-act="lightbox">`))
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a class="link" data-act="link" data-href="$2">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a class="link" data-act="link" data-href="$2">$2</a>');
  let out = '', open = null, code = false, m;
  const close = () => { if (open) out += `</${open}>`; open = null; };
  const into = (tag) => { if (open !== tag) { close(); out += `<${tag}>`; open = tag; } };
  for (const raw of src.replace(/\r/g, '').split('\n')) {
    if (/^\s*```/.test(raw)) { out += code ? '</code></pre>' : (close(), '<pre><code>'); code = !code; continue; }
    if (code) { out += esc(raw) + '\n'; continue; }
    if ((m = raw.match(/^(#{1,6})\s+(.*)/))) { close(); out += `<h4>${inline(esc(m[2]))}</h4>`; }
    else if ((m = raw.match(/^\s*[-*+]\s+\[( |x|X)\]\s*(.*)/))) { into('ul'); out += `<li class="task"><input type="checkbox" disabled ${m[1] === ' ' ? '' : 'checked'}> ${inline(esc(m[2]))}</li>`; }
    else if ((m = raw.match(/^\s*[-*+]\s+(.*)/))) { into('ul'); out += `<li>${inline(esc(m[1]))}</li>`; }
    else if ((m = raw.match(/^\s*\d+[.)]\s+(.*)/))) { into('ol'); out += `<li>${inline(esc(m[1]))}</li>`; }
    else if (!raw.trim()) close();
    else { close(); out += `<p>${inline(esc(raw))}</p>`; }
  }
  if (code) out += '</code></pre>';
  close();
  return out;
}

// ---------- data ----------
async function init() {
  renderShell();
  render();
  try {
    const { me, workspace, project, saved, intent, startWorkIn, timer } = await host('init');
    S.att = await host('attendance').catch(() => null);
    if (!me) throw new Error('You are signed out.');
    Object.assign(S, {
      me, workspace, startWorkIn, timer, scope: project ?? null, error: '', project: null, issues: [], statuses: {}, sprints: {}, members: {},
      today: null, drawer: null, modal: null, menu: null,
    });
    S.view = intent?.view ?? saved.view ?? S.view;
    S.filters = { ...emptyFilters(), ...saved.filters };
    S.sort = saved.sort ?? null;
    Object.assign(S, {
      lanes: saved.lanes ?? null, sound: saved.sound ?? true, recent: saved.recent ?? [], snaps: saved.snaps ?? {}, changes: null, my: null, attn: null,
      columns: saved.columns?.length ? saved.columns : [...DEFAULT_COLUMNS], mineTab: saved.mineTab ?? 'assigned', mineGroup: saved.mineGroup ?? 'project',
    });
    S.baseline = JSON.parse(JSON.stringify(S.snaps)); // "since you were last here" compares with how things were when you opened the board
    const [projects, memberships, tags, ws, mine] = await Promise.all([
      api(`/api/projects/?workspace=${workspace}`).then(list),
      api('/api/members/').then(list),
      api(`/api/tags/?workspace=${workspace}`).then(list).catch(() => []),
      host('workspaces').catch(() => ({ list: [] })),
      fetchMineAll().catch(() => []),
    ]);
    S.workspaces = ws.list ?? [];
    S.projects = projects.filter((p) => !p.workspace || same(idOf(p.workspace), workspace));
    for (const m of memberships) {
      const u = m.user && typeof m.user === 'object' ? m.user : m;
      if (!m.workspace || same(idOf(m.workspace), workspace)) S.members[u.id] = u;
    }
    S.members[me.id] ??= me;
    S.tags = tags;
    S.myCounts = mine.reduce((m, i) => m.set(String(i.project), (m.get(String(i.project)) ?? 0) + 1), new Map());
    if (!S.projects.some((p) => same(p.id, S.scope))) S.scope = null; // a project from another workspace: show all
    await setProject(S.scope);
    handleIntent({ ...intent, view: undefined });
  } catch (e) {
    S.error = e.message;
    S.loading = false;
    render();
  }
}

// What the extension asked for: open a ticket (optionally its breakdown), a view, or the create form.
function handleIntent(it) {
  if (!it) return;
  if (it.view && it.view !== S.view) { S.view = it.view; persist(); load(); }
  if (it.key) openIssue(it.key, { plan: it.plan });
  if (it.create) run(openCreate());
  if (it.standup) run(openStandup());
  if (it.shutdown) run(openShutdown());
  if (it.wrapped) run(openWrapped());
  if (it.lucky) run(spinLucky());
  if (it.palette) openPalette();
}

const fetchIssue = (key) => {
  const pid = S.projects.find((p) => p.key === key.split('-')[0])?.id;
  return api(`/api/issues/${encodeURIComponent(key)}/${pid ? `?project=${pid}` : ''}`).then(norm);
};

// The project scope is shared with the rest of Ajwain (sidebar, pickers, other windows, CLI) through the host.
// chooseProject: the user picked one here. applyScope: it changed elsewhere. setProject: load it.
async function chooseProject(id) {
  S.scope = id || null;
  host('setScope', { project: id || '' });
  await setProject(S.scope);
}
async function applyScope(id) {
  if (same(id, S.scope)) return;
  S.scope = S.projects.some((p) => same(p.id, id)) ? id : null;
  await setProject(S.scope);
}
async function setProject(id) {
  S.project = S.projects.find((p) => same(p.id, id)) ?? null;
  if (S.project) {
    await Promise.all([statusesFor(S.project.id), sprintsFor(S.project.id)]);
    // Sprint ids belong to one project; drop any that aren't this project's.
    const sps = sprintsOf(S.project.id);
    const keep = S.filters.sprint.filter((v) => v === 'active' || v === 'none' || sps.some((x) => same(x.id, v)));
    if (keep.length !== S.filters.sprint.length) S.filters.sprint = keep.length ? keep : ['active'];
  }
  await load();
}

let loadSeq = 0;
// quiet: a background refresh. The view stays as it is (no "Loading…") until the new data is in.
async function load({ quiet } = {}) {
  const mine = ++loadSeq;
  S.error = '';
  if (!quiet) {
    S.loading = true;
    render();
  }
  try {
    const issues = S.view === 'today' ? await fetchToday() : S.view === 'mine' ? await fetchMyWork() : S.project ? await fetchIssues() : [];
    if (S.view === 'mine' || S.view === 'today') await Promise.all([...new Set(issues.map((i) => i.project))].flatMap((pid) => [statusesFor(pid), sprintsFor(pid)]));
    if (mine === loadSeq) {
      S.issues = issues;
      S.changes = PROJECT_VIEWS.includes(S.view) && S.project ? trackChanges(S.project.id, issues) : null;
    }
  } catch (e) {
    if (mine === loadSeq) S.error = e.message;
  }
  if (mine === loadSeq) {
    S.loading = false;
    S.loadedAt = Date.now();
    render();
  }
}

// ---------- staying current ----------
// The host says "wake" when you come back to VS Code, to the board's tab, and every couple of minutes while
// you're looking. If what's shown is older than STALE, it reloads quietly, so a ticket created or moved on the
// web app shows up without a click. Not while you're typing, dragging or have a menu open: a re-render would
// take that away from you.
const STALE = 30e3;
const busy = () => S.loading || S.menu || S.quick != null || document.querySelector('.dragging')
  || (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.activeElement.closest('#overlay, #palette'));
function wake() {
  if (!S.me || S.error || busy() || Date.now() - (S.loadedAt ?? 0) < STALE) return;
  load({ quiet: true });
}

// Tickets made here appear at once, at the top and highlighted, without waiting for the reload; they stay first
// in the default order for a while, so the next refresh doesn't move them out of sight. Returns false when the
// view's filters wouldn't show the ticket, so the caller can say so.
const FRESH_FOR = 10 * 60e3;
const isFresh = (i) => Date.now() - (S.fresh.get(i.key) ?? 0) < FRESH_FOR;
function fitsView(i) {
  if (S.view === 'today') return same(i.assignee, S.me.id) && inScope(i);
  if (S.view === 'mine') return S.mineTab === 'assigned' ? same(i.assignee, S.me.id) && inScope(i) : S.mineTab === 'reported' ? same(i.reporter, S.me.id) && inScope(i) : false;
  if (!S.project || !same(i.project, S.project.id)) return false;
  const F = S.filters;
  const hit = (f, v) => (f === 'me' ? same(v, S.me.id) : f === 'none' ? v == null || (Array.isArray(v) && !v.length) : Array.isArray(v) ? v.some((x) => same(x, f)) : same(v, f));
  const has = (k, v) => !F[k].length || F[k].some((f) => hit(f, v));
  const sprintOk = S.view === 'sprints' || !F.sprint.length || F.sprint.some((f) => (f === 'active' ? same(i.sprint, activeSprint()?.id) : hit(f, i.sprint)));
  return sprintOk && has('type', i.issue_type) && has('priority', i.priority) && has('assignee', i.assignee) && has('reporter', i.reporter) && has('tag', i.tags);
}
function showCreated(raw) {
  const i = norm({ ...raw });
  seen(i);
  S.fresh.set(i.key, Date.now());
  const fits = fitsView(i);
  if (fits && !S.issues.some((x) => same(x.id, i.id))) {
    S.issues = [i, ...S.issues];
    if (S.view === 'mine' && S.my) S.my[S.mineTab] = S.issues;
  }
  renderView();
  renderFilters();
  if (fits) requestAnimationFrame(() => (document.querySelector(`.card[data-key="${CSS.escape(i.key)}"]`) ?? document.querySelector(`tr[data-id="${CSS.escape(String(i.id))}"]`))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  return fits;
}

const pages = async (q) => (await issuesWhere(api, q)).map(norm);

function fetchIssues() {
  const F = S.filters, q = new URLSearchParams([['project', S.project.id]]);
  const add = (k, vs) => vs.forEach((v) => q.append(k, v === 'me' ? S.me.id : v));
  add('type', F.type);
  add('priority', F.priority);
  add('assignee', F.assignee);
  add('reporter', F.reporter);
  add('tags', F.tag);
  if (S.view === 'sprints') {
    q.set('planning', 'true');
    q.set('ordering', 'sprint');
  } else add('sprint', F.sprint.flatMap((v) => (v !== 'active' ? [v] : activeSprint() ? [activeSprint().id] : [])));
  return pages(q);
}
// Today: my open issues + my commits since midnight, grouped by ticket with a suggested time to log.
async function fetchToday() {
  const [mine, commits] = await Promise.all([fetchMine(), host('todayCommits'), loadFun()]);
  const found = {}, elsewhere = new Set();
  await Promise.all([...new Set(commits.map((c) => c.key).filter(Boolean))].map(async (k) => {
    const issue = mine.find((i) => i.key === k) ?? (await fetchIssue(k).catch(() => null));
    if (!issue) return;
    if (!inScope(issue)) return void elsewhere.add(k); // another project's ticket: not shown while a project is chosen
    const logs = list(await api(`/api/worklogs/?issue=${issue.id}`).catch(() => []));
    const loggedToday = logs
      .filter((w) => String(w.logged_on).slice(0, 10) === today() && same(w.user ?? w.author ?? w.logged_by, S.me.id))
      .reduce((a, w) => a + (w.minutes ?? 0), 0);
    found[k] = { issue, loggedToday, commits: commits.filter((c) => c.key === k) };
  }));
  const suggested = timeFromCommits(commits);
  const rows = Object.values(found).map((f) => {
    const left = Math.max(0, (suggested[f.issue.key] ?? 0) - f.loggedToday);
    return { key: f.issue.key, minutes: fmtDuration(left), note: f.commits.map((c) => c.subject).join('; ').slice(0, 300), on: left > 0 };
  });
  S.today = { commits, found, rows, elsewhere, mine, untracked: commits.filter((c) => !found[c.key] && !elsewhere.has(c.key)) };
  return mine;
}
const inScope = (i) => !S.scope || same(i.project, S.scope);
const fetchMineAll = () => pages(new URLSearchParams({ workspace: S.workspace, assignee: S.me.id, open: 'true' }));
const fetchMine = async () => {
  const all = await fetchMineAll();
  S.myCounts = all.reduce((m, i) => m.set(String(i.project), (m.get(String(i.project)) ?? 0) + 1), new Map());
  return all.filter(inScope);
};
// My work: what's assigned to me, what I reported (open), and what I finished in the last two weeks.
const MINE_TABS = [['assigned', 'Assigned to me'], ['reported', 'Reported by me'], ['done', 'Done, last 14 days']];
async function fetchMyWork() {
  const w = S.workspace, me = S.me.id;
  const [assigned, reported, recent] = await Promise.all([
    fetchMine(),
    pages(new URLSearchParams({ workspace: w, reporter: me, open: 'true' })),
    // ponytail: the 100 most recently updated of mine, then the done ones; page further if 14 days ever holds more
    api(`/api/issues/?${new URLSearchParams({ workspace: w, assignee: me, ordering: '-updated_at', page_size: '100' })}`).then((d) => list(d).map(norm)),
  ]);
  await Promise.all([...new Set([...assigned, ...reported, ...recent].map((i) => i.project))].flatMap((pid) => [statusesFor(pid), sprintsFor(pid)]));
  const since = Date.now() - 14 * 864e5;
  S.my = {
    assigned,
    reported: reported.filter(inScope),
    done: recent.filter((i) => inScope(i) && isDone(i) && (Date.parse(i.resolved_at ?? i.updated_at) || 0) >= since),
  };
  return S.my[S.mineTab] ?? assigned;
}
const scopeLabel = () => (S.scope ? `in ${S.projects.find((p) => same(p.id, S.scope))?.key ?? 'this project'}` : 'across all projects');

async function patch(i, changes) {
  const targets = [...new Set([i, S.issues.find((x) => same(x.id, i.id)), S.drawer?.issue && same(S.drawer.issue.id, i.id) && S.drawer.issue].filter(Boolean))];
  const before = Object.fromEntries(Object.keys(changes).map((k) => [k, i[k]]));
  targets.forEach((t) => Object.assign(t, changes));
  rerender();
  try {
    const r = await api(`/api/issues/${i.id}/`, { method: 'PATCH', body: changes });
    if (r && typeof r === 'object') targets.forEach((t) => Object.assign(t, norm({ ...r })));
    seen(i);
    host('changed');
    const st = changes.status != null && statusesOf(i.project).find((x) => same(x.id, changes.status));
    if (st?.category === 'DONE' && before.status !== changes.status) {
      celebrate({ kind: 'finish', title: `${i.key} done`, detail: i.title });
      host('record', { type: 'finish', key: i.key, issue_type: i.issue_type });
    }
  } catch (e) {
    targets.forEach((t) => Object.assign(t, before));
    // e.g. "add an estimate first" when moving a ticket into progress: the toast links to the ticket to fix it.
    toast(e.message, true, i.key);
  }
  rerender();
}

// ---------- since you were last here: each project's issues are snapshotted, and the next visit is diffed ----------
// A snapshot entry is [status, assignee, updated_at] by key, kept for tickets touched in the last SNAP_DAYS (a big
// project has thousands of old ones). Changes you make here are marked seen as you make them.
const SNAP_DAYS = 30;
const PROJECT_VIEWS = ['board', 'list', 'sprints'];
const snapOf = (i) => [String(i.status ?? ''), String(i.assignee ?? ''), i.updated_at ?? ''];
function trackChanges(pid, issues) {
  const cutoff = Date.now() - SNAP_DAYS * 864e5;
  const all = { ...S.snaps[pid]?.issues, ...Object.fromEntries(issues.map((i) => [i.key, snapOf(i)])) };
  S.snaps[pid] = { at: Date.now(), issues: Object.fromEntries(Object.entries(all).filter(([, e]) => !(Date.parse(e[2]) < cutoff))) };
  persistSoon();
  const base = S.baseline[pid], out = new Map();
  if (!base) return out;
  for (const i of issues) {
    const was = base.issues[i.key];
    if (!was) {
      // Not in the last snapshot: filed since then, or dormant so long it was dropped and has changed now.
      if (Date.parse(i.created_at) > base.at) out.set(i.key, { kind: 'new' });
      else if (Date.parse(i.updated_at) > base.at) out.set(i.key, { kind: 'edited' });
    } else if (was[0] !== String(i.status ?? '')) out.set(i.key, { kind: 'moved', from: was[0] });
    else if (was[1] !== String(i.assignee ?? '')) out.set(i.key, { kind: 'assigned', from: was[1] });
    else if (i.updated_at && was[2] && was[2] !== i.updated_at) out.set(i.key, { kind: 'edited' });
  }
  return out;
}
function seen(i) {
  for (const m of [S.baseline, S.snaps]) if (m[i.project]) m[i.project].issues[i.key] = snapOf(i);
  S.changes?.delete(i.key);
}
const FLAG = { new: 'New', moved: 'Moved', assigned: 'Owner', edited: 'Edited' };
function changeText(i, c) {
  if (c.kind === 'moved') return `${statusesOf(i.project).find((s) => same(s.id, c.from))?.name ?? 'Elsewhere'} → ${statusOf(i)?.name ?? 'No status'}`;
  if (c.kind === 'assigned') return `${c.from ? nameOf(c.from) : 'Unassigned'} → ${i.assignee ? nameOf(i.assignee) : 'Unassigned'}`;
  if (c.kind === 'new') return `new${i.reporter ? `, by ${nameOf(i.reporter)}` : ''}`;
  return 'edited';
}
const flag = (i) => {
  const c = S.changes?.get(i.key);
  if (c) return `<span class="flag ${c.kind}" title="${esc(changeText(i, c))}">${FLAG[c.kind]}</span>`;
  return isFresh(i) ? '<span class="flag new" title="You just created this">New</span>' : '';
};
function sinceStrip() {
  const ch = S.changes, base = S.baseline[S.project?.id];
  if (!ch?.size || !base) return '';
  const byKey = new Map(S.issues.map((i) => [i.key, i]));
  const n = (k) => [...ch.values()].filter((c) => c.kind === k).length;
  const parts = [['moved', 'moved'], ['new', 'new'], ['assigned', 'reassigned'], ['edited', 'edited']].filter(([k]) => n(k)).map(([k, l]) => `<span class="part ${k}"><b>${n(k)}</b> ${l}</span>`);
  return `<details class="since" ${S.sinceOpen ? 'open' : ''}><summary>${ic('history')}<span class="label">Since you were last here</span><span class="muted small">${esc(ago(new Date(base.at).toISOString()))}</span>${parts.join('')}<span class="grow"></span>
      <button class="btn small" data-act="mark-seen">${ic('check')}Mark all seen</button></summary>
    <div class="since-list">${[...ch].filter(([k]) => byKey.has(k)).slice(0, 40).map(([k, c]) => { const i = byKey.get(k); return `<a class="since-row" data-act="open" data-key="${esc(k)}">
      <span class="flag ${c.kind}">${FLAG[c.kind]}</span><span class="key">${esc(k)}</span><span class="grow title-text">${esc(i.title)}</span><span class="muted small nowrap">${esc(changeText(i, c))}</span></a>`; }).join('')}</div></details>`;
}

// ---------- rendering ----------
const VIEWS = [['today', 'Today', 'sun'], ['board', 'Board', 'board'], ['list', 'List', 'list'], ['sprints', 'Sprints', 'sprint'], ['mine', 'My work', 'user']];

function renderShell() {
  document.body.innerHTML = `
  <header class="top">
    <div class="brand"><span class="brand-mark">${icon('logo', { size: 20 })}</span><span class="brand-name">Ajwain</span></div>
    <div class="project"><select id="workspace" data-change="workspace" aria-label="Workspace" hidden></select><select id="project" data-change="project" aria-label="Project"></select></div>
    <nav class="tabs">${VIEWS.map(([v, label, icon], n) => `<button data-act="view" data-view="${v}" title="${label} (${n + 1})">${ic(icon)}<span class="tab-label">${label}</span><span class="tab-n">${n + 1}</span></button>`).join('')}</nav>
    <span class="grow"></span>
    <div id="nowbar"></div>
    <label class="search">${ic('search')}<input id="q" placeholder="Filter by key or title" aria-label="Filter"><span class="kbd">/</span></label>
    <button class="palette-btn" data-act="palette" title="Jump to anything, run any command">${ic('command')}<span class="kbd">${MOD}K</span></button>
    <button class="icon-btn" data-act="refresh" title="Refresh">${ic('refresh')}</button>
    <button class="btn primary" data-act="new" title="New issue (C)">${ic('plus')}New issue</button>
  </header>
  <div id="filters" class="filters"></div>
  <main id="view"></main>
  <div id="overlay"></div>
  <div id="palette"></div>
  <div id="lightbox"></div>
  <div id="fx" aria-live="polite"></div>
  <div id="toast"></div>`;
  $('#q').value = S.q;
  $('#q').addEventListener('input', (e) => {
    S.q = e.target.value;
    renderView();
    renderFilters();
  });
}

const render = () => { renderTop(); renderFilters(); renderView(); };
const rerender = () => { renderView(); renderFilters(); if (S.drawer || S.modal) renderOverlay(); };

function renderTop() {
  const p = $('#project');
  const total = [...S.myCounts.values()].reduce((a, b) => a + b, 0);
  p.innerHTML = options([['', `All projects${total ? `  (${total} yours)` : ''}`], ...S.projects.map((x) => {
    const n = S.myCounts.get(String(x.id));
    return [x.id, `${x.key} · ${x.name}${n ? `  (${n} yours)` : ''}`];
  })], S.scope ?? '');
  const w = $('#workspace');
  w.hidden = S.workspaces.length < 2;
  w.innerHTML = options(S.workspaces.map((x) => [x.id, x.name]), S.workspace);
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === S.view));
  renderNow();
}

// The running timer, always in sight: key, live clock, stop.
const hms = (start) => { const s = Math.max(0, Math.floor((Date.now() - start) / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function renderNow() {
  const el = $('#nowbar');
  if (!el) return;
  const t = S.timer;
  el.innerHTML = t ? `<div class="nowbar" title="Timer running on ${esc(t.key)}: ${esc(t.title ?? '')}">
    <span class="rec" aria-hidden="true"></span><a class="key" data-act="open" data-key="${esc(t.key)}">${esc(t.key)}</a><span class="now-clock" id="now-clock">${hms(t.start)}</span>
    <button class="now-stop" data-act="timer-stop" title="Stop and log">${ic('stop', 'currentColor', 12)}</button></div>` : '';
}
setInterval(() => { const el = document.getElementById('now-clock'); if (el && S.timer) el.textContent = hms(S.timer.start); if (S.view === 'today') tickWorkday(S.att); }, 1000);

function visible() {
  const q = S.q.trim().toLowerCase();
  const xs = q ? S.issues.filter((i) => i.key.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)) : S.issues;
  if (!S.sort) return S.fresh.size ? [...xs.filter(isFresh), ...xs.filter((i) => !isFresh(i))] : xs;
  const val = {
    key: (i) => +i.key.split('-').pop(),
    title: (i) => i.title.toLowerCase(),
    status: (i) => statusesOf(i.project).findIndex((s) => same(s.id, i.status)),
    assignee: (i) => nameOf(i.assignee).toLowerCase() || '~',
    priority: (i) => PRIORITIES.indexOf(i.priority),
    sprint: (i) => sprintOf(i)?.name ?? '~',
    time: (i) => i.estimate_minutes ?? -1,
    due: (i) => i.due_date ?? '9999',
    reporter: (i) => nameOf(i.reporter).toLowerCase() || '~',
    created: (i) => Date.parse(i.created_at) || 0,
    updated: (i) => Date.parse(i.updated_at) || 0,
  }[S.sort.key];
  if (!val) return xs;
  return [...xs].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * S.sort.dir);
}

function renderFilters() {
  const el = $('#filters');
  if (S.view === 'today') {
    el.innerHTML = `<span class="muted">Your day ${esc(scopeLabel())}</span><span class="grow"></span>
      <button class="btn small" data-act="standup">${ic('comment')}Write standup</button>
      <button class="btn small" data-act="add-reminder">${ic('bell')}Add reminder</button><button class="btn small" data-act="reminders">Reminder settings</button>`;
    return;
  }
  if (S.view === 'mine') {
    el.innerHTML = `<div class="seg mine-tabs">${MINE_TABS.map(([k, l]) => `<button class="${S.mineTab === k ? 'on' : ''}" data-act="mine-tab" data-tab="${k}">${l}<span class="count">${S.my?.[k]?.length ?? '·'}</span></button>`).join('')}</div>
      <div class="view-opts">${pick('Group', 'mine-group', MINE_GROUPS, S.mineGroup, 'lanes')}${sortPick()}${columnsMenu()}</div>
      <span class="count-label muted">${S.loading ? 'Loading…' : `${visible().length} issues ${esc(scopeLabel())}`}</span>`;
    return;
  }
  if (!S.project) return (el.innerHTML = '');
  const act = activeSprint();
  const people = members().map(([id, n]) => [id, n, avatar(id, 16)]);
  const menus = [
    S.view !== 'sprints' && ['sprint', 'Sprint', [['active', act ? `${act.name} (active)` : 'Active sprint'], ...sprintsOf(S.project.id).map((s) => [s.id, s.state === 'CLOSED' ? `${s.name} (closed)` : s.name]), ['none', 'No sprint']]],
    ['type', 'Type', TYPES.map((t) => [t, cap(t), typeIcon(t)])],
    ['priority', 'Priority', PRIORITIES.map((p) => [p, cap(p), prioIcon(p)])],
    ['assignee', 'Assignee', [['me', 'Me', avatar(S.me.id, 16)], ['none', 'Unassigned', avatar(null, 16)], ...people]],
    ['reporter', 'Reporter', [['me', 'Me', avatar(S.me.id, 16)], ...people]],
    ['tag', 'Tag', [['none', 'Untagged'], ...S.tags.map((t) => [t.id, t.title, `<span class="dot" style="background:${tagColor(t)}"></span>`])]],
  ].filter(Boolean);
  const any = JSON.stringify(S.filters) !== JSON.stringify(emptyFilters());
  el.innerHTML = `${ic('filter', 'var(--fg2)')}${menus.map(filterMenu).join('')}${any ? '<button class="btn small" data-act="clear">Clear</button>' : ''}
    ${S.me.ai_enabled ? `<form class="ask" data-form="ask"><input name="q" data-keep="ask" placeholder="Ask: my open bugs this sprint" aria-label="Filter in plain words">${ic('sparkle', 'currentColor', 12)}</form>` : ''}
    <div class="view-opts">${S.view === 'board' ? pick('Lanes', 'lanes', LANES, S.lanes ?? '', 'lanes') : ''}${sortPick()}${S.view === 'board' ? '' : columnsMenu()}</div>
    ${pulse()}
    <span class="count-label muted">${S.loading ? 'Loading…' : `${visible().length} issues`}</span>`;
}

// The active sprint at a glance: one segment per day, today in orange, and how much of it is done.
const dayOf = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00`);
function pulse() {
  const sp = activeSprint();
  if (!sp?.start_date || !sp?.end_date) return '';
  const total = Math.max(1, Math.round((dayOf(sp.end_date) - dayOf(sp.start_date)) / 864e5) + 1);
  const passed = Math.round((dayOf(today()) - dayOf(sp.start_date)) / 864e5);
  const left = total - passed;
  const xs = S.issues.filter((i) => same(i.sprint, sp.id)), done = xs.filter(isDone).length;
  const pct = xs.length ? Math.round((done / xs.length) * 100) : 0;
  return `<div class="pulse" title="${esc(sp.name)}: day ${Math.min(total, Math.max(1, passed + 1))} of ${total}${xs.length ? `, ${done} of ${xs.length} shown issues done` : ''}">
    <span class="label">${esc(sp.name)}</span><span class="days">${Array.from({ length: Math.min(total, 31) }, (_, n) => `<i class="${n < passed ? 'past' : n === passed ? 'now' : ''}"></i>`).join('')}</span>
    <b class="mono ${left <= 1 ? 'hot' : ''}">${left > 1 ? `${left}d left` : left === 1 ? 'last day' : 'ended'}</b>${xs.length ? `<span class="pulse-done mono" style="--p:${pct}%">${pct}%</span>` : ''}</div>`;
}

function filterMenu([key, label, opts]) {
  const chosen = S.filters[key].map(String);
  const summary = !chosen.length ? 'All' : chosen.length === 1 ? opts.find((o) => same(o[0], chosen[0]))?.[1] ?? '1 selected' : `${chosen.length} selected`;
  return `<div class="menu">
    <button class="filter-btn ${chosen.length ? 'on' : ''}" data-act="menu" data-key="${key}">${label}: <b>${esc(summary)}</b>${ic('chevron', 'currentColor', 12)}</button>
    ${S.menu === key ? `<div class="pop">${opts.map(([v, l, icon = '']) => `<label class="opt"><input type="checkbox" data-change="filter" data-key="${key}" value="${esc(v)}" ${chosen.includes(String(v)) ? 'checked' : ''}>${icon}<span>${esc(l)}</span></label>`).join('')}</div>` : ''}
  </div>`;
}

function renderView() {
  const el = $('#view');
  const boxes = () => [el, ...el.querySelectorAll('.cards')];
  const scroll = boxes().map((b) => [b.scrollTop, b.scrollLeft]);
  if (S.error)
    el.innerHTML = empty(`<b>Something went wrong</b><div class="muted">${esc(S.error)}</div>`,
      '<div><button class="btn" data-act="refresh">Retry</button> <button class="btn" data-act="signin">Sign in</button></div>');
  else if (S.loading && !S.issues.length) el.innerHTML = '<div class="skeleton"></div>'.repeat(4);
  else if (!S.project && ['board', 'list', 'sprints'].includes(S.view)) el.innerHTML = projectChooser();
  else {
    try {
      el.innerHTML = { today: todayView, board: boardView, list: listView, sprints: sprintsView, mine: mineView }[S.view]();
    } catch (e) {
      report(`render ${S.view}`, e);
      el.innerHTML = empty(`<b>Couldn't draw this view</b><div class="muted">${esc(e.message)}</div>`, '<div><button class="btn" data-act="refresh">Retry</button></div>');
    }
  }
  boxes().forEach((b, n) => scroll[n] && ([b.scrollTop, b.scrollLeft] = scroll[n]));
}

// Board, List and Sprints show one project; with "All projects" chosen they ask which.
function projectChooser() {
  if (!S.projects.length) return empty('No projects in this workspace yet.');
  return `<div class="chooser">
    <div class="group-title">${ic('board')}${esc(cap(S.view))} shows one project at a time. Which one?</div>
    <div class="chooser-list">${S.projects.map((p) => `<button class="choice" data-act="goto-project" data-id="${esc(p.id)}">
      <span class="choice-key">${esc(p.key)}</span><span class="grow"><b>${esc(p.name)}</b><span class="muted small">${p.issue_count != null ? `${p.issue_count} issues` : 'Project'}</span></span>
      <span class="choice-mine"><b>${S.myCounts.get(String(p.id)) ?? 0}</b><span class="label">yours</span></span>${ic('chevron', 'currentColor', 14)}</button>`).join('')}</div>
    <p class="muted small">Choosing one sets the project for all of Ajwain: board, sidebar, Today, My work and new tickets. Pick "All projects" in the top-left dropdown to see everything again.</p>
  </div>`;
}

// Shown when a project view comes back empty: which filters are on, and where my issues actually are.
function emptyHint() {
  const on = Object.entries(S.filters).filter(([k, v]) => v.length && !(S.view === 'sprints' && k === 'sprint'));
  const act = activeSprint();
  const what = on.map(([k, v]) => (k === 'sprint' && v.length === 1 && v[0] === 'active' ? `sprint = ${act ? act.name : 'active'}` : `${k} (${v.length})`));
  const elsewhere = S.projects.filter((p) => !same(p.id, S.project?.id) && S.myCounts.get(String(p.id)));
  return `<div class="hint">${icon('alert', { size: 22 })}<div class="grow">
    <b>Nothing to show in ${esc(S.project?.key ?? '')} · ${esc(S.project?.name ?? '')}${S.q ? ` for "${esc(S.q)}"` : ''}</b>
    <div class="muted">${what.length ? `Filters on: ${esc(what.join(' · '))}.` : 'This project has no issues yet.'}${elsewhere.length ? ' Your open issues are in other projects:' : ''}</div>
    <div class="row hint-actions">${what.length ? '<button class="btn small" data-act="clear">Clear filters</button>' : ''}
      ${elsewhere.map((p) => `<button class="btn small" data-act="goto-project" data-id="${esc(p.id)}">${esc(p.key)} · ${S.myCounts.get(String(p.id))} yours</button>`).join('')}
      <button class="btn small primary" data-act="new">${ic('plus')}New issue</button></div></div></div>`;
}
const noMatch = () => emptyHint();

// Untouched for a week or more, and not done: worth a look.
const idleDays = (i) => (i.updated_at && !isDone(i) ? Math.floor((Date.now() - Date.parse(i.updated_at)) / 864e5) : 0);
const sumEst = (xs) => xs.reduce((a, i) => a + (i.estimate_minutes ?? 0), 0);
function card(i) {
  const tags = tagsOf(i), sp = sprintOf(i), idle = idleDays(i);
  const metas = [
    timeBadge(i),
    i.due_date && `<span class="meta ${overdue(i) ? 'danger late' : ''}" title="Due">${ic('calendar')}${fmtDate(i.due_date)}</span>`,
    sp && S.filters.sprint.length !== 1 && `<span class="meta">${ic('sprint')}${esc(sp.name)}</span>`,
    i.attachment_count > 0 && `<span class="meta" title="Attachments">${ic('clip')}${i.attachment_count}</span>`,
    idle >= 7 && `<span class="meta idle" title="No updates for ${idle} days">${idle}d idle</span>`,
  ].filter(Boolean).join('');
  const pct = i.estimate_minutes ? Math.min(100, ((i.logged_minutes ?? 0) / i.estimate_minutes) * 100) : 0;
  return `<article class="card prio-${esc(String(i.priority ?? 'MEDIUM').toLowerCase())} ${S.timer?.key === i.key ? 'live' : ''} ${Date.now() - (S.fresh.get(i.key) ?? 0) < 4000 ? 'just-made' : ''}" draggable="true" tabindex="0" data-act="open" data-key="${esc(i.key)}" data-id="${esc(i.id)}">
    <div class="row">${typeIcon(i.issue_type)}<span class="key">${esc(i.key)}</span>${prioIcon(i.priority)}${flag(i)}<span class="grow"></span>${avatar(i.assignee)}</div>
    <div class="card-acts">${isDone(i) ? '' : `<button class="icon-btn" data-act="card-timer" title="${S.timer?.key === i.key ? 'Stop the timer' : 'Start a timer'}">${ic(S.timer?.key === i.key ? 'stop' : 'clock')}</button><button class="icon-btn" data-act="card-start" title="Start work: branch, assign to me, In Progress">${ic('branch')}</button>`}</div>
    <div class="title">${esc(i.title)}</div>
    ${tags.length ? `<div class="tags">${tags.map(tagChip).join('')}</div>` : ''}
    ${metas ? `<div class="row metas">${metas}</div>` : ''}
    ${i.estimate_minutes ? `<span class="fuse ${i.logged_minutes > i.estimate_minutes ? 'over' : ''}" style="--p:${pct}%" title="${fmtDuration(i.logged_minutes) || '0m'} of ${fmtDuration(i.estimate_minutes)} logged"></span>` : ''}
  </article>`;
}

const columnsOf = (issues) => [...statusesOf(S.project.id), ...(issues.some((i) => i.status == null) ? [{ id: '', name: 'No status', category: 'NONE' }] : [])];
const quickAdd = (s) => (same(S.quick, s.id) && S.quick != null
  ? `<form class="quick" data-form="quick" data-status="${esc(s.id)}"><input name="title" placeholder="Title, then Enter · Esc to stop" aria-label="Quick add to ${esc(s.name)}" autocomplete="off"></form>`
  : `<button class="quick-btn" data-act="quick" data-status="${esc(s.id)}">${ic('plus', 'currentColor', 12)}Quick add</button>`);
function boardView() {
  const issues = visible(), cols = columnsOf(issues);
  const top = `${sinceStrip()}${issues.length ? '' : emptyHint()}`;
  if (S.lanes) return top + lanesView(issues, cols);
  const ests = cols.map((s) => sumEst(issues.filter((i) => same(i.status, s.id)))), most = Math.max(1, ...ests);
  return `${top}<div class="board">${cols.map((s, n) => {
    const xs = issues.filter((i) => same(i.status, s.id));
    return `<section class="col" data-drop="status" data-value="${esc(s.id)}" style="--sc:${statusColor(s)}">
      <header>${statusIcon(s)}<span class="col-name">${esc(s.name)}</span><span class="grow"></span><span class="col-count">${xs.length}</span>
        <button class="icon-btn" data-act="new" data-status="${esc(s.id)}" title="New issue in ${esc(s.name)}">${ic('plus')}</button></header>
      <div class="col-load" title="${fmtDuration(ests[n]) || 'No'} estimate in this column"><i style="width:${(ests[n] / most) * 100}%"></i><span>${fmtDuration(ests[n]) || '—'}</span></div>
      <div class="cards">${xs.length ? (([shown, more]) => shown.map(card).join('') + more)(capped(xs, `col:${s.id}`, CARDS_SHOWN)) : '<p class="empty">Drop issues here</p>'}${quickAdd(s)}</div>
    </section>`;
  }).join('')}</div>`;
}

// ---------- swimlanes: rows by assignee, priority, type or parent; dropping in another lane changes that field ----------
const LANES = [['', 'None'], ['assignee', 'Assignee'], ['priority', 'Priority'], ['issue_type', 'Type'], ['parent', 'Parent']];
function laneLabel(f, v) {
  if (f === 'assignee') return v ? `${avatar(v, 18)}<b>${esc(nameOf(v))}</b>${same(v, S.me.id) ? '<span class="muted small">you</span>' : ''}` : `${avatar(null, 18)}<b>Unassigned</b>`;
  if (f === 'priority') return v ? `${prioIcon(v)}<b>${esc(cap(v))}</b>` : '<b>No priority</b>';
  if (f === 'issue_type') return v ? `${typeIcon(v)}<b>${esc(cap(v))}</b>` : '<b>No type</b>';
  const p = S.issues.find((x) => same(x.id, v));
  return v ? `${typeIcon(p?.issue_type ?? 'EPIC')}${p ? `<span class="key">${esc(p.key)}</span>` : ''}<b>${esc(p?.title ?? 'A parent outside this view')}</b>` : '<b>No parent</b>';
}
function laneGroups(issues) {
  const f = S.lanes, by = groupBy(issues, (i) => String(i[f] ?? ''));
  const order = { priority: PRIORITIES, issue_type: TYPES }[f];
  const keys = [...by.keys()];
  if (f === 'assignee' && !by.has(String(S.me.id))) keys.push(String(S.me.id)); // always a lane to drag work to yourself
  keys.sort(order ? (a, b) => order.indexOf(a) - order.indexOf(b)
    : f === 'assignee' ? (a, b) => (same(b, S.me.id) - same(a, S.me.id)) || ((a === '') - (b === '')) || nameOf(a).localeCompare(nameOf(b))
    : (a, b) => (a === '') - (b === ''));
  return keys.map((v) => [v, laneLabel(f, v), by.get(v) ?? []]);
}
function lanesView(issues, cols) {
  const f = S.lanes;
  return `<div class="lanes" style="--cols:${cols.length}">
    <div class="lane-heads">${cols.map((s) => `<div class="lane-col" style="--sc:${statusColor(s)}">${statusIcon(s)}<span class="col-name">${esc(s.name)}</span><span class="grow"></span><span class="col-count">${issues.filter((i) => same(i.status, s.id)).length}</span></div>`).join('')}</div>
    ${laneGroups(issues).map(([v, label, xs]) => {
      const id = `${f}:${v}`, shut = S.collapsed.has(id);
      return `<section class="lane ${shut ? 'shut' : ''}">
        <button class="lane-head" data-act="lane-toggle" data-lane="${esc(id)}" aria-expanded="${!shut}">${ic('chevron', 'currentColor', 12)}${label}<span class="count">${xs.length}</span>${sumEst(xs) ? `<span class="muted small mono">${fmtDuration(sumEst(xs))}</span>` : ''}</button>
        ${shut ? '' : `<div class="lane-row">${cols.map((s) => `<div class="cell" data-drop="status" data-value="${esc(s.id)}" data-lane="${f}" data-lane-value="${esc(v)}">${(([shown, more]) => shown.map(card).join('') + more)(capped(xs.filter((i) => same(i.status, s.id)), `cell:${id}:${s.id}`, 40))}</div>`).join('')}</div>`}
      </section>`;
    }).join('')}
  </div>`;
}

// Table columns. Key and title always show; the rest are chosen in the Columns menu (remembered).
const fullDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const COLUMNS = {
  key: { label: 'Key', w: 122, fixed: true, td: (i) => `<td class="nowrap"><span class="cellflex">${typeIcon(i.issue_type)}<a class="key" data-act="open" data-key="${esc(i.key)}">${esc(i.key)}</a>${flag(i)}</span></td>` },
  title: { label: 'Title', fixed: true, td: (i) => { const tags = tagsOf(i); return `<td class="title-cell"><span class="link" data-act="open" data-key="${esc(i.key)}">${esc(i.title)}</span>${tags.length ? `<span class="tags">${tags.map(tagChip).join('')}</span>` : ''}</td>`; } },
  status: { label: 'Status', w: 142, td: (i) => `<td>${cellPick(i, 'status', esc(statusOf(i)?.name ?? 'No status'), `style="--sc:${statusColor(statusOf(i))}"`)}</td>` },
  assignee: { label: 'Assignee', w: 170, td: (i) => `<td class="nowrap"><span class="cellflex">${avatar(i.assignee, 18)}${cellPick(i, 'assignee', esc(i.assignee ? nameOf(i.assignee) : 'Unassigned'))}</span></td>` },
  reporter: { label: 'Reporter', w: 160, td: (i) => `<td class="nowrap"><span class="cellflex">${avatar(i.reporter, 18)}<span class="cell-text">${esc(nameOf(i.reporter) || '—')}</span></span></td>` },
  priority: { label: 'Priority', w: 112, td: (i) => `<td class="nowrap"><span class="cellflex">${prioIcon(i.priority)}${cellPick(i, 'priority', esc(cap(i.priority)))}</span></td>` },
  sprint: { label: 'Sprint', w: 140, td: (i) => `<td>${cellPick(i, 'sprint', esc(sprintOf(i) ? (sprintOf(i).state === 'ACTIVE' ? `${sprintOf(i).name} (active)` : sprintOf(i).name) : 'No sprint'))}</td>` },
  time: { label: 'Time', w: 122, td: (i) => `<td class="nowrap">${timeBadge(i)}</td>` },
  due: { label: 'Due', w: 80, td: (i) => `<td class="nowrap ${overdue(i) ? 'danger' : ''}">${fmtDate(i.due_date)}</td>` },
  created: { label: 'Created', w: 96, td: (i) => `<td class="nowrap small muted" title="Created ${esc(fullDate(i.created_at))}">${fmtDate(i.created_at)}</td>` },
  updated: { label: 'Updated', w: 106, td: (i) => `<td class="nowrap small ${idleDays(i) >= 7 ? 'stale' : ''}" title="Updated ${esc(fullDate(i.updated_at))}">${esc(ago(i.updated_at))}</td>` },
};
// Editable cells are labels until clicked; then the real dropdown takes their place. A table of 2,000 tickets
// with four live dropdowns a row is ~90,000 elements and took 1.8s to draw; labels keep it light.
const cellPick = (i, field, label, attrs = '') =>
  `<button class="cell-pick ${field === 'status' ? 'status' : ''}" ${attrs} data-act="cell-edit" data-field="${field}" data-id="${esc(i.id)}" title="Change ${field}">${label}</button>`;
const CELL_EDIT = {
  status: (i) => statusSelect(i),
  assignee: (i) => sel('assignee', i, assigneeOpts()),
  priority: (i) => sel('priority', i, PRIORITIES.map((p) => [p, cap(p)])),
  sprint: (i) => sel('sprint', i, sprintOpts(i.project, i.sprint)),
};
function editCell(el) {
  const i = findIssue(el.dataset.id), make = CELL_EDIT[el.dataset.field];
  if (!i || !make) return;
  const box = document.createElement('div');
  box.innerHTML = make(i);
  const s = box.firstElementChild;
  el.replaceWith(s);
  s.focus();
  try { s.showPicker(); } catch { /* not supported here: it's focused, a click or the keyboard opens it */ }
  // Closed without a change: back to the label. (A change re-renders the table, which replaces it anyway.)
  s.addEventListener('blur', () => s.isConnected && s.replaceWith(el), { once: true });
}

const DEFAULT_COLUMNS = ['key', 'title', 'status', 'assignee', 'priority', 'sprint', 'time', 'due', 'updated'];
const columnsFrom = (xs) => Object.keys(COLUMNS).filter((k) => COLUMNS[k].fixed || xs.includes(k));
// `hide`: columns that say nothing in this place (Assignee when they're all yours, Sprint inside a sprint).
function table(xs, hide = [], key = 'table') {
  const cols = columnsFrom(S.columns).filter((k) => !hide.includes(k));
  const [rows, more] = capped(xs, key, ROWS_SHOWN);
  const arrow = (k) => (S.sort?.key === k ? (S.sort.dir === 1 ? ' ↑' : ' ↓') : '');
  return `<table style="min-width:${cols.reduce((a, k) => a + (COLUMNS[k].w ?? 260), 0)}px"><colgroup>${cols.map((k) => `<col${COLUMNS[k].w ? ` style="width:${COLUMNS[k].w}px"` : ''}>`).join('')}</colgroup>
    <thead><tr>${cols.map((k) => `<th data-act="sort" data-key="${k}" title="Sort by ${COLUMNS[k].label.toLowerCase()}">${COLUMNS[k].label}${arrow(k)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((i) => `<tr draggable="true" data-id="${esc(i.id)}" class="${Date.now() - (S.fresh.get(i.key) ?? 0) < 4000 ? 'just-made' : ''}">${cols.map((k) => COLUMNS[k].td(i)).join('')}</tr>`).join('')}</tbody></table>${more}`;
}
// Big lists draw the first part and offer the rest: a table its first 200 rows, a board column its first 100
// cards. Sorting, filters and search still cover every ticket; this only limits what's drawn at once.
const ROWS_SHOWN = 200, CARDS_SHOWN = 100;
const capped = (xs, key, n) => (xs.length <= n || S.showAll.has(key) ? [xs, ''] : [xs.slice(0, n), showMore(key, xs.length - n, xs.length)]);
const showMore = (key, more, total) => `<button class="show-more" data-act="show-all" data-key="${esc(key)}">${ic('chevron', 'currentColor', 12)}Show ${more} more (${total} in all)</button>`;
function columnsMenu() {
  const n = columnsFrom(S.columns).length;
  return `<div class="menu"><button class="filter-btn" data-act="menu" data-key="columns">${ic('list', 'currentColor', 12)}Columns: <b>${n}</b>${ic('chevron', 'currentColor', 12)}</button>
    ${S.menu === 'columns' ? `<div class="pop">${Object.entries(COLUMNS).filter(([, c]) => !c.fixed).map(([k, c]) => `<label class="opt"><input type="checkbox" data-change="column" value="${k}" ${S.columns.includes(k) ? 'checked' : ''}><span>${c.label}</span></label>`).join('')}
      <button class="opt reset" data-act="columns-reset">Reset to default</button></div>` : ''}</div>`;
}
// Sorting: the Sort picker (board, list, sprints, my work) and the table headers set the same order.
const SORTS = [['', 'Default order'], ['updated:-1', 'Recently updated'], ['updated:1', 'Least recently updated'], ['created:-1', 'Newest first'], ['created:1', 'Oldest first'],
  ['priority:1', 'Priority'], ['due:1', 'Due date'], ['status:1', 'Status'], ['assignee:1', 'Assignee'], ['time:-1', 'Biggest estimate'], ['key:1', 'Key'], ['title:1', 'Title']];
const FIRST_DIR = { updated: -1, created: -1, time: -1 }; // newest and biggest first
const pick = (label, change, opts, cur, iconName) => `<label class="pick ${cur ? 'on' : ''}">${iconName ? ic(iconName, 'currentColor', 13) : ''}${label}<select data-change="${change}" aria-label="${label}">${options(opts, cur ?? '')}</select></label>`;
function sortPick() {
  const cur = S.sort ? `${S.sort.key}:${S.sort.dir}` : '';
  const opts = cur && !SORTS.some(([v]) => v === cur) ? [...SORTS, [cur, `${COLUMNS[S.sort.key]?.label ?? cap(S.sort.key)} ${S.sort.dir > 0 ? '↑' : '↓'}`]] : SORTS;
  return pick('Sort', 'sort', opts, cur, 'sort');
}

const listView = () => (visible().length ? sinceStrip() + table(visible(), [], 'list') : noMatch());

function sprintsView() {
  const issues = visible(), sps = sprintsOf(S.project.id);
  if (!issues.length) return emptyHint();
  const shown = [...sps.filter((s) => s.state === 'ACTIVE'), ...sps.filter((s) => s.state === 'PLANNED')];
  const act = activeSprint();
  const head = sinceStrip() + (act ? workload(act, issues.filter((i) => same(i.sprint, act.id))) : '');
  for (const i of issues) if (i.sprint != null && !shown.some((s) => same(s.id, i.sprint))) shown.push(sprintOf(i) ?? { id: i.sprint, name: 'Other sprint', state: 'CLOSED' });
  return head + [...shown, null].map((s) => {
    const xs = issues.filter((i) => (s ? same(i.sprint, s.id) : i.sprint == null));
    const est = xs.reduce((a, i) => a + (i.estimate_minutes ?? 0), 0);
    const done = xs.filter(isDone).length;
    return `<section class="sprint" data-drop="sprint" data-value="${esc(s?.id ?? '')}">
      <header>${ic('sprint', s?.state === 'ACTIVE' ? 'var(--progress)' : 'var(--fg2)')}<b>${esc(s?.name ?? 'Backlog')}</b>
        ${s ? `<span class="chip ${s.state.toLowerCase()}">${cap(s.state)}</span>` : ''}
        ${s?.start_date ? `<span class="muted">${fmtDate(s.start_date)} – ${fmtDate(s.end_date)}</span>` : ''}
        <span class="grow"></span>
        <span class="muted">${xs.length} issues · ${fmtDuration(est) || '0h'} estimated · ${done}/${xs.length} done</span>
        <span class="bar" title="${done} of ${xs.length} done"><i style="width:${xs.length ? (done / xs.length) * 100 : 0}%"></i></span>
        <button class="icon-btn" data-act="new" data-sprint="${esc(s?.id ?? '')}" title="New issue here">${ic('plus')}</button>
      </header>
      ${xs.length ? table(xs, ['sprint'], `sprint:${s?.id ?? 'backlog'}`) : '<p class="empty">Drag issues here to plan them</p>'}
    </section>`;
  }).join('');
}

// Who has how much left in the active sprint, against the working days that remain.
function workdaysLeft(end) {
  let n = 0;
  for (const d = dayOf(today()); d <= dayOf(end); d.setDate(d.getDate() + 1)) n += d.getDay() % 6 !== 0;
  return n;
}
function workload(sp, xs) {
  if (!xs.length) return '';
  const left = (ys) => ys.filter((i) => !isDone(i)).reduce((a, i) => a + Math.max(0, (i.estimate_minutes ?? 0) - (i.logged_minutes ?? 0)), 0);
  const days = sp.end_date ? workdaysLeft(sp.end_date) : null;
  const cap = days != null ? days * 6 * 60 : null; // ponytail: 6 focused hours a day for everyone; a per-person setting when teams ask
  const rows = [...groupBy(xs, (i) => String(i.assignee ?? ''))].map(([u, ys]) => [u, ys, left(ys)]).sort((a, b) => b[2] - a[2]);
  const scale = Math.max(cap ?? 0, 60, ...rows.map((r) => r[2]));
  const seg = (ys, cat) => { const m = left(ys.filter((i) => (statusOf(i)?.category ?? 'TODO') === cat)); return m ? `<i class="${cat.toLowerCase()}" style="width:${(m / scale) * 100}%" title="${fmtDuration(m)} ${cat === 'TODO' ? 'not started' : 'in progress'}"></i>` : ''; };
  return `<section class="workload"><h3>${ic('users')}Workload<span class="muted normal small">Estimate left per person in ${esc(sp.name)}${days != null ? `, against ${plural(days, 'working day')} left at 6h a day` : ''}</span>
      <span class="wl-legend"><i class="todo"></i>not started<i class="in_progress"></i>in progress${cap != null ? '<i class="cap"></i>capacity' : ''}</span></h3>
    ${rows.map(([u, ys, m]) => `<div class="wl-row ${cap != null && m > cap ? 'over' : ''}">${avatar(u || null, 18)}<span class="wl-name">${esc(u ? nameOf(u) : 'Unassigned')}</span>
      <span class="wl-bar">${seg(ys, 'TODO')}${seg(ys, 'IN_PROGRESS')}${cap != null ? `<b class="cap" style="left:${(cap / scale) * 100}%" title="Capacity left: ${fmtDuration(cap)}"></b>` : ''}</span>
      <span class="mono wl-num">${fmtDuration(m) || '0m'}${cap != null && m > cap ? ` <span class="danger">+${fmtDuration(m - cap)}</span>` : ''}</span><span class="muted small wl-count">${ys.filter(isDone).length}/${ys.length} done</span></div>`).join('')}
  </section>`;
}

// What needs you: counts you can click to narrow the list.
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
const ATTENTION = [
  ['overdue', 'Overdue', (i) => overdue(i)],
  ['soon', 'Due in 7 days', (i) => !overdue(i) && !!i.due_date && !isDone(i) && String(i.due_date).slice(0, 10) <= plusDays(7)],
  ['idle', 'Idle 7+ days', (i) => idleDays(i) >= 7],
  ['over', 'Over estimate', (i) => !!i.estimate_minutes && i.logged_minutes > i.estimate_minutes],
  ['noest', 'No estimate', (i) => !i.estimate_minutes && !isDone(i)],
];
const MINE_GROUPS = [['project', 'Project'], ['due', 'Due date'], ['status', 'Status'], ['priority', 'Priority'], ['none', 'Nothing']];
const DUE_BUCKETS = [['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Due this week'], ['later', 'Due later'], ['none', 'No due date']];
function dueBucket(i) {
  const d = i.due_date && String(i.due_date).slice(0, 10);
  return !d ? 'none' : d < today() && !isDone(i) ? 'overdue' : d <= today() ? 'today' : d <= plusDays(7) ? 'week' : 'later';
}
function mineGroups(xs) {
  const g = S.mineGroup, nonEmpty = (gs) => gs.filter(([, , ys]) => ys.length);
  if (g === 'none') return [[null, '', xs]];
  if (g === 'due') return nonEmpty(DUE_BUCKETS.map(([k, l]) => [k, `${ic(k === 'overdue' ? 'alert' : 'calendar')}<b>${l}</b>`, xs.filter((i) => dueBucket(i) === k)]));
  if (g === 'priority') return nonEmpty(PRIORITIES.map((p) => [p, `${prioIcon(p)}<b>${cap(p)}</b>`, xs.filter((i) => i.priority === p)]));
  if (g === 'status') {
    const rank = { TODO: 0, IN_PROGRESS: 1, DONE: 2 };
    return [...groupBy(xs, (i) => statusOf(i)?.name ?? 'No status')].sort(([, a], [, b]) => (rank[statusOf(a[0])?.category] ?? 3) - (rank[statusOf(b[0])?.category] ?? 3))
      .map(([name, ys]) => [name, `${statusIcon(statusOf(ys[0]))}<b>${esc(name)}</b>`, ys]);
  }
  return [...groupBy(xs, (i) => i.project)].map(([pid, ys]) => {
    const p = S.projects.find((x) => same(x.id, pid));
    return [pid, `<span class="proj-key">${esc(p?.key ?? '')}</span><b>${esc(p?.name ?? '')}</b>`, ys];
  });
}
function mineView() {
  const all = visible(), tab = S.mineTab;
  const counts = ATTENTION.map(([k, l, f]) => [k, l, all.filter(f).length]);
  if (S.attn && !counts.find(([k]) => k === S.attn)?.[2]) S.attn = null;
  const strip = tab === 'done'
    ? `<div class="attention">${[[all.length, 'done in 14 days'], [fmtDuration(all.reduce((a, i) => a + (i.logged_minutes ?? 0), 0)) || '0m', 'logged on them'], [all.filter((i) => i.issue_type === 'BUG').length, 'bugs fixed'], [fmtDuration(all.reduce((a, i) => a + (i.estimate_minutes ?? 0), 0)) || '0m', 'estimated']].map(([v, l]) => `<div class="attn static"><b>${esc(v)}</b><span>${l}</span></div>`).join('')}</div>`
    : `<div class="attention">${counts.map(([k, l, n]) => `<button class="attn attn-${k} ${S.attn === k ? 'on' : ''}" data-act="attn" data-k="${k}" ${n ? '' : 'disabled'} title="${n ? `Show only these (${n})` : 'None'}"><b>${n}</b><span>${l}</span></button>`).join('')}</div>`;
  const none = { assigned: 'Nothing open is assigned to you. Enjoy it.', reported: 'Nothing you reported is still open.', done: 'Nothing finished in the last 14 days yet.' }[tab];
  if (!all.length) return strip + empty(none);
  const xs = S.attn ? all.filter(ATTENTION.find(([k]) => k === S.attn)[2]) : all;
  const head = S.attn ? `<div class="attn-note">Showing ${plural(xs.length, 'issue')}: ${esc(ATTENTION.find(([k]) => k === S.attn)[1].toLowerCase())}. <a class="link" data-act="attn" data-k="${S.attn}">Show all ${all.length}</a></div>` : '';
  const hide = tab === 'reported' ? [] : ['assignee'];
  return strip + head + mineGroups(xs).map(([gk, label, ys]) => `${label ? `<div class="group-title">${label}<span class="count">${ys.length}</span></div>` : ''}${table(ys, hide, `mine:${tab}:${S.mineGroup}:${gk}`)}`).join('');
}

// Overlay = issue drawer or create modal. Typed-but-unsaved text survives re-renders via data-keep.
function renderOverlay() {
  const o = $('#overlay');
  const kept = [...o.querySelectorAll('[data-keep]')].filter((e) => e.dataset.keep).map((e) => [e.dataset.keep, e.value]);
  // The New issue form re-renders (tags, notes, drafts): carry over every field, unless the project changed
  // (its statuses and sprints differ).
  const form = o.querySelector('form[data-form=create]');
  const typed = form ? [...form.elements].filter((e) => e.name && e.tagName !== 'BUTTON' && !e.dataset.keep).map((e) => [e.name, e.value]) : [];
  // Open animations play once: re-rendering the same dialog or panel (a reel landing, a timer tick) doesn't replay them.
  const kind = S.modal ? `modal:${S.modal.kind ?? 'create'}` : S.drawer ? `drawer:${S.drawer.key}` : '';
  o.classList.toggle('settled', !!kind && o.dataset.kind === kind);
  o.dataset.kind = kind;
  o.innerHTML = S.modal ? ({ plan: planModal, standup: standupModal, lucky: luckyModal, shutdown: shutdownModal, wrapped: wrappedModal, keys: keysModal }[S.modal.kind] ?? createModal)() : S.drawer ? drawer() : '';
  for (const [k, v] of kept) { const e = o.querySelector(`[data-keep="${k}"]`); if (e) e.value = v; }
  const again = o.querySelector('form[data-form=create]');
  if (again && form && again.dataset.pid === form.dataset.pid) for (const [n, v] of typed) if (n !== 'project' && again.elements[n]) again.elements[n].value = v;
  hydrate(o);
}

function drawer() {
  const d = S.drawer, i = d.issue;
  const head = `<header>${i ? typeIcon(i.issue_type) : ''}<a class="key link" data-act="web" data-key="${esc(d.key)}" title="Open in browser">${esc(d.key)}</a>
    ${i ? `<span class="muted">· ${esc(S.projects.find((p) => same(p.id, i.project))?.name ?? '')}</span>` : ''}
    <span class="grow"></span>
    ${i ? `<button class="icon-btn" data-act="copy-branch" title="Copy branch name">${ic('copy')}</button>
      <button class="icon-btn" data-act="doc" title="Edit as a Markdown file">${ic('file')}</button>
      <button class="icon-btn" data-act="web" data-key="${esc(d.key)}" title="Open in browser">${ic('external')}</button>` : ''}
    <button class="icon-btn" data-act="close" title="Close (Esc)">${ic('close')}</button></header>`;
  const shell = (body) => `<div class="scrim" data-act="close"></div><aside class="drawer ${Date.now() - (d.openedAt ?? 0) < 250 ? 'enter' : ''}" role="dialog" aria-label="${esc(d.key)}" data-dropzone="issue">${head}<div class="body">${body}</div><div class="drop-hint">${ic('upload', 'currentColor', 28)}Drop files to attach them to ${esc(d.key)}</div></aside>`;
  if (!i) return shell(d.error ? `<p class="danger">${esc(d.error)}</p>` : '<div class="skeleton"></div><div class="skeleton"></div>');

  const pct = i.estimate_minutes ? Math.min(100, ((i.logged_minutes ?? 0) / i.estimate_minutes) * 100) : 0;
  const over = i.estimate_minutes && i.logged_minutes > i.estimate_minutes;
  const subs = (i.children?.length ? i.children : S.issues.filter((x) => same(x.parent, i.id))).map((x) => ({ project: i.project, ...x }));
  const field = (name, type, value, ph = '') =>
    `<input type="${type}" data-change="field" data-field="${name}" data-id="${esc(i.id)}" value="${esc(value)}" placeholder="${ph}">`;
  const on = (i.tags ?? []).map(String);
  const tagMenu = `tags-${i.id}`;
  return shell(`
    <input class="title-input" data-change="field" data-field="title" data-id="${esc(i.id)}" value="${esc(i.title)}" aria-label="Title">
    ${cycleStrip(i)}
    ${i.parent_key ? `<div class="muted">Parent: <a class="link" data-act="open" data-key="${esc(i.parent_key)}">${esc(i.parent_key)} ${esc(i.parent_title ?? '')}</a></div>` : ''}
    <div class="fields">
      <label>Status</label>${statusSelect(i, '')}
      <label>Assignee</label>${sel('assignee', i, assigneeOpts(), '')}
      <label>Type</label>${sel('issue_type', i, TYPES.map((t) => [t, cap(t)]), '')}
      <label>Priority</label>${sel('priority', i, PRIORITIES.map((p) => [p, cap(p)]), '')}
      <label>Sprint</label>${sel('sprint', i, sprintOpts(i.project, i.sprint), '')}
      <label>Estimate</label>${field('estimate_minutes', 'text', fmtDuration(i.estimate_minutes), 'e.g. 3h, 1d')}
      <label>Start date</label>${field('start_date', 'date', i.start_date ?? '')}
      <label>Due date</label>${field('due_date', 'date', i.due_date ?? '')}
      <label>Reporter</label><span class="cellflex">${avatar(i.reporter, 18)}${esc(nameOf(i.reporter) || '—')}</span>
      <label>Tags</label><div class="menu cellflex">${tagsOf(i).map(tagChip).join('')}
        <button class="filter-btn" data-act="menu" data-key="${tagMenu}">${ic('tag', 'currentColor', 12)}${on.length ? 'Edit' : 'Add'}</button>
        ${S.menu === tagMenu ? `<div class="pop">${S.tags.map((t) => `<label class="opt"><input type="checkbox" data-change="issue-tag" data-id="${esc(i.id)}" value="${esc(t.id)}" ${on.includes(String(t.id)) ? 'checked' : ''}><span class="dot" style="background:${tagColor(t)}"></span>${esc(t.title)}</label>`).join('') || '<div class="opt muted">No tags in this workspace</div>'}</div>` : ''}
      </div>
    </div>
    ${healthStrip(i)}
    ${S.me.ai_enabled ? summarySection(d) : ''}

    <section><h3>${ic('clock')}Time</h3>
      <div class="timebox"><span>${fmtDuration(i.logged_minutes) || '0m'} logged${i.estimate_minutes ? ` of ${fmtDuration(i.estimate_minutes)}` : ''}</span>
        ${i.estimate_minutes ? `<span class="bar ${over ? 'over' : ''}"><i style="width:${pct}%"></i></span>` : ''}</div>
      <form class="inline-form" data-form="log">
        <input name="d" data-keep="log-d" placeholder="1h30m" size="7" required aria-label="Duration">
        <input name="on" type="date" data-keep="log-on" value="${today()}" aria-label="Date">
        <input name="note" data-keep="log-note" class="grow" placeholder="What did you work on?" aria-label="Note">
        <button class="btn small primary">Log time</button>
      </form>
      ${d.worklogs?.length ? `<div class="feed" style="margin-top:10px">${d.worklogs.map((w) => {
        const who = w.user ?? w.author ?? w.logged_by;
        return `<div class="item">${avatar(who, 22)}<div><span class="who">${esc(nameOf(who))}</span><b>${fmtDuration(w.minutes)}</b> <span class="muted">· ${fmtDate(w.logged_on)}</span>${w.note ? `<div class="muted">${esc(w.note)}</div>` : ''}</div></div>`;
      }).join('')}</div>` : ''}
    </section>

    <section class="desc"><h3>${ic('file')}Description<span class="grow"></span>
      ${S.me.ai_enabled && !d.editDesc ? `<button class="btn small" data-act="improve" ${d.improve?.loading ? 'disabled' : ''}>${ic('wand')}${d.improve?.loading ? 'Improving…' : 'Improve'}</button>` : ''}
      ${d.editDesc ? '' : '<button class="btn small" data-act="edit-desc">Edit</button>'}</h3>
      ${improveBox(d)}
      ${d.editDesc
        ? `<textarea class="field-input" id="desc" data-keep="desc" data-paste="issue">${esc(i.description ?? '')}</textarea>
           <div class="actions"><span class="muted small grow">Paste or drop an image to attach it</span><button class="btn small" data-act="cancel-desc">Cancel</button><button class="btn small primary" data-act="save-desc">Save <span class="kbd">Ctrl+Enter</span></button></div>`
        : `<div class="md">${md(i.description)}</div>`}
    </section>
    ${attachmentsSection(i, d)}

    ${i.issue_type !== 'SUBTASK' ? `<section><h3>${ic('t_subtask')}${i.issue_type === 'EPIC' ? 'Stories' : 'Subtasks'}${subs.length ? `<span class="count">${subs.length}</span>` : ''}<span class="grow"></span>
      <button class="btn small" data-act="plan" data-key="${esc(i.key)}">${ic('sparkle')}Break down</button><button class="btn small" data-act="new-sub">${ic('plus')}Add one</button></h3>
      ${subs.map((x) => `<div class="row" style="padding:3px 0">${statusIcon(statusOf(x))}<a class="key link" data-act="open" data-key="${esc(x.key)}">${esc(x.key)}</a><span class="link" data-act="open" data-key="${esc(x.key)}">${esc(x.title)}</span><span class="grow"></span>${avatar(x.assignee, 18)}</div>`).join('') || '<div class="muted">Nothing under this issue yet.</div>'}
    </section>` : ''}

    <section><h3>${ic('comment')}Comments${d.comments ? `<span class="count">${d.comments.length}</span>` : ''}</h3>
      <div class="feed">${d.comments ? d.comments.map((c) => `<div class="item">${avatar(c.author, 26)}<div><div><span class="who">${esc(nameOf(c.author))}</span><span class="muted">${ago(c.created_at)}</span></div><div class="md">${md(c.body)}</div></div></div>`).join('') : '<div class="skeleton"></div>'}</div>
      <form data-form="comment" style="margin-top:10px">
        <textarea class="field-input" name="body" data-keep="comment" data-paste="issue" rows="3" placeholder="Add a comment (Markdown, paste images). Ctrl+Enter to send." required></textarea>
        <div class="actions"><button class="btn small primary">Comment</button></div>
      </form>
    </section>`);
}

function createModal() {
  const { pid, pre } = S.modal;
  const act = activeSprint(pid);
  const defSprint = pre.sprint !== undefined ? pre.sprint : S.view !== 'sprints' && S.filters.sprint.includes('active') && act ? act.id : '';
  const m = S.modal;
  return `<div class="scrim" style="z-index:40" data-act="close-modal"></div>
  <form class="modal create" data-form="create" data-dropzone="new" data-pid="${esc(pid)}">
    <h2>${ic('plus')}New issue<span class="grow"></span>
      ${S.me.ai_enabled ? `<button type="button" class="btn small ${m.notesOpen ? 'on' : ''}" data-act="toggle-notes">${ic('sparkle')}Draft from notes</button>` : ''}</h2>
    ${m.notesOpen ? `<div class="ai notes">
      <textarea class="field-input" id="notes" data-keep="notes" rows="5" maxlength="4000" placeholder="Paste notes, a chat thread or an email. The app's AI fills the form below; nothing is saved until you create the issue."></textarea>
      <div class="row"><span class="muted small grow">${m.drafted ? 'Drafted by the app\'s AI. Check it before creating.' : 'Uses the same AI as the web app.'}</span>
        <button type="button" class="btn ai-btn" data-act="draft-notes" ${m.drafting ? 'disabled' : ''}>${ic('sparkle')}${m.drafting ? 'Drafting…' : 'Draft'}</button></div>
    </div>` : ''}
    <div class="fields">
      <label>Project</label><select name="project" data-change="modal-project">${options(S.projects.map((p) => [p.id, `${p.key} · ${p.name}`]), pid)}</select>
      <label>Type</label><select name="issue_type" data-health>${options(TYPES.map((t) => [t, cap(t)]), pre.issue_type ?? 'TASK')}</select>
    </div>
    <input class="field-input title-big" name="title" data-keep="new-title" data-health data-similar placeholder="Issue title: what changes, specifically" value="${esc(pre.title ?? '')}" required>
    <div id="new-similar"></div>
    <div class="desc-tools"><span class="muted small">Description (Markdown). Paste or drop screenshots to attach them.</span><span class="grow"></span>
      <button type="button" class="btn small" data-act="insert-template">${ic('file')}Insert template</button></div>
    <textarea class="field-input" name="description" data-keep="new-desc" data-health data-paste="new" rows="8" placeholder="## Why&#10;&#10;## What&#10;&#10;## Acceptance criteria&#10;- [ ] ">${esc(pre.description ?? '')}</textarea>
    <div id="new-files">${pendingFiles()}</div>
    <div id="new-health">${healthPanel(draftFromForm())}</div>
    <div class="fields">
      <label>Status</label><select name="status">${options(statusesOf(pid).map((s) => [s.id, s.name]), pre.status ?? statusesOf(pid)[0]?.id)}</select>
      <label>Assignee</label><select name="assignee">${options(assigneeOpts(), pre.assignee !== undefined ? pre.assignee : S.me.id)}</select>
      <label>Priority</label><select name="priority">${options(PRIORITIES.map((p) => [p, cap(p)]), pre.priority ?? 'MEDIUM')}</select>
      <label>Sprint</label><select name="sprint">${options(sprintOpts(pid), defSprint)}</select>
      <label>Estimate</label><input name="estimate" data-health placeholder="e.g. 3h, 1d" value="${esc(pre.estimate ?? '')}">
      <label>Due date</label><input name="due_date" type="date">
      <label>Parent</label><select name="parent">${options([['', 'None'], ...S.issues.filter((i) => same(i.project, pid) && i.issue_type !== 'SUBTASK').map((i) => [i.id, `${i.key} ${i.title}`])], pre.parent)}</select>
      <label>Tags</label><div class="cellflex new-tags">${(m.tags ?? []).map((id) => S.tags.find((t) => same(t.id, id))).filter(Boolean).map((t) =>
        `<span class="tag" style="--c:${tagColor(t)}">${esc(t.title)}<button type="button" class="x" data-act="untag" data-id="${esc(t.id)}" aria-label="Remove ${esc(t.title)}">×</button></span>`).join('')}
        <select data-change="add-tag" aria-label="Add a tag">${options([['', '+ tag'], ...S.tags.filter((t) => !(m.tags ?? []).some((x) => same(x, t.id))).map((t) => [t.id, t.title])], '')}</select></div>
    </div>
    <div class="actions"><span class="muted grow">Ctrl+Enter to create</span>
      <button type="button" class="btn" data-act="close-modal">Cancel</button>
      <button class="btn" name="then" value="plan" title="Create it, then split it into subtasks">${ic('t_subtask')}Create & break down</button>
      <button class="btn primary">Create issue</button></div>
  </form>`;
}

async function openCreate(pre = {}) {
  await ready?.catch(() => {}); // clicked before the first load finished: wait for the projects
  const pid = pre.project ?? S.project?.id ?? S.projects[0]?.id;
  if (!pid) return toast('No project to create in', true);
  await Promise.all([statusesFor(pid), sprintsFor(pid)]);
  S.modal = { pid, pre, tags: pre.tags ?? [], files: [] };
  S.menu = null;
  renderOverlay();
  $('[name=title]')?.focus();
  if (pre.title) checkSimilar();
}

async function openIssue(key, { plan } = {}) {
  const openedAt = S.drawer?.key === key ? S.drawer.openedAt : Date.now(); // re-opening the same ticket doesn't re-animate
  S.drawer = { key, openedAt };
  S.menu = null;
  renderOverlay();
  try {
    const issue = await fetchIssue(key);
    await Promise.all([statusesFor(issue.project), sprintsFor(issue.project)]);
    if (S.drawer?.key !== key) return;
    S.drawer = { key, issue, openedAt };
    S.recent = [{ key, title: issue.title, issue_type: issue.issue_type }, ...S.recent.filter((r) => r.key !== key)].slice(0, 12);
    persistSoon();
    renderOverlay();
    if (plan) openPlan(issue);
    const [comments, worklogs] = await Promise.all([
      api(`/api/comments/?issue=${issue.id}`).then(list).catch(() => []),
      api(`/api/worklogs/?issue=${issue.id}`).then(list).catch(() => []),
    ]);
    if (S.drawer?.key !== key) return;
    Object.assign(S.drawer, { comments, worklogs });
    renderOverlay();
  } catch (e) {
    if (S.drawer?.key === key) {
      S.drawer.error = e.message;
      renderOverlay();
    }
  }
}

function toast(msg, error, key) {
  const t = document.createElement('div');
  t.className = `toast ${error ? 'error' : ''}`;
  t.innerHTML = esc(msg) + (key ? ` · <a class="link" data-act="open" data-key="${esc(key)}"><b>Open</b></a>` : '');
  $('#toast').append(t);
  setTimeout(() => t.remove(), error ? 8000 : 4000);
}

// ---------- the development cycle, step by step, in the ticket panel ----------
const clock = (start) => { const m = Math.floor((Date.now() - start) / 60000); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const upNext = (issues) => issues
  .filter((i) => statusOf(i)?.category !== 'IN_PROGRESS' && !isDone(i))
  .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || String(a.due_date ?? '9').localeCompare(String(b.due_date ?? '9')));

function cycleStrip(i) {
  const st = statusOf(i), name = st?.name ?? '';
  // Where the ticket is: to do → plan/start; in progress → build/track; review or test → ship; done → done.
  const now = st?.category === 'DONE' ? 5 : /review|test|qa/i.test(name) ? 4 : st?.category === 'IN_PROGRESS' ? 2 : 0;
  const running = S.timer?.key === i.key;
  const canPlan = !['SUBTASK', 'TEST'].includes(i.issue_type);
  const steps = [ // label, short action, act, enabled, tooltip
    ['Plan', 'Break down', 'plan', canPlan, canPlan ? 'Split into subtasks, optionally drafted by Claude' : 'Subtasks are not broken down further'],
    ['Start', 'Branch', 'start', true, 'Create the branch or a worktree, assign to you, move to In Progress, start the timer'],
    ['Build', 'Claude', 'claude', true, "Implement with Claude Code in the ticket's own checkout"],
    ['Track', running ? `Stop ${clock(S.timer.start)}` : 'Timer', 'timer', true, running ? 'Stop the timer and log the time' : 'Start a timer on this ticket'],
    ['Ship', 'Open PR', 'pr', true, 'Push, open the pull request, move the ticket to review'],
    ['Done', 'Finish', 'finish', true, 'Set the final status, log the timer, remove the branch or worktree'],
  ];
  return `<div class="cycle" role="group" aria-label="Development cycle">${steps.map(([label, what, act, on, tip], n) =>
    `<button class="step ${n < now ? 'past' : n === now ? 'now' : ''} ${act === 'timer' && running ? 'running' : ''}" data-act="${act}" data-key="${esc(i.key)}" title="${esc(tip)}" ${on ? '' : 'disabled'}>
      <span class="what"><b><span class="n">${n + 1}</span>${label}</b><small>${what}</small></span></button>`).join('')}</div>`;
}
// Keep the running timer's minutes current without re-rendering anything else.
setInterval(() => {
  const el = document.querySelector('.step.running small');
  if (el && S.timer) el.textContent = `Stop ${clock(S.timer.start)}`;
}, 15000);

// ---------- standup: the previous workday's commits by ticket, today's plan ----------
async function openStandup() {
  const from = previousWorkday(), to = new Date();
  to.setHours(0, 0, 0, 0);
  const [commits, mine] = await Promise.all([host('commits', from.toISOString(), to.toISOString()), S.view === 'today' || S.view === 'mine' ? S.issues : fetchMine()]);
  const byKey = groupBy(commits.filter((c) => c.key), (c) => c.key);
  const found = Object.fromEntries(await Promise.all([...byKey.keys()].map(async (k) => [k, mine.find((i) => i.key === k) ?? (await fetchIssue(k).catch(() => null))])));
  const line = (i, extra) => `• ${i.key} ${i.title}${extra ? ` (${extra})` : ''}`;
  const yesterday = [
    ...[...byKey].map(([k, cs]) => (found[k] ? line(found[k], [plural(cs.length, 'commit'), statusOf(found[k])?.name].filter(Boolean).join(', ')) : `• ${k} (${plural(cs.length, 'commit')})`)),
    ...commits.filter((c) => !c.key).map((c) => `• ${c.subject}`),
  ];
  const todayList = [...mine.filter((i) => statusOf(i)?.category === 'IN_PROGRESS'), ...upNext(mine).slice(0, 2)].map((i) => line(i, statusOf(i)?.name));
  const label = from.toDateString() === new Date(Date.now() - 864e5).toDateString() ? 'Yesterday' : from.toLocaleDateString(undefined, { weekday: 'long' });
  const text = `*${label}*\n${yesterday.join('\n') || '• (no commits)'}\n\n*Today*\n${todayList.join('\n') || '• …'}\n\n*Blockers*\n• None`;
  S.modal = { kind: 'standup', text, local: text, label, source: 'commits' };
  renderOverlay();
  $('#standup')?.focus();
}
const standupModal = () => `<div class="scrim" style="z-index:40" data-act="close-modal"></div>
  <div class="modal standup" role="dialog" aria-label="Standup">
    ${S.me.ai_enabled ? `<div class="seg"><button class="${S.modal.source === 'commits' ? 'on' : ''}" data-act="standup-source" data-src="commits">From my commits</button><button class="${S.modal.source === 'ai' ? 'on' : ''}" data-act="standup-source" data-src="ai" ${S.modal.aiLoading ? 'disabled' : ''}>${ic('sparkle', 'currentColor', 12)}${S.modal.aiLoading ? 'Writing…' : "The app's AI"}</button></div>` : ''}
    <h2>${ic('comment')}Standup<span class="muted normal">${esc(S.modal.label)}'s commits by ticket, and today's plan. Edit, then copy.</span></h2>
    <textarea class="field-input" id="standup" data-keep="standup" rows="14">${esc(S.modal.text)}</textarea>
    <div class="actions"><span class="muted grow">Formatted for Slack or Teams</span>
      <button class="btn" data-act="close-modal">Close</button><button class="btn primary" data-act="copy-standup">${ic('copy')}Copy</button></div>
  </div>`;

// ---------- Today ----------
const stat = (v, label, iconName) => `<div class="stat"><b>${esc(v)}${iconName ? ic(iconName, 'currentColor', 18) : ''}</b><span>${esc(label)}</span></div>`;

// The shape of your day on one line: commits as ticks, stretches of flow between them, focus sessions, breaks, now.
const FLOW_GAP = 90; // minutes: commits closer than this are one stretch of work
function dayRuler(t) {
  const mid = new Date();
  mid.setHours(0, 0, 0, 0);
  const hr = (ms) => (ms - mid) / 36e5, now = hr(Date.now());
  const commits = t.commits.map((c) => ({ h: hr(c.time * 1000), c })).sort((a, b) => a.h - b.h);
  const evs = FUN.events.filter((e) => e.t >= +mid);
  const focus = evs.filter((e) => e.type === 'focus').map((e) => [hr(e.t - (e.minutes ?? 25) * 6e4), hr(e.t)]);
  const marks = evs.filter((e) => ['break', 'pr', 'finish'].includes(e.type)).map((e) => ({ h: hr(e.t), type: e.type, key: e.key }));
  const all = [...commits.map((x) => x.h), ...focus.flat(), ...marks.map((m) => m.h)];
  const from = Math.max(0, Math.floor(Math.min(9, ...all))), to = Math.min(24, Math.ceil(Math.max(19, now + 0.5, ...all)));
  const x = (h) => `${(((Math.min(to, Math.max(from, h)) - from) / (to - from)) * 100).toFixed(2)}%`;
  const flows = [];
  for (const { h } of commits) {
    const last = flows.at(-1);
    if (last && (h - last[1]) * 60 <= FLOW_GAP) last[1] = h;
    else flows.push([h - 0.25, h]); // a commit stands for at least the quarter hour before it
  }
  const at = (h) => { const d = new Date(+mid + h * 36e5); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  const MARK = { break: ['stretch', 'Stretch break'], pr: ['pr', 'Pull request'], finish: ['check', 'Finished'] };
  const hours = Array.from({ length: to - from + 1 }, (_, n) => from + n);
  const flowMin = Math.round(flows.reduce((a, [s, e]) => a + (e - s), 0) * 60);
  return `<div class="ruler" aria-label="Your day">
    <div class="ruler-head"><span class="label">Your day</span><span class="muted small">${commits.length ? `${plural(commits.length, 'commit')} · about ${fmtDuration(Math.round(flowMin / 5) * 5) || '0m'} in flow` : 'Commits, focus sessions and breaks show up here as the day goes'}</span><span class="grow"></span>
      <span class="legend"><i class="lg-tick"></i>commit<i class="lg-flow"></i>flow<i class="lg-focus"></i>focus</span></div>
    <div class="ruler-track">
      ${hours.map((h) => `<i class="hour ${h % 3 ? '' : 'major'}" style="left:${x(h)}"></i>`).join('')}
      ${flows.map(([a, b]) => `<span class="flow" style="left:${x(a)};width:calc(${x(b)} - ${x(a)})" title="Working ${at(a)}–${at(b)}"></span>`).join('')}
      ${focus.map(([a, b]) => `<span class="focus-run" style="left:${x(a)};width:calc(${x(b)} - ${x(a)})" title="Focus session ${at(a)}–${at(b)}"></span>`).join('')}
      ${commits.map(({ h, c }) => `<i class="tick ${c.key ? '' : 'loose'}" style="left:${x(h)}" title="${esc(`${at(h)}  ${c.subject}`)}"></i>`).join('')}
      ${marks.map((m) => `<span class="mark" style="left:${x(m.h)}" title="${esc(`${at(m.h)}  ${MARK[m.type][1]}${m.key ? ` ${m.key}` : ''}`)}">${ic(MARK[m.type][0], 'currentColor', 12)}</span>`).join('')}
      ${now <= to ? `<i class="now" style="left:${x(now)}"><span>${at(now)}</span></i>` : ''}
    </div>
    <div class="ruler-scale">${hours.filter((h) => h % 3 === 0 || h === from).map((h) => `<span style="left:${x(h)}">${String(h).padStart(2, '0')}:00</span>`).join('')}</div>
  </div>`;
}
const safeDur = (s) => { try { return s?.trim() ? parseDuration(s) : 0; } catch { return 0; } };
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const commitLi = (c) =>
  `<li><code>${esc(c.hash.slice(0, 7))}</code> <span class="muted">${new Date(c.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> ${esc(c.subject)}</li>`;

function todayFoot() {
  const sel = S.today.rows.filter((r) => r.on && safeDur(r.minutes));
  const total = sel.reduce((a, r) => a + safeDur(r.minutes), 0);
  return `<span class="muted">${plural(sel.length, 'ticket')} selected</span><span class="grow"></span>
    <button class="btn primary" data-act="today-log" ${sel.length ? '' : 'disabled'}>${ic('check')}Log ${fmtDuration(total) || 'time'}${sel.length ? ` on ${plural(sel.length, 'ticket')}` : ''}</button>`;
}

function logRow(r, n) {
  const f = S.today.found[r.key], i = f.issue;
  return `<div class="log-row ${r.on ? '' : 'off'}">
    <input type="checkbox" data-today="on" data-row="${n}" ${r.on ? 'checked' : ''} aria-label="Include ${esc(i.key)}">
    <div class="grow" style="min-width:0">
      <div class="row">${typeIcon(i.issue_type)}<a class="key link" data-act="open" data-key="${esc(i.key)}">${esc(i.key)}</a><span class="title-text">${esc(i.title)}</span></div>
      <details><summary class="muted">${plural(f.commits.length, 'commit')}${f.loggedToday ? ` · already logged ${fmtDuration(f.loggedToday)} today` : ''}</summary><ul class="commits">${f.commits.map(commitLi).join('')}</ul></details>
    </div>
    <input class="field-input dur" data-today="minutes" data-row="${n}" value="${esc(r.minutes)}" placeholder="0m" aria-label="Time for ${esc(i.key)}">
    <input class="field-input note" data-today="note" data-row="${n}" value="${esc(r.note)}" placeholder="Note" aria-label="Note for ${esc(i.key)}">
  </div>`;
}

// The greeting's colour block follows the time of day: gold morning, orange afternoon, violet evening, blue night.
const SKY = { morning: '#F5C451', afternoon: '#F28C28', evening: '#8B5CF6', night: '#3B82F6' };
const skyOf = (h) => (h >= 5 && h < 12 ? 'morning' : h < 17 && h >= 12 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'night');
function todayView() {
  const t = S.today;
  if (!t) return '<div class="skeleton"></div>'.repeat(3);
  const h = new Date().getHours();
  const hello = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const logged = Object.values(t.found).reduce((a, f) => a + f.loggedToday, 0);
  const prog = S.issues.filter((i) => statusOf(i)?.category === 'IN_PROGRESS');
  const next = upNext(S.issues);
  const untracked = groupBy(t.untracked, (c) => c.branch || '(no branch)');
  return `<div class="today">
    <header class="hero" style="--sky:${SKY[skyOf(h)]}">
      <div class="hero-sky">${mascot(84, heroMood(prog))}</div>
      <div class="hero-text"><div class="label hero-date">${esc(new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
          <h1>${hello}, ${esc(S.me.first_name || S.me.username)}</h1>
          <div class="muted">${prog.length ? `${plural(prog.length, 'ticket')} in progress` : 'Nothing in progress yet'}${S.issues.some(overdue) ? ` · <span class="danger">${plural(S.issues.filter(overdue).length, 'overdue ticket')}</span>` : ''}</div>
          <div class="tip">${ic('sparkle', 'currentColor', 12)}${esc(tipOfTheDay())}</div></div>
      <div class="stats">${stat(t.commits.filter((c) => !t.elsewhere?.has(c.key)).length, 'commits today')}${stat(Object.keys(t.found).length, 'tickets touched')}${stat(fmtDuration(logged) || '0m', 'logged today')}${stat(streak(FUN.events), 'day streak', 'flame')}</div>
      ${dayRuler(t)}
    </header>
    ${workdayBox(S.att, Date.now(), { wide: true })}

    ${firstUp()}
    <div class="funbar">
      <button class="fun" data-act="lucky">${ic('dice', 'currentColor', 20)}<span><b>Lucky dip</b><small>Let the machine pick your next ticket</small></span></button>
      <button class="fun" data-act="focus">${ic('eye', 'currentColor', 20)}<span><b>Focus 25</b><small>A Pomodoro, then a stretch</small></span></button>
      <button class="fun" data-act="take-break">${ic('stretch', 'currentColor', 20)}<span><b>Stretch</b><small>Two minutes, guided</small></span></button>
      <button class="fun" data-act="wrapped">${ic('trophy', 'currentColor', 20)}<span><b>My week</b><small>Your week, wrapped</small></span></button>
      <button class="fun" data-act="shutdown">${ic('moon', 'currentColor', 20)}<span><b>Wind down</b><small>Log, note, pick tomorrow</small></span></button>
    </div>
    <section class="panel">
      <h3>${ic('clock')}Log today's time<span class="muted normal">Suggested from the gaps between your commits. Adjust, then log.</span></h3>
      ${t.rows.length
        ? `<div>${t.rows.map(logRow).join('')}</div><div class="panel-foot today-foot">${todayFoot()}</div>`
        : `<p class="muted">${t.elsewhere?.size ? 'Nothing to log in this project today.' : t.commits.length ? "None of today's commits are linked to a ticket yet. See Untracked work below." : 'No commits yet today. Your commits show up here, grouped by ticket.'}</p>`}
      ${t.elsewhere?.size ? `<p class="muted small">${plural(t.elsewhere.size, 'other ticket')} you committed to today ${t.elsewhere.size === 1 ? 'is' : 'are'} in another project. <a class="link" data-act="goto-project" data-id="">Show all projects</a></p>` : ''}
    </section>

    ${untracked.size ? `<section class="panel warn">
      <h3>${ic('alert')}Untracked work<span class="muted normal">Commits with no ticket. Create one, or link the branch to an existing ticket.</span></h3>
      ${[...untracked].map(([branch, cs]) => `<div class="untracked">
        <div class="row">${ic('branch')}<b>${esc(branch)}</b><span class="muted">${plural(cs.length, 'commit')} · ~${fmtDuration(timeFromCommits(cs.map((c) => ({ time: c.time })))[''])}</span><span class="grow"></span>
          ${branch === '(no branch)' ? '' : `<button class="btn small" data-act="today-link" data-branch="${esc(branch)}">Link to ticket…</button>`}
          <button class="btn small primary" data-act="today-create" data-branch="${esc(branch)}">${ic('plus')}Create ticket</button></div>
        <ul class="commits">${cs.map(commitLi).join('')}</ul></div>`).join('')}
    </section>` : ''}

    <section><div class="group-title">${statusIcon({ category: 'IN_PROGRESS' })}In progress<span class="count">${prog.length}</span></div>
      ${prog.length ? table(prog, ['assignee']) : '<p class="empty">Nothing in progress. Start something from Up next.</p>'}</section>

    <section><div class="group-title">${statusIcon({ category: 'TODO' })}Up next<span class="count">${next.length}</span></div>
      ${next.length ? `<div class="next-list">${next.slice(0, 15).map((i) => `<div class="next">
        ${typeIcon(i.issue_type)}${prioIcon(i.priority)}<a class="key link" data-act="open" data-key="${esc(i.key)}">${esc(i.key)}</a>
        <span class="link grow" data-act="open" data-key="${esc(i.key)}">${esc(i.title)}</span>
        ${i.due_date ? `<span class="meta ${overdue(i) ? 'danger' : 'muted'}">${ic('calendar')}${fmtDate(i.due_date)}</span>` : ''}
        ${i.issue_type !== 'SUBTASK' ? `<button class="btn small" data-act="plan" data-key="${esc(i.key)}" title="Break down into subtasks">${ic('t_subtask')}</button>` : ''}
        <button class="btn small" data-act="today-start" data-key="${esc(i.key)}" title="Branch or worktree + In Progress">${ic('branch')}Start</button>
      </div>`).join('')}</div>` : '<p class="empty">Your queue is empty.</p>'}</section>
    ${badgesView()}
  </div>`;
}

async function logToday() {
  const rows = S.today.rows.filter((r) => r.on && safeDur(r.minutes));
  rows.forEach((r) => parseDuration(r.minutes)); // surface a typo before logging anything
  for (const r of rows) {
    const i = S.today.found[r.key].issue;
    await api('/api/worklogs/', { method: 'POST', body: { issue: i.id, minutes: parseDuration(r.minutes), logged_on: today(), note: r.note.trim() } });
    r.on = false; // a retry after a failure won't double-log this one
  }
  toast(`Logged ${fmtDuration(rows.reduce((a, r) => a + parseDuration(r.minutes), 0))} on ${plural(rows.length, 'ticket')}`);
  host('changed');
  load();
}

// ---------- breakdown: draft (by hand or with Claude) → review → approve → create → start ----------
const blankRow = (r = {}) => ({ on: true, title: '', description: '', estimate: '', assignee: S.me.id, open: false, ...r });
const childType = (p) => (p.issue_type === 'EPIC' ? 'STORY' : 'SUBTASK');
const childWord = (p, n = 2) => (childType(p) === 'STORY' ? (n === 1 ? 'story' : 'stories') : n === 1 ? 'subtask' : 'subtasks');

function openPlan(issue) {
  S.modal = {
    kind: 'plan', parent: issue, rows: [blankRow()], approach: '', useApproach: true, guidance: '',
    then: S.startWorkIn === 'worktree' ? 'worktree' : 'branch', drafting: false, creating: null,
  };
  S.menu = null;
  renderOverlay();
  $('.plan [data-plan=title]')?.focus();
}

function planFoot() {
  const m = S.modal, rows = m.rows.filter((r) => r.on && r.title.trim());
  if (m.creating != null) return `<span class="spinner"></span><span>Creating ${m.creating + 1} of ${m.creatingOf}…</span>`;
  const total = rows.reduce((a, r) => a + safeDur(r.estimate), 0);
  return `<span class="muted">${plural(rows.length, childWord(m.parent, 1), childWord(m.parent))} · ${fmtDuration(total) || 'no'} estimate</span><span class="grow"></span>
    <label class="cellflex muted">Then<select class="field-input" data-plan-field="then">${options([
      ['none', 'stay here'], ['branch', `start ${m.parent.key} on a branch here`], ['worktree', `start ${m.parent.key} in a new worktree`],
    ], m.then)}</select></label>
    <button class="btn" data-act="close-modal">Cancel</button>
    <button class="btn primary" data-act="plan-create" ${rows.length ? '' : 'disabled'}>${ic('check')}Approve & create ${rows.length || ''}</button>`;
}

const planRow = (r, n) => `<div class="plan-row ${r.on ? '' : 'off'}">
  <input type="checkbox" data-plan="on" data-row="${n}" ${r.on ? 'checked' : ''} title="Include this one">
  <span class="num">${n + 1}</span>
  <div class="grow" style="min-width:0">
    <input class="field-input" data-plan="title" data-row="${n}" value="${esc(r.title)}" placeholder="Title, e.g. Add retry queue table">
    <details data-row="${n}" ${r.open ? 'open' : ''}><summary class="muted">${r.description ? 'Description' : 'Add a description'}${r.ai ? ' · drafted by Claude' : ''}</summary>
      <textarea class="field-input" data-plan="description" data-row="${n}" rows="7">${esc(r.description)}</textarea></details>
  </div>
  <input class="field-input est" data-plan="estimate" data-row="${n}" value="${esc(r.estimate)}" placeholder="Est. 2h" aria-label="Estimate">
  <select class="field-input who" data-plan="assignee" data-row="${n}" aria-label="Assignee">${options(assigneeOpts(), r.assignee)}</select>
  <button class="icon-btn" data-act="plan-remove" data-row="${n}" title="Remove">${ic('close')}</button>
</div>`;

function planModal() {
  const m = S.modal, p = m.parent, kids = p.children ?? [];
  return `<div class="scrim" style="z-index:40" data-act="close-modal"></div>
  <div class="modal plan" role="dialog" aria-label="Break down ${esc(p.key)}">
    <h2>${ic('t_subtask')}Break down <span class="key">${esc(p.key)}</span><span class="plan-title">${esc(p.title)}</span></h2>
    ${kids.length ? `<div class="muted small">Already has ${plural(kids.length, childWord(p, 1), childWord(p))}: ${kids.map((c) => esc(c.key)).join(', ')}</div>` : ''}
    <div class="ai">
      <div class="row">
        <input class="field-input grow" data-plan-field="guidance" value="${esc(m.guidance)}" placeholder="Optional guidance for Claude, e.g. keep the API backwards compatible, tests first">
        <button class="btn ai-btn" data-act="plan-draft" ${m.drafting ? 'disabled' : ''}>${ic('sparkle')}${m.drafting ? 'Drafting…' : m.approach ? 'Redraft with Claude' : 'Draft with Claude'}</button>
      </div>
      ${m.drafting
        ? `<div class="drafting"><span class="spinner"></span>Claude is reading your codebase and drafting ${childWord(p)}. This usually takes 30–90 seconds.</div>`
        : `<div class="muted small">Claude Code reads the open repository (read-only) and proposes a plan with ${childWord(p)}. Nothing is created until you approve.</div>`}
    </div>
    ${m.approach ? `<div class="approach"><label class="cellflex"><input type="checkbox" data-plan-field="useApproach" ${m.useApproach ? 'checked' : ''}><b>Add this plan to ${esc(p.key)}'s description</b></label><div class="md">${md(m.approach)}</div></div>` : ''}
    <div class="plan-rows">${m.rows.map(planRow).join('')}</div>
    <div><button class="btn small" data-act="plan-add">${ic('plus')}Add ${childWord(p, 1)}</button></div>
    <div class="plan-foot" id="plan-foot">${planFoot()}</div>
  </div>`;
}

async function draftPlan() {
  const m = S.modal;
  m.drafting = true;
  renderOverlay();
  try {
    const d = await host('draftBreakdown', m.parent, m.guidance.trim() || null);
    if (S.modal !== m) return;
    const drafted = d.subtasks.map((x) => blankRow({ ai: true, title: x.title, description: x.description, estimate: fmtDuration(Math.round((x.estimate_minutes ?? 0) / 15) * 15) }));
    m.rows = [...m.rows.filter((r) => r.title.trim() && !r.ai), ...drafted]; // a redraft replaces Claude's rows, keeps yours
    m.approach = d.approach;
  } finally {
    m.drafting = false;
    if (S.modal === m) renderOverlay();
  }
}

async function createPlan() {
  const m = S.modal, p = m.parent;
  const rows = m.rows.filter((r) => r.on && r.title.trim());
  rows.forEach((r) => r.estimate.trim() && parseDuration(r.estimate)); // surface a typo before creating anything
  await statusesFor(p.project);
  const status = statusesOf(p.project)[0]?.id ?? null;
  m.creating = 0;
  m.creatingOf = rows.length;
  $('#plan-foot').innerHTML = planFoot();
  try {
    for (const r of rows) {
      await api('/api/issues/', {
        method: 'POST',
        body: {
          project: p.project, parent: p.id, issue_type: childType(p), title: r.title.trim(), description: r.description,
          priority: p.priority ?? 'MEDIUM', status, assignee: coerce('assignee', p, String(r.assignee ?? '')), sprint: p.sprint ?? null,
          ...(r.estimate.trim() && { estimate_minutes: parseDuration(r.estimate) }),
        },
      });
      m.rows.splice(m.rows.indexOf(r), 1); // a retry after a failure won't create this one twice
      m.creating++;
      $('#plan-foot').innerHTML = planFoot();
    }
    if (m.useApproach && m.approach) {
      const description = `${(p.description ?? '').trimEnd()}\n\n## Plan\n\n${m.approach.trim()}`.trimStart();
      await api(`/api/issues/${p.id}/`, { method: 'PATCH', body: { description } });
    }
  } finally {
    m.creating = null;
    if (S.modal === m) renderOverlay();
  }
  S.modal = null;
  host('record', { type: 'breakdown', key: p.key });
  toast(`Created ${plural(rows.length, childWord(p, 1), childWord(p))} under ${p.key}`, false, p.key);
  host('changed');
  load();
  await openIssue(p.key);
  if (m.then !== 'none') await host('startWork', p, m.then);
}

// ---------- writing help: ticket health, duplicates, the app's AI ----------
const healthItems = (q) => q.checks.map((c) => `<li class="${c.ok ? 'ok' : c.warn ? 'warn' : 'miss'}">${ic(c.ok ? 'check' : 'alert', 'currentColor', 13)}<span><b>${esc(c.label)}</b>${c.ok ? '' : `<span class="muted"> · ${esc(c.hint)}</span>`}</span></li>`).join('');
const healthBar = (score) => `<span class="health-score" style="--q:${score}%" title="Ticket health ${score}%"><i></i></span><b class="mono">${score}%</b>`;
function draftFromForm() {
  const f = $('form[data-form=create]');
  if (!f) return { title: S.modal?.pre?.title ?? '', description: S.modal?.pre?.description ?? '', issue_type: S.modal?.pre?.issue_type ?? 'TASK' };
  let est = 0;
  try { est = f.estimate.value.trim() ? parseDuration(f.estimate.value) : 0; } catch {}
  return { title: f.title.value, description: f.description.value, issue_type: f.issue_type.value, estimate_minutes: est };
}
const healthPanel = (draft) => { const q = ticketQuality(draft); return `<div class="health"><div class="row"><span class="label">Ticket health</span>${healthBar(q.score)}</div><ul>${healthItems(q)}</ul></div>`; };
function healthStrip(i) {
  const q = ticketQuality(i);
  const missing = q.checks.filter((c) => !c.ok);
  return `<details class="health strip" ${S.drawer.healthOpen ? 'open' : ''} data-keep-open="health">
    <summary><span class="label">Ticket health</span>${healthBar(q.score)}<span class="muted small">${missing.length ? `${missing.length} to improve` : 'Looks complete'}</span><span class="grow"></span>
      ${missing.some((c) => ['criteria', 'repro', 'why', 'description'].includes(c.id)) ? `<button class="btn small" data-act="health-template">${ic('file')}Add missing sections</button>` : ''}</summary>
    <ul>${healthItems(q)}</ul></details>`;
}

let similarTimer;
function checkSimilar() {
  clearTimeout(similarTimer);
  similarTimer = setTimeout(async () => {
    const f = $('form[data-form=create]'), box = $('#new-similar');
    const q = f?.title.value.trim() ?? '';
    if (!box) return;
    if (q.length < 3) return void (box.innerHTML = '');
    const xs = list(await api(`/api/issues/similar/?${new URLSearchParams({ project: S.modal.pid, q })}`).catch(() => [])).slice(0, 5);
    if ($('form[data-form=create]')?.title.value.trim() !== q) return; // typed on meanwhile
    box.innerHTML = xs.length ? `<div class="similar"><span class="label">Similar open issues · is this a duplicate?</span>
      ${xs.map((x) => `<a class="row link" data-act="web" data-key="${esc(x.key)}">${statusIcon({ category: x.category ?? x.status_detail?.category })}<span class="key">${esc(x.key)}</span><span class="grow">${esc(x.title)}</span>${ic('external', 'currentColor', 12)}</a>`).join('')}</div>` : '';
  }, 400);
}

async function draftNotes() {
  const text = $('#notes')?.value.trim() ?? '';
  if (text.length < 10) return toast('Paste at least a sentence or two for the AI to work with.', true);
  S.modal.drafting = true;
  renderOverlay();
  try {
    const d = await api('/api/issues/draft/', { method: 'POST', body: { project: S.modal.pid, text } });
    const f = $('form[data-form=create]');
    if (d.title) f.title.value = d.title;
    if (d.description) f.description.value = d.description;
    if (TYPES.includes(d.issue_type)) f.issue_type.value = d.issue_type;
    if (PRIORITIES.includes(d.priority)) f.priority.value = d.priority;
    const tagIds = (d.tags ?? []).map((t) => S.tags.find((x) => same(x.id, t) || same(x.id, t?.id) || x.title?.toLowerCase() === String(t?.title ?? t).toLowerCase())?.id).filter(Boolean);
    S.modal.tags = [...new Set([...(S.modal.tags ?? []), ...tagIds])];
    S.modal.drafted = true;
  } finally {
    S.modal.drafting = false;
    renderOverlay();
    refreshHealth();
    checkSimilar();
  }
}
const refreshHealth = () => { const el = $('#new-health'); if (el) el.innerHTML = healthPanel(draftFromForm()); };

function summarySection(d) {
  const sm = d.summary;
  return `<section class="ai-summary"><h3>${ic('sparkle')}AI summary<span class="grow"></span>
    ${sm?.text ? `<span class="muted normal small">${ago(sm.at)}</span><button class="btn small" data-act="summarize" data-fresh="1" ${sm.loading ? 'disabled' : ''}>${ic('refresh')}Regenerate</button>`
      : `<button class="btn small" data-act="summarize" ${sm?.loading ? 'disabled' : ''}>${ic('sparkle')}${sm?.loading ? 'Summarizing…' : 'Summarize'}</button>`}</h3>
    ${sm?.loading ? '<div class="skeleton"></div><p class="muted small">This can take up to 30 seconds.</p>' : sm?.error ? `<p class="muted">${esc(sm.error)}</p>` : sm?.text ? `<div class="md">${md(sm.text)}</div><p class="muted small">From the description, comments and history. Check before relying on it.</p>` : ''}
  </section>`;
}
async function summarize(fresh) {
  const d = S.drawer, key = d.key;
  d.summary = { ...d.summary, loading: true, error: null };
  renderOverlay();
  try {
    const r = await host('req', `/api/issues/${d.issue.id}/summary/`, fresh ? { headers: { 'Cache-Control': 'no-cache' } } : null);
    if (S.drawer?.key === key) S.drawer.summary = { text: r?.text ?? '', at: r?.generated_at ?? new Date().toISOString() };
  } catch (e) {
    if (S.drawer?.key === key) S.drawer.summary = { error: e.message };
  }
  if (S.drawer?.key === key) renderOverlay();
}

function improveBox(d) {
  const im = d.improve;
  if (!im || im.loading) return '';
  if (im.error) return `<div class="suggest"><p class="muted">${esc(im.error)}</p><div class="actions"><button class="btn small" data-act="improve-discard">Close</button></div></div>`;
  return `<div class="suggest"><div class="row"><span class="label">${ic('wand')}Suggested rewrite</span><span class="grow"></span><span class="muted small">by the app's AI</span></div>
    <div class="suggest-title">${esc(im.title)}</div><div class="md">${md(im.description)}</div>
    <div class="actions"><button class="btn small" data-act="improve-discard">Discard</button><button class="btn small primary" data-act="improve-accept">${ic('check')}Use it</button></div></div>`;
}
async function improve() {
  const d = S.drawer, i = d.issue, key = d.key;
  d.improve = { loading: true };
  renderOverlay();
  try {
    const r = await api('/api/issues/draft/', { method: 'POST', body: { project: i.project, text: `${i.title}\n\n${i.description ?? ''}`.slice(0, 4000) } });
    if (S.drawer?.key === key) S.drawer.improve = { title: r.title || i.title, description: r.description || i.description || '' };
  } catch (e) {
    if (S.drawer?.key === key) S.drawer.improve = { error: e.message };
  }
  if (S.drawer?.key === key) renderOverlay();
}

// ---------- attachments ----------
const urlCache = new Map(); // id -> {url, at}; signed URLs expire, so refresh after a few minutes
async function attachmentSrc(id, download) {
  const k = `${id}:${download ? 1 : 0}`, c = urlCache.get(k);
  if (c && Date.now() - c.at < 4 * 60e3) return c.url;
  const { url } = await host('attachmentUrl', id, !!download);
  urlCache.set(k, { url, at: Date.now() });
  return url;
}
function hydrate(root) {
  root.querySelectorAll('img[data-attachment]:not([src])').forEach(async (img) => {
    try { img.src = await attachmentSrc(img.dataset.attachment); } catch { img.alt = `${img.alt || 'image'} (unavailable)`; }
  });
}
const KIND_ICON = { image: 'image', video: 'image', pdf: 'file', file: 'clip' };
function attachmentsSection(i, d) {
  const xs = i.attachments ?? [];
  return `<section class="attachments"><h3>${ic('clip')}Attachments${xs.length ? `<span class="count">${xs.length}</span>` : ''}<span class="grow"></span>
    <button class="btn small" data-act="attach-pick" ${d.uploading ? 'disabled' : ''}>${ic('upload')}${d.uploading ? 'Uploading…' : 'Attach files'}</button></h3>
    ${xs.length ? `<div class="att-list">${xs.map((a) => {
      const kind = attachmentKind(a.name);
      return `<div class="att">
        <button class="att-main" data-act="att-open" data-id="${esc(a.id)}" data-name="${esc(a.name)}">${kind === 'image' ? `<img class="att-thumb" data-attachment="${esc(a.id)}" alt="">` : ic(KIND_ICON[kind], 'currentColor', 18)}
          <span class="att-name">${esc(a.name)}</span></button>
        <span class="att-ext">${esc((a.name.split('.').pop() || 'file').slice(0, 5))}</span>
        <span class="muted small att-size">${a.size != null ? fmtSize(a.size) : ''}</span>
        <button class="icon-btn" data-act="att-download" data-id="${esc(a.id)}" title="Download">${ic('download')}</button>
        <button class="icon-btn ${d.confirmDelete === a.id ? 'danger' : ''}" data-act="att-delete" data-id="${esc(a.id)}" title="${d.confirmDelete === a.id ? 'Click again to delete' : 'Delete'}">${ic('trash')}</button>
      </div>`;
    }).join('')}</div>` : '<p class="empty">Drop files here, paste a screenshot into the description or a comment, or use Attach files.</p>'}
  </section>`;
}
async function openAttachment(id, name) {
  const kind = attachmentKind(name);
  const url = await attachmentSrc(id);
  if (kind === 'image' || kind === 'video') return showLightbox({ url, kind, name });
  host('openExternal', url);
}
function showLightbox(lb) {
  $('#lightbox').innerHTML = `<div class="lightbox" data-act="lightbox-close">
    ${lb.kind === 'video' ? `<video src="${esc(lb.url)}" controls autoplay></video>` : `<img src="${esc(lb.url)}" alt="${esc(lb.name)}">`}
    <div class="lb-bar"><span>${esc(lb.name)}</span><span class="grow"></span><button class="btn small" data-act="lightbox-close">Close <span class="kbd">Esc</span></button></div></div>`;
}
const fileToPayload = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve({ name: file.name || `pasted-${Date.now()}.png`, type: file.type, data: String(r.result).split(',')[1], size: file.size });
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});
async function uploadToIssue(files) {
  const d = S.drawer, i = d.issue, key = d.key;
  const big = files.find((f) => f.size > 20 * 1024 * 1024);
  if (big) throw new Error(`${big.name} is larger than 20 MB, the app's limit.`);
  d.uploading = true;
  renderOverlay();
  try {
    const up = await host('attachBytes', { id: i.id, key: i.key }, await Promise.all(files.map(fileToPayload)));
    toast(`Attached ${plural(up.length, 'file')} to ${key}`);
    return up;
  } finally {
    if (S.drawer?.key === key) { S.drawer.uploading = false; await openIssue(key); }
  }
}
// New-issue dialog: files wait in memory until the issue exists.
let newRef = 0;
const pendingFiles = () => {
  const fs = S.modal?.files ?? [];
  return fs.length ? `<div class="pending">${fs.map((x, n) => `<span class="tag" style="--c:var(--brand)">${ic('clip', 'currentColor', 12)}${esc(x.name)} · ${fmtSize(x.size)}<button type="button" class="x" data-act="unpend" data-n="${n}" aria-label="Remove">×</button></span>`).join('')}
    <span class="muted small">uploaded when you create the issue</span></div>` : '';
};
async function addPending(files, textarea) {
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { toast(`${f.name} is larger than 20 MB`, true); continue; }
    const p = await fileToPayload(f);
    const ref = `attachment:new-${++newRef}`;
    const inline = attachmentKind(p.name) === 'image' && !!textarea;
    S.modal.files.push({ ...p, ref, inline });
    if (inline) insertAtCursor(textarea, `![${p.name}](${ref})`);
  }
  $('#new-files').innerHTML = pendingFiles();
}
function insertAtCursor(ta, text) {
  const { selectionStart: a, selectionEnd: b, value } = ta;
  const pad = a > 0 && value[a - 1] !== '\n' ? '\n' : '';
  ta.value = value.slice(0, a) + pad + text + '\n' + value.slice(b);
  ta.selectionStart = ta.selectionEnd = a + pad.length + text.length + 1;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------- celebrations ----------
function celebrate({ kind, title, detail, icon: iconName }) {
  const fx = $('#fx');
  if (!fx) return;
  const el = document.createElement('div');
  el.className = 'fx';
  el.innerHTML = `<div class="confetti">${Array.from({ length: 40 }, (_, k) => `<i style="--x:${(k * 41) % 100}vw;--d:${(k % 8) * 0.12}s;--r:${(k * 67) % 360}deg"></i>`).join('')}</div>
    <div class="cheer">${mascot(64, 'party')}<div><b>${esc(title)}</b>${detail ? `<div class="muted">${esc(detail)}</div>` : ''}</div>${iconName ? icon(iconName, { size: 28 }) : ''}</div>`;
  fx.append(el);
  setTimeout(() => el.remove(), 4200);
}
// ---------- fun: streaks, badges, lucky dip, wind-down, the week wrapped ----------
const FUN = { events: [], unlocked: {}, tomorrow: null };
async function loadFun() {
  const [j, t] = await Promise.all([host('journal').catch(() => null), host('tomorrow').catch(() => null)]);
  if (j) Object.assign(FUN, j);
  FUN.tomorrow = t;
}
const badgeList = () => badges(FUN.events).map((b) => ({ ...b, unlockedAt: b.unlockedAt ?? FUN.unlocked[b.id] ?? null }));
function heroMood(prog) {
  const h = new Date().getHours();
  const todays = FUN.events.filter((e) => ['pr', 'finish'].includes(e.type) && new Date(e.t).toDateString() === new Date().toDateString()).length;
  if (h >= 22 || h < 5) return 'sleepy';
  if (S.issues.some(overdue)) return 'sweat';
  if (todays) return 'party';
  return prog.length ? 'wink' : 'happy';
}
function firstUp() {
  const t = FUN.tomorrow;
  if (!t || t.date === today()) return ''; // set today: it's for tomorrow
  const i = S.issues.find((x) => x.key === t.key);
  return `<div class="first-up">${ic('flame')}<div class="grow"><span class="label">First up today</span>
      <div>${t.key ? `<a class="key link" data-act="open" data-key="${esc(t.key)}">${esc(t.key)}</a> ${esc(i?.title ?? '')}` : ''}</div>
      ${t.note ? `<div class="muted">Where you left off: ${esc(t.note)}</div>` : ''}</div>
    ${t.key ? `<button class="btn small primary" data-act="today-start" data-key="${esc(t.key)}">${ic('branch')}Start</button>` : ''}
    <button class="icon-btn" data-act="clear-first" title="Done with this">${ic('close')}</button></div>`;
}
function badgesView() {
  const xs = badgeList(), got = xs.filter((b) => b.unlockedAt);
  return `<section><div class="group-title">${ic('trophy')}Badges<span class="count">${got.length}/${xs.length}</span></div>
    <div class="badges">${xs.map((b) => `<div class="badge ${b.unlockedAt ? 'on' : ''}" title="${esc(b.hint)}">${icon(b.icon, { size: 22 })}<b>${esc(b.name)}</b>
      <span class="muted small">${b.unlockedAt ? `Earned ${fmtDate(new Date(b.unlockedAt).toLocaleDateString('en-CA'))}` : esc(b.hint)}</span></div>`).join('')}</div></section>`;
}

// ---------- Lucky dip: a slot machine. Three reels (type, priority, ticket) land on a pick weighted by priority
// and due date. Hold the type or priority reel to keep it for the next spin. Nothing is started until you say so.
const REELS = ['Type', 'Priority', 'Ticket'];
// My open issues, whichever view is showing (on Board/List, S.issues holds everyone's).
const myQueue = async () => (S.view === 'today' || S.view === 'mine' ? S.issues : S.today?.mine ?? (await fetchMine()));
// When my queue is empty: unassigned open work in the active sprint, up for grabs.
async function upForGrabs() {
  const q = new URLSearchParams({ workspace: S.workspace, assignee: 'none', open: 'true' });
  if (S.scope) q.set('project', S.scope);
  const xs = await pages(q);
  await Promise.all([...new Set(xs.map((i) => i.project))].flatMap((pid) => [statusesFor(pid), sprintsFor(pid)]));
  return xs.filter((i) => { const a = activeSprint(i.project); return a ? same(i.sprint, a.id) : true; });
}
// How a pick pays out: the banner, the mascot's face, how many chips rain, how long the WIN meter counts.
const MOOD = {
  jackpot: { title: 'Jackpot!', line: 'Urgent and worth it. Go get it.', face: 'party', chips: 110, count: 2600 },
  big: { title: 'Big win', line: 'High value, coming up soon.', face: 'happy', chips: 50, count: 1700 },
  win: { title: 'Nice pick', line: 'A solid next step.', face: 'wink', chips: 14, count: 700 },
  easy: { title: 'Easy money', line: 'Small and quick. Free points.', face: 'wink', chips: 24, count: 900 },
  bug: { title: 'Uh-oh, a bug', line: 'Somebody has to squash it.', face: 'sweat', chips: 0, count: 1500 },
};
// A bug still says how urgent it is.
const BUG_LINE = { jackpot: "And it's urgent. Squash it first.", big: 'A big one. Squash it soon.' };
const sfx = createSfx(() => S.sound);
function reelsFor(pick, from) {
  const any = (xs) => xs[Math.floor(Math.random() * xs.length)];
  const strip = (xs, final, len) => [...Array.from({ length: len }, () => any(xs)), final, any(xs)];
  return [strip(TYPES, pick.issue_type ?? 'TASK', 14), strip(PRIORITIES, pick.priority ?? 'MEDIUM', 20), strip(from.map((i) => i.key), pick.key, 26)];
}
const sym = (n, v) => (n === 0 ? `<div class="sym">${icon(`t_${String(v).toLowerCase()}`, { size: 38 })}<small>${esc(cap(v))}</small></div>`
  : n === 1 ? `<div class="sym">${icon(`p_${String(v).toLowerCase()}`, { size: 36 })}<small>${esc(cap(v))}</small></div>`
  : `<div class="sym key-sym">${esc(v)}</div>`);
const landedAt = (strip) => `calc(var(--sym) * ${-(strip.length - 3)})`;

const REEL_SECS = [1.3, 2.1, 3.4]; // the last reel takes its time
async function spinLucky(again) {
  const prev = S.modal?.kind === 'lucky' ? S.modal : null;
  let queue = again ? prev?.queue : null, source = prev?.source ?? 'queue';
  if (!queue) {
    queue = upNext((await myQueue()).filter(inScope));
    source = 'queue';
    if (!queue.length) { queue = upNext(await upForGrabs().catch(() => [])); source = 'grabs'; }
  }
  const holds = (again && prev?.holds) || {};
  const held = queue.filter((i) => (!holds.type || i.issue_type === holds.type) && (!holds.prio || i.priority === holds.prio));
  if (again && (holds.type || holds.prio) && !held.length) toast('Nothing left matches the held reels, so this spin uses everything.');
  const from = held.length ? held : queue;
  const pick = luckyPick(from);
  const total = from.reduce((a, i) => a + luckyWeight(i), 0);
  const m = S.modal = {
    kind: 'lucky', queue, source, pick, holds: held.length ? holds : {}, landed: false, spun: 0, won: 0, spins: (prev?.spins ?? 0) + (pick ? 1 : 0),
    odds: pick ? Math.max(1, Math.round((luckyWeight(pick) / total) * 100)) : 0, mood: pick ? luckyMood(pick) : null, reels: pick ? reelsFor(pick, from) : null,
  };
  renderOverlay();
  if (!pick) return;
  $('.lever')?.classList.add('pull');
  sfx('lever');
  const ticking = setInterval(() => sfx('tick'), 75);
  requestAnimationFrame(() => requestAnimationFrame(() => m.reels.forEach((strip, n) => {
    const el = $(`#strip-${n}`);
    if (!el) return;
    el.style.transition = `transform ${REEL_SECS[n]}s cubic-bezier(.18, .8, .3, 1.07)`;
    el.style.transform = `translateY(${landedAt(strip)})`;
    el.addEventListener('transitionend', () => {
      if (S.modal !== m) return clearInterval(ticking);
      m.spun = n + 1;
      el.parentElement.classList.add('stopped');
      sfx('stop', n);
      if (n === REELS.length - 2) { sfx('roll', REEL_SECS[n + 1] - REEL_SECS[n]); $('.casino')?.classList.add('suspense'); }
      if (n < REELS.length - 1) return;
      clearInterval(ticking);
      payOut(m);
    }, { once: true });
  })));
}
// The reels have landed: banner, sound, the WIN meter counting up, and chips (or bugs) from the sky.
function payOut(m) {
  m.landed = true;
  m.fresh = true; // one-shot flourishes (the shake, the flashes) play on this render only
  renderOverlay();
  m.fresh = false;
  sfx(m.mood);
  if (m.mood === 'bug') rain(26, 'bugs');
  else rain(MOOD[m.mood].chips, 'chips');
  const total = luckyPayout(m.pick), t0 = performance.now(), dur = MOOD[m.mood].count;
  const count = () => {
    if (S.modal !== m) return;
    const k = Math.min(1, (performance.now() - t0) / dur);
    m.won = k === 1 ? total : Math.floor((total * k) / 10) * 10;
    const el = $('#win');
    if (el) el.textContent = String(m.won).padStart(4, '0');
    if (k < 1) requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
}

function luckyModal() {
  const m = S.modal, p = m.pick, mood = m.landed ? MOOD[m.mood] : null;
  const meter = (label, v, tip, id = '') => `<div class="meter" title="${tip}"><span>${label}</span><b ${id && `id="${id}"`}>${esc(v)}</b></div>`;
  const lamps = `<span class="lamps" aria-hidden="true">${'<i></i>'.repeat(5)}</span>`;
  const reels = REELS.map((label, n) => `<div class="reel-col">
      <div class="reel-label">${label}</div>
      <div class="reel-win ${m.landed || m.spun > n ? 'stopped' : ''}">${p
        ? `<div class="strip" id="strip-${n}" style="transform:translateY(${m.landed ? landedAt(m.reels[n]) : 0})">${m.reels[n].map((v) => sym(n, v)).join('')}</div>`
        : '<div class="strip"><div class="sym blank">–</div><div class="sym blank">–</div><div class="sym blank">–</div></div>'}</div>
      ${n < 2 ? `<button class="hold ${m.holds[n ? 'prio' : 'type'] ? 'on' : ''}" data-act="lucky-hold" data-reel="${n}" ${m.landed ? '' : 'disabled'} title="Keep this ${label.toLowerCase()} for the next spin">${m.holds[n ? 'prio' : 'type'] ? 'Held' : 'Hold'}</button>` : '<span class="hold placeholder"></span>'}
    </div>`).join('');
  const led = !p ? 'Nothing to pick: your queue and the sprint\'s unassigned work are both empty. Enjoy the quiet.'
    : m.landed ? `${m.mood === 'bug' ? 'Bug alert · ' : ''}${p.key} · ${p.title}${p.due_date ? ` · due ${fmtDate(p.due_date)}` : ''}` : 'Good luck…';
  const banner = mood
    ? `<div class="payout ${m.mood}">${mascot(52, mood.face)}<div class="payout-text"><b>${mood.title}</b><span>${m.mood === 'bug' ? BUG_LINE[luckyMood({ ...p, issue_type: 'TASK' })] ?? mood.line : mood.line}</span></div>${mascot(52, mood.face)}</div>`
    : `<div class="payout waiting"><div class="payout-text"><b>${p ? '· · ·' : 'Out of tickets'}</b></div></div>`;
  return `<div class="scrim" style="z-index:40" data-act="close-modal"></div>
  ${mood && m.mood !== 'bug' ? `<div class="rays ${m.mood}" aria-hidden="true"></div>` : ''}
  <div class="modal lucky casino ${m.landed ? `landed ${m.mood}` : p ? 'spinning' : ''} ${m.fresh ? 'fresh' : ''}" role="dialog" aria-label="Lucky dip">
    <div class="marquee" aria-hidden="true"><i class="mq-t"></i><i class="mq-r"></i><i class="mq-b"></i><i class="mq-l"></i></div>
    <header class="sign">
      <span class="sign-side">${m.source === 'grabs' ? 'Up for grabs' : 'Your queue'}${m.spins ? ` · spin ${String(m.spins).padStart(2, '0')}` : ''}</span>
      <div class="sign-board">${lamps}<h2 class="sign-title"><span>Lucky</span><span>Dip</span></h2>${lamps}</div>
      <span class="sign-side right"><button class="icon-btn" data-act="lucky-sound" title="Sound is ${S.sound ? 'on' : 'off'}">${ic(S.sound ? 'sound' : 'mute', 'currentColor', 16)}</button><button class="icon-btn" data-act="close-modal" title="Close (Esc)">${ic('close', 'currentColor', 16)}</button></span>
    </header>
    <div class="cabinet">
      <div class="reels">${reels}<div class="payline" aria-hidden="true"></div></div>
      <button class="lever" data-act="lucky-spin" title="Pull to spin again (Space)" ${p && !m.landed ? 'disabled' : ''} ${p ? '' : 'hidden'}><span class="housing"></span><span class="arm"><span class="rod"></span><span class="knob"></span></span></button>
    </div>
    <div class="led ${m.landed && led.length > 46 ? 'scroll' : ''}" aria-live="polite"><span>${esc(led)}</span></div>
    <div class="meters">${meter('Credits', String(m.queue.length).padStart(2, '0'), 'Tickets in the pot')}${meter('Odds', m.landed ? `${m.odds}%` : '--', "This pick's chance, from priority and due date")}${meter('Bet', m.landed ? fmtDuration(p.estimate_minutes) || '??' : '--', "This pick's estimate")}${meter('Win', m.landed ? String(m.won).padStart(4, '0') : '----', 'Points for taking it on: priority, times three if overdue, two if due soon', 'win')}</div>
    ${banner}
    <div class="actions">${p
      ? `<span class="muted small grow">${m.landed ? 'Space pulls the lever again' : 'Spinning…'}</span>
        <button class="btn" data-act="lucky-spin" ${m.landed ? '' : 'disabled'}>${ic('refresh')}Spin again</button>
        <button class="btn" data-act="lucky-open" ${m.landed ? '' : 'disabled'}>Open</button>
        <button class="btn primary" data-act="lucky-start" ${m.landed ? '' : 'disabled'}>${ic('branch')}Start it</button>`
      : '<span class="grow"></span><button class="btn" data-act="close-modal">Close</button>'}</div>
  </div>`;
}

// From the sky: casino chips for a win, sad little bugs for a bug.
function rain(n, what) {
  const fx = $('#fx');
  if (!fx || !n) return;
  const el = document.createElement('div');
  el.className = `fx ${what}`;
  el.innerHTML = Array.from({ length: n }, (_, k) => `<i style="--x:${(k * 37) % 100}vw;--d:${((k * 13) % 24) * 0.09}s;--r:${(k * 47) % 360}deg;--s:${0.8 + ((k * 7) % 5) * 0.15}">${what === 'bugs' ? icon('t_bug', { size: 22 }) : ''}</i>`).join('');
  fx.append(el);
  setTimeout(() => el.remove(), 5200);
}

// Wind down: log what's left, note where you stopped, pick tomorrow's first ticket.
async function openShutdown() {
  if (!S.today || S.view !== 'today') await fetchToday();
  S.modal = { kind: 'shutdown', saved: false };
  renderOverlay();
}
function shutdownModal() {
  const m = S.modal, t = S.today;
  if (m.saved) return `<div class="scrim" style="z-index:40" data-act="close-modal"></div><div class="modal shutdown done">${mascot(110, 'wave')}<h2>See you tomorrow</h2>
    <p class="muted">${FUN.tomorrow?.key ? `First up: ${esc(FUN.tomorrow.key)}. ` : ''}Close the laptop, drink some water.</p>
    <div class="actions"><button class="btn primary" data-act="close-modal">Bye</button></div></div>`;
  const mine = t?.mine ?? S.issues;
  const queue = [...mine.filter((i) => statusOf(i)?.category === 'IN_PROGRESS'), ...upNext(mine)].filter(inScope);
  const logged = Object.values(t?.found ?? {}).reduce((a, f) => a + f.loggedToday, 0);
  return `<div class="scrim" style="z-index:40" data-act="close-modal"></div>
  <div class="modal shutdown" role="dialog" aria-label="Wind down">
    <h2>${mascot(36, 'wave')}Wind down<span class="muted normal small">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span></h2>
    <div class="stats wide">${stat(t?.commits.length ?? 0, 'commits')}${stat(Object.keys(t?.found ?? {}).length, 'tickets touched')}${stat(fmtDuration(logged) || '0m', 'logged')}${stat(streak(FUN.events), 'day streak')}</div>
    ${t?.rows.length ? `<section class="panel"><h3>${ic('clock')}Log what's left</h3>${t.rows.map(logRow).join('')}<div class="panel-foot today-foot">${todayFoot()}</div></section>` : ''}
    ${S.timer ? `<div class="row timer-note">${ic('clock')}<span class="grow">The timer on <b>${esc(S.timer.key)}</b> is still running (${clock(S.timer.start)}).</span><button class="btn small" data-act="timer-stop">Stop and log it</button></div>` : ''}
    <div class="fields">
      <label>Tomorrow</label><select id="tomorrow-key">${options([['', 'Decide tomorrow'], ...queue.map((i) => [i.key, `${i.key} ${i.title}`])], FUN.tomorrow?.key ?? queue[0]?.key ?? '')}</select>
    </div>
    <textarea class="field-input" id="tomorrow-note" data-keep="tomorrow-note" rows="3" placeholder="Where you left off: the next step, a gotcha, what you were about to try…">${esc(FUN.tomorrow?.date === today() ? FUN.tomorrow.note ?? '' : '')}</textarea>
    <div class="actions"><span class="muted grow">Shows up first thing tomorrow on Today, and in your standup.</span>
      <button class="btn" data-act="close-modal">Not yet</button><button class="btn primary" data-act="shutdown-save">${ic('moon')}Wind down</button></div>
  </div>`;
}

// The week, wrapped: a card you can copy as text or save as an image.
async function openWrapped() {
  const mon = new Date();
  mon.setHours(0, 0, 0, 0);
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  S.modal = { kind: 'wrapped', loading: true };
  renderOverlay();
  const [commits] = await Promise.all([host('commits', mon.toISOString(), null).catch(() => []), loadFun()]);
  const stats = weekStats(FUN.events, commits);
  // The app's people report knows time logged outside Ajwain too; use it when it answers.
  // (Only workspace admins may read it. Ask once: after a refusal, the journal's numbers stand.)
  const rep = S.noReport ? null : await api(`/api/reports/people/?${new URLSearchParams([['workspace', S.workspace], ['from', mon.toLocaleDateString('en-CA')], ['to', today()], ['user', S.me.id]])}`).catch(() => ((S.noReport = true), null));
  const row = list(rep).find((r) => same(r.user?.id ?? r.user ?? r.id, S.me.id)) ?? (rep && !Array.isArray(rep) ? rep : null);
  const reported = row?.logged_minutes ?? row?.minutes ?? (row?.hours != null ? row.hours * 60 : null);
  if (reported != null && reported > stats.minutes) stats.minutes = Math.round(reported);
  const earned = badgeList().filter((b) => b.unlockedAt && b.unlockedAt >= stats.start);
  if (S.modal?.kind === 'wrapped') { S.modal = { kind: 'wrapped', stats, earned }; renderOverlay(); }
}
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function wrappedSvg({ stats: s, earned }) {
  const ink = '#E8E4DC', dim = '#8E8B85', bg = '#14181A', brand = '#F28C28', rule = '#2C3133';
  const max = Math.max(1, ...s.heat.flat());
  const cells = s.heat.map((row, d) => row.map((n, h) => `<rect x="${118 + h * 19}" y="${404 + d * 19}" width="16" height="16" fill="${n ? brand : rule}" opacity="${n ? 0.25 + 0.75 * (n / max) : 1}"/>`).join('')).join('');
  const big = [[s.commits, 'commits'], [s.tickets, 'tickets touched'], [s.prs, 'pull requests'], [s.finished, 'finished'], [fmtDuration(s.minutes) || '0m', 'logged'], [s.breaks, 'stretch breaks']];
  const week = new Date(s.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const t = (x, y, txt, size, fill = ink, weight = 400, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(txt)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="600" viewBox="0 0 640 600" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
    <rect width="640" height="600" fill="${bg}"/><rect width="640" height="6" fill="${brand}"/><rect x="0.5" y="0.5" width="639" height="599" fill="none" stroke="${rule}"/>
    ${t(32, 48, 'AJWAIN WRAPPED', 13, brand, 700, 'letter-spacing="2"')}${t(608, 48, `Week of ${week}`, 13, dim, 400, 'text-anchor="end"')}
    <g transform="translate(32 70)" color="${ink}"><svg width="88" height="88" viewBox="0 0 64 64" stroke-linecap="round" stroke-linejoin="round">${mascotHeadMarkup('party')}</svg></g>
    ${t(136, 110, s.title[0], 34, ink, 700)}${t(136, 140, s.title[1], 15, dim)}
    <line x1="32" y1="182" x2="608" y2="182" stroke="${rule}"/>
    ${big.map(([v, l], n) => { const x = 32 + (n % 3) * 192, y = 200 + Math.floor(n / 3) * 86; return `<rect x="${x}" y="${y}" width="184" height="76" fill="none" stroke="${rule}"/>${t(x + 14, y + 42, v, 30, ink, 700, 'font-family="ui-monospace, monospace"')}${t(x + 14, y + 64, l.toUpperCase(), 10, dim, 700, 'letter-spacing="1.2"')}`; }).join('')}
    ${t(32, 392, 'WHEN YOU COMMITTED', 10, dim, 700, 'letter-spacing="1.2"')}
    ${DAYS.map((d, n) => t(32, 417 + n * 19, d, 11, dim)).join('')}${cells}
    ${[0, 6, 12, 18].map((h) => t(118 + h * 19, 550, `${h}:00`, 10, dim)).join('')}
    ${t(32, 584, `🔥 ${s.streak}-day streak · longest focus ${fmtDuration(s.focus) || '—'}${earned.length ? ` · ${earned.length} badge${earned.length === 1 ? '' : 's'} earned` : ''}`, 13, ink)}
  </svg>`;
}
const mascotHeadMarkup = (mood) => mascot(64, mood).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
function wrappedModal() {
  const m = S.modal;
  return `<div class="scrim" style="z-index:40" data-act="close-modal"></div>
  <div class="modal wrapped" role="dialog" aria-label="Your week, wrapped">
    ${m.loading ? `<div class="skeleton" style="height:420px"></div>` : `<div class="wrapped-card">${wrappedSvg(m)}</div>
    ${m.earned.length ? `<div class="row wrap-badges">${m.earned.map((b) => `<span class="tag" style="--c:var(--brand)">${icon(b.icon, { size: 12 })}${esc(b.name)}</span>`).join('')}</div>` : ''}`}
    <div class="actions"><span class="muted grow small">From Ajwain's journal, your commits and the app's time report.</span>
      <button class="btn" data-act="close-modal">Close</button>
      <button class="btn" data-act="wrapped-copy" ${m.loading ? 'disabled' : ''}>${ic('copy')}Copy as text</button>
      <button class="btn primary" data-act="wrapped-save" ${m.loading ? 'disabled' : ''}>${ic('download')}Save image</button></div>
  </div>`;
}
function wrappedText({ stats: s, earned }) {
  return [`*Ajwain Wrapped · week of ${new Date(s.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}*`, `🏆 ${s.title[0]}: ${s.title[1]}`,
    `• ${s.commits} commits on ${s.tickets} tickets`, `• ${s.prs} pull requests, ${s.finished} finished${s.bugs ? ` (${s.bugs} bugs)` : ''}`,
    `• ${fmtDuration(s.minutes) || '0m'} logged · ${s.breaks} stretch breaks`, `• 🔥 ${s.streak}-day streak · longest focus ${fmtDuration(s.focus) || '—'}`,
    earned.length ? `• Badges: ${earned.map((b) => b.name).join(', ')}` : null].filter(Boolean).join('\n');
}
async function saveWrapped() {
  const svg = wrappedSvg(S.modal);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; });
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 1200;
  c.getContext('2d').drawImage(img, 0, 0, 1280, 1200);
  await host('saveImage', c.toDataURL('image/png'), `ajwain-wrapped-${today()}.png`);
}

// ---------- command palette (Ctrl/⌘+K): jump to any ticket, view or project, or run any command ----------
const KEY_RE = /^([a-z][a-z0-9]*)-(\d+)$/i;
function ticketPool() {
  const seenKeys = new Set();
  return [S.drawer?.issue, ...S.issues, ...(S.today?.mine ?? []), ...S.recent, ...(S.palette?.remote ?? [])]
    .filter((i) => i?.key && !seenKeys.has(i.key) && seenKeys.add(i.key));
}
function commands() {
  return [
    ...VIEWS.map(([v, label, iconName], n) => ({ icon: iconName, label: `Go to ${label}`, hint: String(n + 1), run: () => actions.view({ dataset: { view: v } }) })),
    { icon: 'plus', label: 'New issue', hint: 'C', run: () => openCreate() },
    { icon: 'dice', label: 'Lucky dip: let the machine pick your next ticket', run: () => spinLucky() },
    { icon: 'comment', label: 'Write my standup', run: () => openStandup() },
    { icon: 'moon', label: 'Wind down for the day', run: () => openShutdown() },
    { icon: 'trophy', label: 'My week, wrapped', run: () => openWrapped() },
    { icon: 'eye', label: 'Start a 25-minute focus session', run: () => host('focus') },
    { icon: 'stretch', label: 'Take a stretch break', run: () => host('takeBreak', 'stretch') },
    ...(S.timer ? [{ icon: 'stop', label: `Stop the timer on ${S.timer.key} and log it`, run: () => actions['timer-stop']() }] : []),
    ...LANES.map(([f, l]) => ({ icon: 'lanes', label: f ? `Board swimlanes by ${l.toLowerCase()}` : 'Board without swimlanes', run: () => { S.lanes = f || null; persist(); if (S.view !== 'board') actions.view({ dataset: { view: 'board' } }); else render(); } })),
    ...S.projects.map((p) => ({ icon: 'board', label: `Switch to ${p.key} · ${p.name}`, run: () => chooseProject(p.id) })),
    { icon: 'board', label: 'Show all projects', run: () => chooseProject('') },
    { icon: 'history', label: 'Mark all changes as seen', run: () => actions['mark-seen']() },
    ...MINE_TABS.map(([k, l]) => ({ icon: 'user', label: `My work: ${l.toLowerCase()}`, run: () => { S.mineTab = k; S.attn = null; persist(); actions.view({ dataset: { view: 'mine' } }); } })),
    ...SORTS.filter(([v]) => v).map(([v, l]) => ({ icon: 'sort', label: `Sort by ${l.toLowerCase()}`, run: () => { const [k, d] = v.split(':'); S.sort = { key: k, dir: +d }; persist(); renderView(); renderFilters(); } })),
    { icon: 'bell', label: 'Add a reminder', run: () => host('addReminder') },
    { icon: 'refresh', label: 'Refresh', run: () => actions.refresh() },
    { icon: 'keyboard', label: 'Keyboard shortcuts', hint: '?', run: () => { S.modal = { kind: 'keys' }; renderOverlay(); } },
  ];
}
function paletteItems(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (text) => {
    const t = text.toLowerCase();
    if (!words.every((w) => t.includes(w))) return -1;
    return words.length ? (t.startsWith(words[0]) ? 3 : 0) + 1 / (1 + t.indexOf(words[0])) : 0;
  };
  const key = q.trim().match(KEY_RE) ? q.trim().toUpperCase() : /^\d+$/.test(q.trim()) && S.project ? `${S.project.key}-${q.trim()}` : null;
  const tickets = ticketPool().map((i) => ({ ticket: i, label: `${i.key} ${i.title}`, run: () => openIssue(i.key), alt: () => host('startWork', i).then(() => load()) }));
  const scored = [...tickets, ...commands()].map((x) => [x, score(x.label) + (x.ticket && /\d/.test(q) ? 1 : 0)]).filter(([, n]) => n >= 0);
  if (!words.length) return [...commands().slice(0, 9), ...tickets.filter((t) => S.recent.some((r) => r.key === t.ticket.key)).slice(0, 8)];
  const out = scored.sort((a, b) => b[1] - a[1]).map(([x]) => x).slice(0, 40);
  if (key && !out.some((x) => x.ticket?.key === key)) out.unshift({ icon: 'external', label: `Open ${key}`, run: () => openIssue(key) });
  return out;
}
function openPalette() {
  S.palette = { q: '', sel: 0, remote: [] };
  $('#palette').innerHTML = `<div class="pal-scrim" data-act="palette-close"></div><div class="palette" role="dialog" aria-label="Command palette">
    <label class="pal-input">${ic('command')}<input id="pal-q" placeholder="Jump to a ticket, view or project, or run a command…" autocomplete="off" spellcheck="false"><span class="kbd">Esc</span></label>
    <div class="pal-list" id="pal-list" role="listbox"></div>
    <div class="pal-foot"><span><span class="kbd">↑</span><span class="kbd">↓</span> choose</span><span><span class="kbd">Enter</span> open or run</span><span><span class="kbd">Shift Enter</span> start work on a ticket</span><span class="grow"></span><span class="muted">${MOD}K anywhere</span></div></div>`;
  renderPalList();
  $('#pal-q').focus();
}
const closePalette = () => { S.palette = null; $('#palette').innerHTML = ''; };
function renderPalList() {
  const p = S.palette, el = $('#pal-list');
  if (!p || !el) return;
  p.items = paletteItems(p.q);
  p.sel = Math.max(0, Math.min(p.sel, p.items.length - 1));
  let lastKind = null;
  el.innerHTML = p.items.map((x, n) => {
    const kind = x.ticket ? 'Tickets' : 'Commands', head = kind !== lastKind ? `<div class="pal-sec">${kind}</div>` : '';
    lastKind = kind;
    const i = x.ticket;
    return `${head}<div class="pal-row ${n === p.sel ? 'on' : ''}" data-act="palette-pick" data-n="${n}" role="option" aria-selected="${n === p.sel}">${i
      ? `${typeIcon(i.issue_type)}<span class="key">${esc(i.key)}</span><span class="grow pal-label">${esc(i.title)}</span>${i.status != null && statusOf(i) ? `<span class="pal-status" style="--sc:${statusColor(statusOf(i))}">${esc(statusOf(i).name)}</span>` : ''}`
      : `${ic(x.icon)}<span class="grow pal-label">${esc(x.label)}</span>${x.hint ? `<span class="kbd">${esc(x.hint)}</span>` : ''}`}</div>`;
  }).join('') || `<div class="pal-empty">Nothing matches "${esc(p.q)}"</div>`;
  el.querySelector('.pal-row.on')?.scrollIntoView({ block: 'nearest' });
}
let palTimer;
function palSearch() {
  clearTimeout(palTimer);
  const q = S.palette?.q.trim() ?? '';
  if (q.length < 3 || !S.project || KEY_RE.test(q)) return;
  palTimer = setTimeout(async () => {
    const xs = list(await api(`/api/issues/similar/?${new URLSearchParams({ project: S.project.id, q })}`).catch(() => []));
    if (S.palette?.q.trim() !== q) return;
    S.palette.remote = xs.map((x) => ({ key: x.key, title: x.title, issue_type: x.issue_type }));
    renderPalList();
  }, 250);
}
function pickPalette(n, alt) {
  const x = S.palette?.items[n];
  if (!x) return;
  closePalette();
  run(alt && x.alt ? x.alt() : x.run());
}
document.addEventListener('input', (e) => {
  if (e.target.id !== 'pal-q' || !S.palette) return;
  S.palette.q = e.target.value;
  S.palette.sel = 0;
  renderPalList();
  palSearch();
});

const KEYS = [
  [`${MOD}K`, 'Command palette: jump to any ticket, view or project, run any command'], ['1 – 5', 'Today, Board, List, Sprints, My work'],
  ['C', 'New issue'], ['/', 'Filter the view by key or title'], ['← ↑ → ↓', 'Move between cards on the board'],
  ['Shift ← →', 'Move the focused card to the previous or next status'], ['Enter', 'Open the focused card'],
  ['Space', 'Pull the lever again in Lucky dip'], [`${MOD}Enter`, 'Create, comment, save the description'], ['Esc', 'Close whatever is open'], ['?', 'This list'],
];
const keysModal = () => `<div class="scrim" style="z-index:40" data-act="close-modal"></div>
  <div class="modal keys" role="dialog" aria-label="Keyboard shortcuts"><h2>${ic('keyboard')}Keyboard shortcuts</h2>
    <div class="keys-grid">${KEYS.map(([k, d]) => `<span class="kbd big">${esc(k)}</span><span>${esc(d)}</span>`).join('')}</div>
    <div class="actions"><button class="btn" data-act="close-modal">Close</button></div></div>`;

// Arrow keys walk the board; Shift+←/→ moves the focused card to the neighbouring status.
const focusCard = (key) => document.querySelector(`.card[data-key="${CSS.escape(key)}"]`)?.focus();
function walkBoard(card, key, shift) {
  const cell = card.closest('[data-drop]'), cards = [...cell.querySelectorAll('.card')], n = cards.indexOf(card);
  if (key === 'ArrowUp' || key === 'ArrowDown') return cards[n + (key === 'ArrowUp' ? -1 : 1)]?.focus();
  const next = key === 'ArrowRight' ? cell.nextElementSibling : cell.previousElementSibling;
  if (!next?.matches('[data-drop]')) return;
  if (!shift) return (next.querySelectorAll('.card')[Math.min(n, next.querySelectorAll('.card').length - 1)] ?? next.querySelector('.card'))?.focus();
  const i = S.issues.find((x) => same(x.id, card.dataset.id));
  if (!i) return;
  const k = i.key;
  run(patch(i, { status: coerce('status', i, next.dataset.value) }).then(() => focusCard(k)));
  focusCard(k);
}

// ---------- events ----------
const closeMenu = () => { S.menu = null; renderFilters(); if (S.drawer) renderOverlay(); };
async function saveDesc() {
  const i = S.drawer.issue, value = $('#desc').value;
  S.drawer.editDesc = false;
  $('#desc').dataset.keep = '';
  await patch(i, { description: value });
}

const actions = {
  view: (el) => { S.view = el.dataset.view; persist(); load(); },
  refresh: () => { S.statuses = {}; S.sprints = {}; return S.me ? setProject(S.project?.id) : start(); },
  signin: () => host('signIn'),
  new: (el) => openCreate({
    ...(el.dataset.status !== undefined && { status: coerce('status', { project: S.project?.id }, el.dataset.status) }),
    ...(el.dataset.sprint !== undefined && { sprint: coerce('sprint', { project: S.project?.id }, el.dataset.sprint) }),
  }),
  open: (el) => openIssue(el.dataset.key),
  close: () => { S.drawer = null; S.menu = null; renderOverlay(); },
  'close-modal': () => { S.modal = null; renderOverlay(); },
  palette: () => openPalette(),
  'palette-close': () => closePalette(),
  'palette-pick': (el, e) => pickPalette(+el.dataset.n, e.shiftKey),
  'mark-seen': (el, e) => {
    e?.preventDefault();
    if (S.project && S.snaps[S.project.id]) S.baseline[S.project.id] = JSON.parse(JSON.stringify(S.snaps[S.project.id]));
    S.changes = new Map();
    renderView();
  },
  quick: (el) => { S.quick = el.dataset.status; renderView(); $('form[data-form=quick] input')?.focus(); },
  // Attendance: a punch only ever comes from a person clicking the Workday box's button.
  'att-punch': async (el) => { el.disabled = true; S.att = await host('punchByHand', el.dataset.dir); renderView(); },
  'att-connect': () => host('connectZoho'),
  'card-timer': async (el) => { S.timer = await host('timerToggle', findIssue(el.closest('.card').dataset.id)); renderNow(); renderView(); },
  'card-start': async (el) => { await host('startWork', findIssue(el.closest('.card').dataset.id)); load(); },
  'lane-toggle': (el) => { const k = el.dataset.lane; S.collapsed.has(k) ? S.collapsed.delete(k) : S.collapsed.add(k); renderView(); },
  menu: (el) => { S.menu = S.menu === el.dataset.key ? null : el.dataset.key; renderFilters(); if (S.drawer) renderOverlay(); },
  clear: () => { S.filters = { ...emptyFilters(), sprint: [] }; persist(); load(); },
  sort: (el) => {
    const k = el.dataset.key, first = FIRST_DIR[k] ?? 1;
    S.sort = { key: k, dir: S.sort?.key === k ? -S.sort.dir : first }; // a header flips; Sort › Default order clears
    persist();
    renderView();
    renderFilters();
  },
  'cell-edit': (el) => editCell(el),
  'show-all': (el) => { S.showAll.add(el.dataset.key); renderView(); },
  'columns-reset': () => { S.columns = [...DEFAULT_COLUMNS]; persist(); renderView(); renderFilters(); },
  'mine-tab': (el) => {
    S.mineTab = el.dataset.tab;
    S.attn = null;
    persist();
    if (!S.my) return load();
    S.issues = S.my[S.mineTab];
    renderFilters();
    renderView();
  },
  attn: (el) => { S.attn = S.attn === el.dataset.k ? null : el.dataset.k; renderView(); },
  start: async () => { await host('startWork', S.drawer.issue); await openIssue(S.drawer.key); load(); },
  claude: async () => { await host('implementWithClaude', S.drawer.issue); await openIssue(S.drawer.key); load(); },
  timer: async () => { S.timer = await host('timerToggle', S.drawer.issue); renderNow(); renderOverlay(); },
  pr: async () => { await host('openPR', S.drawer.issue); await openIssue(S.drawer.key); load(); },
  finish: async () => { await host('finish', S.drawer.issue); await openIssue(S.drawer.key); load(); },
  standup: () => openStandup(),
  // writing help
  'toggle-notes': () => { S.modal.notesOpen = !S.modal.notesOpen; renderOverlay(); $('#notes')?.focus(); },
  'draft-notes': draftNotes,
  'insert-template': () => {
    const f = $('form[data-form=create]'), tpl = TEMPLATES[f.issue_type.value] ?? TEMPLATES.TASK;
    f.description.value = f.description.value.trim() ? `${f.description.value.trimEnd()}\n\n${tpl}` : tpl;
    f.description.focus();
    refreshHealth();
  },
  untag: (el) => { S.modal.tags = S.modal.tags.filter((t) => !same(t, el.dataset.id)); renderOverlay(); },
  'health-template': async () => {
    // Append the template's sections whose headings aren't in the description yet; nothing written is touched.
    const i = S.drawer.issue, desc = i.description ?? '';
    const parts = (TEMPLATES[i.issue_type] ?? TEMPLATES.TASK).split(/\n(?=## )/)
      .filter((part) => !new RegExp(`^##\\s*${part.match(/^## (.*)/)[1]}`, 'im').test(desc));
    if (!parts.length) return toast('Nothing to add: the sections are already there.');
    await patch(i, { description: `${desc.trimEnd()}\n\n${parts.join('\n').trim()}`.trimStart() });
    S.drawer.editDesc = true;
    renderOverlay();
    $('#desc')?.focus();
  },
  summarize: (el) => summarize(!!el.dataset.fresh),
  improve: improve,
  'improve-discard': () => { S.drawer.improve = null; renderOverlay(); },
  'improve-accept': async () => {
    const im = S.drawer.improve;
    S.drawer.improve = null;
    await patch(S.drawer.issue, { title: im.title, description: im.description });
    toast('Description updated');
  },
  // attachments
  'attach-pick': async () => {
    const key = S.drawer.key;
    S.drawer.uploading = true;
    renderOverlay();
    try { await host('pickAndAttach', { id: S.drawer.issue.id, key }); } finally { if (S.drawer?.key === key) { S.drawer.uploading = false; await openIssue(key); } }
  },
  'att-open': (el) => openAttachment(el.dataset.id, el.dataset.name),
  'att-download': async (el) => host('openExternal', await attachmentSrc(el.dataset.id, true)),
  'att-delete': async (el) => {
    const d = S.drawer;
    if (d.confirmDelete !== el.dataset.id) { d.confirmDelete = el.dataset.id; return renderOverlay(); }
    d.confirmDelete = null;
    await api(`/api/attachments/${el.dataset.id}/`, { method: 'DELETE' });
    toast('Attachment deleted');
    await openIssue(d.key);
  },
  lightbox: (el) => el.src && showLightbox({ url: el.src, kind: 'image', name: el.alt || 'image' }),
  'lightbox-close': (el, e) => { if (!e.target.closest('img,video')) $('#lightbox').innerHTML = ''; },
  unpend: (el) => { S.modal.files.splice(+el.dataset.n, 1); $('#new-files').innerHTML = pendingFiles(); },
  // fun
  lucky: () => spinLucky(),
  'lucky-spin': () => S.modal?.landed && spinLucky(true),
  'lucky-hold': (el) => {
    const m = S.modal, k = el.dataset.reel === '0' ? 'type' : 'prio';
    m.holds = { ...m.holds, [k]: m.holds[k] ? null : k === 'type' ? m.pick.issue_type : m.pick.priority };
    sfx('hold');
    renderOverlay();
  },
  'lucky-sound': () => { S.sound = !S.sound; persist(); renderOverlay(); sfx('on'); },
  'lucky-open': () => { const key = S.modal.pick.key; S.modal = null; openIssue(key); },
  'lucky-start': async () => {
    const i = S.modal.pick;
    S.modal = null;
    renderOverlay();
    host('record', { type: 'lucky', key: i.key });
    await host('startWork', i);
    load();
  },
  focus: () => host('focus'),
  'take-break': () => host('takeBreak', 'stretch'),
  shutdown: () => openShutdown(),
  'shutdown-save': async () => {
    const key = $('#tomorrow-key')?.value || null, note = $('#tomorrow-note')?.value.trim() || '';
    await host('setTomorrow', key || note ? { key, note } : null);
    FUN.tomorrow = key || note ? { key, note, date: today() } : null;
    S.modal.saved = true;
    renderOverlay();
  },
  'timer-stop': async () => { S.timer = await host('timerToggle', { key: S.timer.key, id: S.timer.id, title: S.timer.title }); renderNow(); renderOverlay(); },
  'clear-first': async () => { await host('setTomorrow', null); FUN.tomorrow = null; renderView(); },
  wrapped: () => openWrapped(),
  'wrapped-copy': async () => { await host('copy', wrappedText(S.modal)); toast('Copied. Paste it in your team channel.'); },
  'wrapped-save': () => saveWrapped(),
  'copy-standup': async () => { await host('copy', $('#standup').value); host('record', { type: 'standup' }); toast('Standup copied. Paste it in your team channel.'); },
  'standup-source': async (el) => {
    const m = S.modal;
    if (el.dataset.src === 'commits') return (m.source = 'commits', m.text = m.local, $('#standup').dataset.keep = '', renderOverlay());
    m.aiLoading = true;
    renderOverlay();
    try {
      const r = await host('req', `/api/activity/users/${S.me.id}/standup/?${new URLSearchParams({ workspace: S.workspace, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })}`, null);
      if (S.modal === m) Object.assign(m, { source: 'ai', text: r?.text ?? m.text });
    } finally {
      m.aiLoading = false;
      if (S.modal === m) { const ta = $('#standup'); if (ta) ta.dataset.keep = ''; renderOverlay(); }
    }
  },
  'copy-branch': () => host('copyBranch', S.drawer.issue),
  doc: () => host('openDoc', S.drawer.key),
  web: (el) => host('openWeb', el.dataset.key),
  link: (el) => host('openExternal', el.dataset.href),
  'edit-desc': () => { S.drawer.editDesc = true; renderOverlay(); $('#desc')?.focus(); },
  'cancel-desc': () => { S.drawer.editDesc = false; $('#desc').dataset.keep = ''; renderOverlay(); },
  'save-desc': saveDesc,
  plan: async (el) => openPlan(S.drawer?.issue?.key === el.dataset.key ? S.drawer.issue : await fetchIssue(el.dataset.key)),
  'plan-add': () => { S.modal.rows.push(blankRow()); renderOverlay(); [...document.querySelectorAll('[data-plan=title]')].pop()?.focus(); },
  'plan-remove': (el) => { S.modal.rows.splice(+el.dataset.row, 1); renderOverlay(); },
  'plan-draft': draftPlan,
  'plan-create': createPlan,
  'today-log': logToday,
  'today-start': async (el) => { await host('startWork', S.issues.find((i) => i.key === el.dataset.key)); load(); },
  'today-link': async (el) => {
    const key = await host('linkBranch', el.dataset.branch, null);
    if (key) { toast(`Linked ${el.dataset.branch} to ${key}`); load(); }
  },
  'today-create': (el) => {
    const branch = el.dataset.branch, cs = S.today.untracked.filter((c) => (c.branch || '(no branch)') === branch);
    const clean = (t) => t.replace(/^\w+(\(.*?\))?!?:\s*/, '');
    const fromBranch = branch.replace(/^[\w.-]+\//, '').replace(/[-_]+/g, ' ');
    return openCreate({
      title: cs.length === 1 ? clean(cs[0].subject) : fromBranch[0]?.toUpperCase() + fromBranch.slice(1),
      description: `## What\n${cs.map((c) => `- ${clean(c.subject)}`).join('\n')}\n\n## Acceptance criteria\n- [ ] `,
      linkBranch: branch === '(no branch)' ? null : branch,
    });
  },
  'goto-project': (el) => chooseProject(S.projects.find((p) => same(p.id, el.dataset.id))?.id),
  reminders: () => host('configureReminders'),
  'add-reminder': () => host('addReminder'),
  'new-sub': () => openCreate({ issue_type: 'SUBTASK', parent: S.drawer.issue.id, project: S.drawer.issue.project }),
};

const forms = {
  async quick(form) {
    const input = form.querySelector('input'), title = input.value.trim();
    if (!title) return;
    const pid = S.project.id, ctx = { project: pid }, f = S.filters.sprint;
    const sprint = f.length !== 1 || f[0] === 'none' ? null : f[0] === 'active' ? activeSprint()?.id ?? null : coerce('sprint', ctx, f[0]);
    input.value = '';
    const issue = await api('/api/issues/', { method: 'POST', body: { project: pid, title, issue_type: 'TASK', priority: 'MEDIUM', status: coerce('status', ctx, form.dataset.status), assignee: S.me.id, sprint } });
    if (issue?.key) { showCreated(issue); toast(`Created ${issue.key}`, false, issue.key); }
    $('form[data-form=quick] input')?.focus();
    host('changed');
  },
  async ask(form) {
    const text = new FormData(form).get('q').trim();
    if (text.length < 3 || !S.project) return;
    const r = await api(`/api/projects/${S.project.id}/filter-from-text/`, { method: 'POST', body: { text } });
    const q = new URL(r.url, 'http://x').searchParams;
    const F = emptyFilters();
    F.sprint = [];
    for (const k of ['type', 'priority', 'assignee', 'reporter', 'tag', 'sprint']) F[k] = q.getAll(k).flatMap((v) => v.split(',')).filter(Boolean).map((v) => (same(v, S.me.id) ? 'me' : v));
    S.filters = F;
    const v = q.get('view');
    if (['board', 'list', 'sprints'].includes(v)) S.view = v;
    persist();
    form.querySelector('input').dataset.keep = '';
    toast(r.unmatched?.length ? `Filtered. Didn't understand: ${r.unmatched.join(', ')}` : 'Filtered');
    load();
  },
  async create(form, submitter) {
    const f = Object.fromEntries(new FormData(form));
    const pid = S.modal.pid, pre = S.modal.pre, ctx = { project: pid };
    const issue = await api('/api/issues/', {
      method: 'POST',
      body: {
        project: pid, title: f.title.trim(), description: f.description, issue_type: f.issue_type, priority: f.priority,
        status: coerce('status', ctx, f.status), assignee: coerce('assignee', ctx, f.assignee), sprint: coerce('sprint', ctx, f.sprint),
        ...(f.estimate.trim() && { estimate_minutes: parseDuration(f.estimate) }),
        ...(f.due_date && { due_date: f.due_date }),
        ...(f.parent && { parent: coerce('parent', ctx, f.parent) }),
        ...(S.modal.tags?.length && { tags: S.modal.tags }),
      },
    });
    // Screenshots pasted while writing upload now that the issue exists; their refs point at the real ids.
    const pending = (S.modal.files ?? []).filter((x) => f.description.includes(x.ref) || !x.inline);
    if (pending.length) {
      const up = await host('attachBytes', { id: issue.id, key: issue.key }, pending.map(({ name, type, data }) => ({ name, type, data })));
      let desc = f.description;
      pending.forEach((x, n) => { if (up[n]?.id) desc = desc.split(x.ref).join(`attachment:${up[n].id}`); });
      if (desc !== f.description) Object.assign(issue, await api(`/api/issues/${issue.id}/`, { method: 'PATCH', body: { description: desc } }));
    }
    form.querySelectorAll('[data-keep]').forEach((e) => (e.dataset.keep = ''));
    S.modal = null;
    renderOverlay();
    const shown = showCreated(issue);
    toast(shown ? `Created ${issue.key}` : `Created ${issue.key}. This view's filters don't show it`, false, issue.key);
    if (pre.linkBranch) await host('linkBranch', pre.linkBranch, issue.key);
    host('changed');
    load({ quiet: true });
    if (submitter?.value === 'plan') openPlan(await fetchIssue(issue.key));
  },
  async log(form) {
    const f = Object.fromEntries(new FormData(form)), i = S.drawer.issue;
    const minutes = parseDuration(f.d);
    const w = await api('/api/worklogs/', { method: 'POST', body: { issue: i.id, minutes, logged_on: f.on || today(), note: f.note.trim() } });
    for (const t of new Set([i, S.issues.find((x) => same(x.id, i.id))].filter(Boolean))) t.logged_minutes = (t.logged_minutes ?? 0) + minutes;
    S.drawer.worklogs = [...(S.drawer.worklogs ?? []), w];
    form.reset();
    form.querySelector('[name=on]').value = today();
    rerender();
    toast(`Logged ${fmtDuration(minutes)} on ${i.key}`);
    host('changed');
  },
  async comment(form) {
    const body = new FormData(form).get('body').trim();
    const c = await api('/api/comments/', { method: 'POST', body: { issue: S.drawer.issue.id, body } });
    S.drawer.comments = [...(S.drawer.comments ?? []), c ?? { author: S.me.id, body, created_at: new Date().toISOString() }];
    form.reset();
    renderOverlay();
  },
};

const run = (p) => Promise.resolve(p).catch((e) => { report('action', e); toast(e.message, true); });

document.addEventListener('click', (e) => {
  if (S.menu && !e.target.closest('.menu')) closeMenu();
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) run(actions[el.dataset.act](el, e));
});

document.addEventListener('change', (e) => {
  const el = e.target, kind = el.dataset.change;
  if (kind === 'project') run(chooseProject(el.value));
  if (kind === 'workspace') run(host('setScope', { workspace: S.workspaces.find((w) => same(w.id, el.value))?.id ?? el.value, project: '' }));
  if (kind === 'filter') {
    const k = el.dataset.key, v = el.value;
    S.filters[k] = el.checked ? [...S.filters[k], v] : S.filters[k].filter((x) => !same(x, v));
    persist();
    load();
  }
  if (kind === 'field') {
    const i = findIssue(el.dataset.id), f = el.dataset.field;
    try {
      const v = coerce(f, i, el.value);
      if (f === 'title' && !v.trim()) throw new Error('Title cannot be empty');
      if (!same(v, i[f])) run(patch(i, { [f]: v }));
    } catch (err) {
      toast(err.message, true);
      rerender();
    }
  }
  if (kind === 'add-tag' && el.value) {
    S.modal.tags = [...(S.modal.tags ?? []), S.tags.find((t) => same(t.id, el.value))?.id ?? el.value];
    renderOverlay();
  }
  if (kind === 'issue-tag') {
    const i = findIssue(el.dataset.id);
    const ids = el.checked ? [...(i.tags ?? []), S.tags.find((t) => same(t.id, el.value))?.id ?? el.value] : (i.tags ?? []).filter((t) => !same(t, el.value));
    run(patch(i, { tags: ids }));
  }
  if (kind === 'modal-project') run(openCreate({ ...S.modal.pre, project: S.projects.find((p) => same(p.id, el.value))?.id }));
  if (kind === 'lanes') { S.lanes = el.value || null; persist(); render(); }
  if (kind === 'sort') { const [k, d] = el.value.split(':'); S.sort = k ? { key: k, dir: +d } : null; persist(); renderView(); renderFilters(); }
  if (kind === 'column') { S.columns = Object.keys(COLUMNS).filter((k) => (k === el.value ? el.checked : S.columns.includes(k))); persist(); renderView(); renderFilters(); }
  if (kind === 'mine-group') { S.mineGroup = el.value; persist(); renderView(); }
});

// Typing in the breakdown or Today rows updates state without re-rendering (keeps focus and cursor).
document.addEventListener('input', (e) => {
  const el = e.target, val = el.type === 'checkbox' ? el.checked : el.value;
  if (el.closest?.('form[data-form=create]')) {
    if (el.dataset.health !== undefined) refreshHealth();
    if (el.dataset.similar !== undefined) checkSimilar();
  }
  if (S.modal?.kind === 'plan' && (el.dataset.plan || el.dataset.planField)) {
    if (el.dataset.plan) S.modal.rows[+el.dataset.row][el.dataset.plan] = val;
    else S.modal[el.dataset.planField] = val;
    if (el.dataset.plan === 'on') el.closest('.plan-row').classList.toggle('off', !val);
    if (el.dataset.planField !== 'guidance' && el.dataset.planField !== 'then') $('#plan-foot').innerHTML = planFoot();
  }
  if ((S.view === 'today' || S.modal?.kind === 'shutdown') && el.dataset.today && S.today) {
    S.today.rows[+el.dataset.row][el.dataset.today] = val;
    if (el.dataset.today === 'on') el.closest('.log-row').classList.toggle('off', !val);
    document.querySelectorAll('.today-foot').forEach((f) => (f.innerHTML = todayFoot()));
  }
});
// Pasting an image into a description or comment attaches it and inserts its markdown.
document.addEventListener('paste', (e) => {
  const ta = e.target.closest?.('textarea[data-paste]');
  const files = [...(e.clipboardData?.files ?? [])];
  if (!ta || !files.length) return;
  e.preventDefault();
  if (ta.dataset.paste === 'new') return run(addPending(files, ta));
  run(uploadToIssue(files).then((up) => up.forEach((a, n) => attachmentKind(a.name ?? files[n].name) === 'image' && insertAtCursor($(`textarea[data-keep="${ta.dataset.keep}"]`) ?? ta, `![${a.name}](attachment:${a.id})`))));
});
document.addEventListener('toggle', (e) => {
  if (S.modal?.kind === 'plan' && e.target.matches?.('details[data-row]')) S.modal.rows[+e.target.dataset.row].open = e.target.open;
  if (e.target.matches?.('details.since')) S.sinceOpen = e.target.open;
}, true);

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target, btn = form.querySelector('button:not([type=button])');
  if (btn) btn.disabled = true;
  try {
    await forms[form.dataset.form](form, e.submitter);
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  // Ctrl/⌘+K is ours: stopPropagation keeps VS Code from also starting a Ctrl+K chord.
  if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    return S.palette ? closePalette() : openPalette();
  }
  if (S.palette) {
    const p = S.palette;
    if (e.key === 'Escape') { e.preventDefault(); return closePalette(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); p.sel = (p.sel + (e.key === 'ArrowDown' ? 1 : -1) + p.items.length) % Math.max(1, p.items.length); return renderPalList(); }
    if (e.key === 'Enter') { e.preventDefault(); return pickPalette(p.sel, e.shiftKey); }
    return;
  }
  if (e.key === 'Escape' && S.quick != null) { S.quick = null; return renderView(); }
  if (e.key === 'Escape') {
    if ($('#lightbox')?.innerHTML) return void ($('#lightbox').innerHTML = '');
    if (S.menu) closeMenu();
    else if (S.modal) actions['close-modal']();
    else if (S.drawer?.editDesc) actions['cancel-desc']();
    else if (S.drawer) actions.close();
    else if (typing) e.target.blur();
    return;
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.target.id === 'desc') return run(saveDesc());
    return e.target.closest('form')?.requestSubmit();
  }
  if (e.key === 'Enter' && e.target.classList.contains('title-input')) return e.target.blur();
  if (typing) return;
  if (e.key === 'Enter' && e.target.classList.contains('card')) openIssue(e.target.dataset.key);
  if (e.key.startsWith('Arrow') && e.target.classList.contains('card') && !S.modal) { e.preventDefault(); return walkBoard(e.target, e.key, e.shiftKey); }
  if (e.key === ' ' && S.modal?.kind === 'lucky') { e.preventDefault(); return actions['lucky-spin'](); }
  if (e.key === '?' && !S.modal) { S.modal = { kind: 'keys' }; return renderOverlay(); }
  if (/^[1-5]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !S.modal && !S.drawer) return actions.view({ dataset: { view: VIEWS[+e.key - 1][0] } });
  if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !S.modal) { e.preventDefault(); run(openCreate()); }
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
});

// Drag cards between status columns, or table rows between sprints.
document.addEventListener('dragstart', (e) => {
  const el = e.target.closest?.('[draggable][data-id]');
  if (!el) return;
  e.dataTransfer.setData('text/plain', el.dataset.id);
  e.dataTransfer.effectAllowed = 'move';
  el.classList.add('dragging');
});
document.addEventListener('dragend', (e) => e.target.classList?.remove('dragging'));
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
document.addEventListener('dragover', (e) => {
  if (hasFiles(e)) {
    const zone = e.target.closest?.('[data-dropzone]');
    if (zone) { e.preventDefault(); zone.classList.add('file-over'); }
    return;
  }
  const z = e.target.closest?.('[data-drop]');
  if (!z) return;
  e.preventDefault();
  document.querySelectorAll('.drop').forEach((d) => d !== z && d.classList.remove('drop'));
  z.classList.add('drop');
});
document.addEventListener('dragleave', (e) => {
  const fz = e.target.closest?.('[data-dropzone]');
  if (fz && !fz.contains(e.relatedTarget)) fz.classList.remove('file-over');
  const z = e.target.closest?.('[data-drop]');
  if (z && !z.contains(e.relatedTarget)) z.classList.remove('drop');
});
document.addEventListener('drop', (e) => {
  if (hasFiles(e)) {
    const zone = e.target.closest?.('[data-dropzone]');
    document.querySelectorAll('.file-over').forEach((x) => x.classList.remove('file-over'));
    if (!zone) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (zone.dataset.dropzone === 'new') return run(addPending(files, e.target.closest('textarea[data-paste]')));
    return run(uploadToIssue(files));
  }
  const z = e.target.closest?.('[data-drop]');
  if (!z) return;
  e.preventDefault();
  z.classList.remove('drop');
  const i = S.issues.find((x) => same(x.id, e.dataTransfer.getData('text/plain')));
  if (!i) return;
  const field = z.dataset.drop, lane = z.dataset.lane, changes = {};
  if (!same(i[field], z.dataset.value)) changes[field] = coerce(field, i, z.dataset.value);
  // A swimlane cell also sets the lane's field: another person's lane reassigns, another priority's lane reprioritizes.
  if (lane && !same(i[lane] ?? '', z.dataset.laneValue)) changes[lane] = ['assignee', 'parent'].includes(lane) ? coerce(lane, i, z.dataset.laneValue) : z.dataset.laneValue || null;
  if (Object.keys(changes).length) run(patch(i, changes));
});

let ready; // the current init(), so actions taken while it runs can wait for it
const start = () => (ready = init());
start();
