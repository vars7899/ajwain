// Ajwain API client, shared by the VS Code extension (extension.js) and the ajwain CLI (cli.mjs). No deps.
// No server address is built in: the extension passes its ajwain.apiUrl setting, the CLI the address saved by
// `ajwain login --server` (or AJWAIN_API).
export const MAX_ATTACHMENT = 20 * 1024 * 1024; // the app's limit
const trimUrl = (u) => String(u ?? '').trim().replace(/\/+$/, '');
// The web app's address guessed from the API's: api.example.com → app.example.com, pm-api.example.com → pm-app.example.com.
// Empty when the API's host has no "api" in it (set ajwain.appUrl or AJWAIN_APP then).
export function appFromApi(api) {
  try {
    const u = new URL(api), host = u.hostname.replace(/(^|[.-])api(?=[.-])/, '$1app');
    return host === u.hostname ? '' : `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
  } catch { return ''; }
}
// Where tickets open in the browser. Set once by the extension or the CLI; empty means no web links.
let APP = '';
export const setApp = (url) => { APP = trimUrl(url); };
export const TYPES = ['EPIC', 'STORY', 'TASK', 'BUG', 'SUBTASK'];
export const PRIORITIES = ['HIGHEST', 'HIGH', 'MEDIUM', 'LOW', 'LOWEST'];

const list = (d) => (Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : []);

// Every page of a paged list. get(page) fetches one page. The first page says how many there are, then the rest
// are fetched a few at a time instead of one after another: a project with 2,000 tickets is 8 pages, and in a
// row those took 4 seconds. Without a count it follows `next`. Rows are de-duplicated by id, in case the list
// shifted while it was being read.
export const PAGE_SIZE = 250;
export async function allPages(get, parallel = 4) {
  const first = await get(1);
  const rows = [...list(first)];
  if (first?.next) {
    const n = first.count ? Math.ceil(first.count / PAGE_SIZE) : 0;
    if (!n) for (let p = 2, d = first; d?.next; p++) rows.push(...list((d = await get(p))));
    for (let p = 2; p <= n; p += parallel) {
      const batch = await Promise.all(Array.from({ length: Math.min(parallel, n - p + 1) }, (_, k) => get(p + k)));
      for (const d of batch) rows.push(...list(d));
    }
  }
  const ids = new Set();
  return rows.filter((r) => r?.id == null || (!ids.has(String(r.id)) && ids.add(String(r.id))));
}
const pageOf = (q, page) => { const p = new URLSearchParams(q); p.set('page_size', String(PAGE_SIZE)); p.set('page', String(page)); return p; };
// The issues matching a query (URLSearchParams or a plain object), every page. req(path) makes one request.
export const issuesWhere = (req, q) => allPages((page) => req(`/api/issues/?${pageOf(q, page)}`));
const idOf = (v) => (v && typeof v === 'object' ? v.id : v);
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

// "1h30m" | "90m" | "90" | "1.5h" | "1d 2h" -> minutes (1d = 8h)
export function parseDuration(s) {
  const t = String(s ?? '').trim().toLowerCase();
  const m = t.match(/^(?:(\d+(?:\.\d+)?)d)?\s*(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+)m?)?$/);
  if (!t || !m) throw new Error(`Bad duration "${s}" (try 2h, 1h30m, 45m, 1d)`);
  return Math.round((+m[1] || 0) * 480 + (+m[2] || 0) * 60 + (+m[3] || 0));
}

export const fmtDuration = (min) =>
  !min ? '' : [Math.floor(min / 60) && `${Math.floor(min / 60)}h`, min % 60 && `${min % 60}m`].filter(Boolean).join(' ');

export const issueUrl = (key) => (APP ? `${APP}/issues/${key}` : '');

// First ticket key ("OG-12") found in any of the texts (branch name, commit subject…).
export const ticketKey = (...texts) => texts.map((t) => String(t ?? '').match(/\b([A-Z][A-Z0-9]+-\d+)\b/)?.[1]).find(Boolean) ?? null;

// Time per ticket from a day's commits [{time (unix s), key}]: each commit is credited with the gap since
// your previous commit (any ticket), or `first` minutes when it starts a new session (gap > maxGap).
// Rounded to 15m, minimum 15m. ponytail: git-hours style guess; the user edits it before logging.
export function timeFromCommits(commits, { maxGap = 120, first = 30 } = {}) {
  const out = {};
  [...commits].sort((a, b) => a.time - b.time).forEach((c, n, xs) => {
    const gap = n ? (c.time - xs[n - 1].time) / 60 : Infinity;
    out[c.key ?? ''] = (out[c.key ?? ''] ?? 0) + (gap <= maxGap ? gap : first);
  });
  for (const k in out) out[k] = Math.max(15, Math.round(out[k] / 15) * 15);
  return out;
}

// A scheduled reminder {time: "16:00", days?: ["mon",…]} is due once per day, from its time until 2h later
// (so opening VS Code at 16:30 still shows the 16:00 one). Days default to weekdays.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function isDue(reminder, now, lastFiredOn) {
  const [h, m] = String(reminder.time ?? '').split(':').map(Number);
  if (!(h >= 0 && h < 24)) return false;
  const at = new Date(now);
  at.setHours(h, m || 0, 0, 0);
  const days = reminder.days?.length ? reminder.days.map((d) => d.slice(0, 3).toLowerCase()) : DAYS.slice(1, 6);
  return days.includes(DAYS[now.getDay()]) && now >= at && now - at < 2 * 3600e3 && lastFiredOn !== now.toLocaleDateString('en-CA');
}

// template tokens: {type} (feat | fix), {key}, {slug}. E.g. "{key}-{slug}" gives "OG-12-add-login".
export function branchName(issue, template = '{type}/{key}-{slug}') {
  const full = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = full.length <= 40 ? full : full.slice(0, 41).replace(/-[^-]*$/, ''); // cut at a word boundary
  return (template || '{type}/{key}-{slug}')
    .replace(/\{type\}/g, issue.issue_type === 'BUG' ? 'fix' : 'feat')
    .replace(/\{key\}/g, issue.key)
    .replace(/\{slug\}/g, slug);
}

// Where a remote lives, so we know how to open a pull request there.
export function parseRemote(url) {
  const u = String(url ?? '').trim();
  let m = u.match(/git-codecommit\.([\w-]+)\.amazonaws\.com\/v1\/repos\/([^/]+?)(?:\.git)?$/);
  if (m) return { kind: 'codecommit', region: m[1], repo: m[2] };
  m = u.match(/^codecommit:(?::([\w-]+))?:\/\/(?:[^@/]+@)?([^/]+)$/); // git-remote-codecommit: codecommit::region://repo
  if (m) return { kind: 'codecommit', region: m[1] ?? null, repo: m[2] };
  m = u.match(/(github\.com|gitlab\.com|bitbucket\.org)[:/](.+?)(?:\.git)?\/?$/);
  if (m) return { kind: m[1].split('.')[0], host: m[1], slug: m[2] };
  return { kind: 'other', url: u };
}

// The web page that starts a pull request from `branch` into `base` (prefilled where the host allows).
export function newPrUrl(remote, branch, base, title = '', body = '') {
  const q = encodeURIComponent;
  switch (remote.kind) {
    case 'codecommit':
      return `https://${remote.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${q(remote.repo)}/pull-requests/new/refs/heads/${base}/.../refs/heads/${branch}?region=${remote.region}`;
    case 'github':
      return `https://github.com/${remote.slug}/compare/${q(base)}...${q(branch)}?expand=1&title=${q(title)}&body=${q(body.slice(0, 6000))}`;
    case 'gitlab':
      return `https://gitlab.com/${remote.slug}/-/merge_requests/new?merge_request[source_branch]=${q(branch)}&merge_request[target_branch]=${q(base)}&merge_request[title]=${q(title)}&merge_request[description]=${q(body.slice(0, 6000))}`;
    case 'bitbucket':
      return `https://bitbucket.org/${remote.slug}/pull-requests/new?source=${q(branch)}&dest=${q(base)}`;
    default:
      return null;
  }
}

export const codecommitPrUrl = (remote, id) =>
  `https://${remote.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${encodeURIComponent(remote.repo)}/pull-requests/${id}/details?region=${remote.region}`;

// Pull request description from the ticket: link, description, subtasks as a checklist, commits.
export function prBody(issue, commits = []) {
  const kids = (issue.children ?? []).map((c) => `- [${c.status_detail?.category === 'DONE' ? 'x' : ' '}] ${c.key} ${c.title}`);
  return [
    issueUrl(issue.key) ? `Ticket: [${issue.key}](${issueUrl(issue.key)}) ${issue.title}` : `Ticket: ${issue.key} ${issue.title}`,
    issue.description?.trim() || null,
    kids.length ? `## Subtasks\n${kids.join('\n')}` : null,
    commits.length ? `## Commits\n${commits.map((c) => `- ${c}`).join('\n')}` : null,
  ].filter(Boolean).join('\n\n');
}

// Start of the previous working day (Mon -> Fri), local time: "yesterday" for a standup.
export function previousWorkday(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  do d.setDate(d.getDate() - 1); while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}

// Check out the ticket's branch (created from origin's default branch if new), or put it in a
// sibling worktree "<repo>-<KEY>" for parallel work. git(cwd, ...args) -> Promise<stdout>.
export async function startBranch(git, cwd, issue, worktree, template) {
  const root = await git(cwd, 'rev-parse', '--show-toplevel');
  const branch = branchName(issue, template);
  const exists = !!(await git(root, 'branch', '--list', branch));
  const base = await git(root, 'rev-parse', '--abbrev-ref', 'origin/HEAD').catch(() => 'HEAD');
  const create = ['--no-track', '-b', branch];
  if (!worktree) {
    await git(root, 'checkout', ...(exists ? [branch] : [...create, base]));
    return { branch, path: root };
  }
  const wt = `${root}-${issue.key}`;
  if (!(await git(root, 'worktree', 'list', '--porcelain')).includes(`worktree ${wt}\n`))
    await git(root, 'worktree', 'add', ...(exists ? [wt, branch] : [...create, wt, base]));
  return { branch, path: wt };
}

// ---------- ticket health: a deterministic checklist used by the board, the CLI and the Claude skill ----------
// Works on a saved issue or a draft ({title, description, issue_type, estimate_minutes}).
export function ticketQuality(t) {
  const title = (t.title ?? '').trim(), desc = (t.description ?? '').trim(), type = t.issue_type ?? 'TASK';
  const checks = [
    { id: 'title', ok: title.length >= 10 && title.length <= 90 && !/[.!]$/.test(title) && /\s/.test(title), label: 'Specific title',
      hint: 'Say what changes, in 10–90 characters: "Add retry to webhook delivery", not "Webhooks".' },
    { id: 'description', ok: desc.replace(/^#+.*$/gm, '').trim().length >= 40, label: 'Description with context',
      hint: type === 'BUG' ? 'Say what happens and where.' : 'Say why it matters and what changes.' },
  ];
  if (type === 'BUG') checks.push({ id: 'repro', ok: /steps to reproduce|repro/i.test(desc) && /expected/i.test(desc) && /actual/i.test(desc), label: 'Steps, expected and actual',
    hint: 'Add "## Steps to reproduce", "## Expected" and "## Actual".' });
  else if (type !== 'EPIC') checks.push({ id: 'criteria', ok: /- \[[ xX]\]/.test(desc) || /acceptance criteria/i.test(desc), label: 'Acceptance criteria',
    hint: 'Add a "## Acceptance criteria" checklist ("- [ ] …") so done is unambiguous.' });
  if (type === 'STORY') checks.push({ id: 'why', ok: /^##\s*why|as an? .+ i want|so that/im.test(desc), label: 'Who it is for and why',
    hint: 'Add "## Why", or "As a … I want … so that …".' });
  if (type !== 'EPIC') {
    checks.push({ id: 'estimate', ok: (t.estimate_minutes ?? 0) > 0, label: 'Estimate', hint: 'Set an estimate (e.g. 3h).' });
    if ((t.estimate_minutes ?? 0) > 960) checks.push({ id: 'size', ok: false, warn: true, label: 'Small enough', hint: 'Over 2 days: break it down into subtasks.' });
  }
  const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
  return { score, checks };
}

// Description skeletons the board and the skill offer per type.
export const TEMPLATES = {
  BUG: '## Steps to reproduce\n1. \n\n## Expected\n\n## Actual\n\n## Environment\n',
  STORY: '## Why\nAs a … I want … so that …\n\n## What\n\n## Acceptance criteria\n- [ ] ',
  TASK: '## Why\n\n## What\n\n## Acceptance criteria\n- [ ] ',
  SUBTASK: '## What\n\n## Acceptance criteria\n- [ ] ',
  EPIC: '## Goal\n\n## Scope\n\n## Out of scope\n\n## Success looks like\n',
};

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  html: 'text/html', zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};
export const mimeOf = (name) => MIME[String(name).split('.').pop().toLowerCase()] ?? 'application/octet-stream';
export const attachmentKind = (name) => {
  const t = mimeOf(name);
  return t.startsWith('image/') ? 'image' : t.startsWith('video/') ? 'video' : t === 'application/pdf' ? 'pdf' : 'file';
};
export const issueTarget = (issue) => ({ target_type: 'issues.issue', target_id: issue.id });
export const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// load(): {access, refresh} | null, save(tokens | null): persist. Both may be async.
// base: the API server's address, or a function returning it (so a changed setting takes effect at once).
// A server error as a sentence. Field errors say more than "Invalid input.", so they replace it:
// {estimate_minutes: ["Estimate First: add an estimate first."]} → "Estimate First: add an estimate first."
// {title: ["This field may not be blank."]} → "Title: This field may not be blank."
export function errorText(message, errors) {
  const parts = Object.entries(errors ?? {}).flatMap(([field, msgs]) => [].concat(msgs).map((m) => {
    const label = field.replace(/_(minutes|id)$/, '').replace(/_/g, ' ');
    const named = ['non field errors', 'detail'].includes(label) || String(m).toLowerCase().includes(label.split(' ')[0]);
    return named ? String(m) : `${label[0].toUpperCase()}${label.slice(1)}: ${m}`;
  }));
  return parts.length ? parts.join(' ') : message;
}

export function createClient({ load, save, base }) {
  const root = () => {
    const b = trimUrl(typeof base === 'function' ? base() : base);
    if (!b) throw Object.assign(new Error('No server address set'), { noServer: true });
    return b;
  };
  // opts may arrive as null: the board webview's messages are JSON-serialized, which turns undefined into null.
  async function req(path, opts, retry = true) {
    const { method = 'GET', body, headers } = opts ?? {};
    const tok = await load();
    const res = await fetch(root() + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(tok?.access && { Authorization: `Bearer ${tok.access}` }), ...headers },
      body: body && JSON.stringify(body),
    });
    if (res.status === 401 && retry && tok?.refresh) {
      const r = await fetch(root() + '/auth/token/refresh/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: tok.refresh }),
      });
      const data = r.ok ? (await r.json()).data : null;
      if (data?.access) {
        await save({ ...tok, ...data });
        return req(path, { method, body, headers }, false);
      }
      await save(null);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(errorText(json?.message || `${res.status} ${res.statusText}`, json?.errors)), { status: res.status, errors: json?.errors ?? {} });
    return json?.data;
  }

  const api = {
    req,
    async login(username, password) {
      await save(await req('/auth/token/', { method: 'POST', body: { username, password } }, false));
      return api.me();
    },
    logout: () => save(null),
    me: () => req('/auth/me/'),
    workspaces: async () => list(await req('/api/workspaces/')),
    projects: async (workspace) =>
      list(await req('/api/projects/' + (workspace ? `?workspace=${workspace}` : ''))).filter((p) => !workspace || p.workspace == null || String(idOf(p.workspace)) === String(workspace)),
    statuses: async (project) => list(await req(`/api/projects/${project}/statuses/`)),

    myIssues: (workspace, assignee) => issuesWhere(req, { workspace, assignee, open: 'true' }),

    // "ESG-12" -> issue. The app scopes key lookups by project, so resolve the project from the key prefix.
    async issue(key) {
      const prefix = key.split('-')[0].toUpperCase();
      const p = (await api.projects()).find((p) => p.key?.toUpperCase() === prefix);
      return req(`/api/issues/${encodeURIComponent(key)}/` + (p ? `?project=${p.id}` : ''));
    },
    async projectByKey(key) {
      const p = (await api.projects()).find((p) => p.key?.toUpperCase() === key.toUpperCase() || p.id === key);
      if (!p) throw new Error(`No project "${key}"`);
      return p;
    },

    create: (body) => req('/api/issues/', { method: 'POST', body }),
    update: (id, changes) => req(`/api/issues/${id}/`, { method: 'PATCH', body: changes }),
    logWork: (issue, minutes, note = '', logged_on = today()) =>
      req('/api/worklogs/', { method: 'POST', body: { issue, minutes, logged_on, note } }),
    comment: (issue, body) => req('/api/comments/', { method: 'POST', body: { issue, body } }),
    comments: async (issue) => list(await req(`/api/comments/?issue=${issue}`)),
    worklogs: async (issue) => list(await req(`/api/worklogs/?issue=${issue}`)),

    // ---------- the app's own AI (server side; me.ai_enabled says whether it's on) ----------
    // Errors carry .status: 400 = nothing to work with, 429 = busy (try again in a minute).
    draft: (project, text) => req('/api/issues/draft/', { method: 'POST', body: { project, text: String(text).slice(0, 4000) } }),
    summary: (issueId, fresh) => req(`/api/issues/${issueId}/summary/`, fresh ? { headers: { 'Cache-Control': 'no-cache' } } : undefined),
    similar: async (project, q) => list(await req(`/api/issues/similar/?${new URLSearchParams({ project, q })}`)),
    aiStandup: (user, workspace, fresh) =>
      req(`/api/activity/users/${user}/standup/?${new URLSearchParams({ workspace, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })}`,
        fresh ? { headers: { 'Cache-Control': 'no-cache' } } : undefined),
    filterFromText: (project, text) => req(`/api/projects/${project}/filter-from-text/`, { method: 'POST', body: { text } }),

    // ---------- attachments: presign, PUT the bytes to storage, register (as the app does) ----------
    attachmentUrl: (id, download) => req(`/api/attachments/${id}/url/${download ? '?download=1' : ''}`),
    async attach(target, { name, bytes, type }) {
      if (bytes.length > MAX_ATTACHMENT) throw new Error(`${name} is larger than 20 MB`);
      const content_type = type || mimeOf(name);
      const { key, url } = await req('/api/attachments/presign/', { method: 'POST', body: { ...target, name, size: bytes.length, content_type } });
      const put = await fetch(url, { method: 'PUT', body: bytes, headers: { 'Content-Type': content_type } });
      if (!put.ok) throw new Error(`Uploading ${name} failed (${put.status})`);
      return req('/api/attachments/', { method: 'POST', body: { ...target, key, name } });
    },
    deleteAttachment: (id) => req(`/api/attachments/${id}/`, { method: 'DELETE' }),

    // Assign to me and move to the first "in progress" status.
    async startIssue(issue, assignee) {
      const s = await api.findStatus(issue.project, 'IN_PROGRESS').catch(() => null);
      return api.update(issue.id, { assignee, ...(s && { status: s.id }) });
    },

    // Match a status by name ("In review") or category ("IN_PROGRESS", "DONE").
    async findStatus(project, name) {
      const st = await api.statuses(project);
      const n = name.toLowerCase().replace(/[\s-]+/g, '_');
      const s = st.find((s) => s.name.toLowerCase().replace(/[\s-]+/g, '_') === n) || st.find((s) => s.category?.toLowerCase() === n);
      if (!s) throw new Error(`No status "${name}". Options: ${st.map((s) => s.name).join(', ')}`);
      return s;
    },
  };
  return api;
}

// ---------- fun: streaks, badges, lucky dip, weekly wrap-up, tips (pure; shared by the extension and the board) ----------
// The journal is Ajwain's own record of what you did through it:
// [{t (ms), type: 'log'|'pr'|'finish'|'start'|'breakdown'|'break'|'focus'|'lucky'|'standup'|'ticket', key?, minutes?, issue_type?, cleanup?, score?}]
const dayKey = (t) => new Date(t).toLocaleDateString('en-CA');
const WORK = new Set(['log', 'pr', 'finish']);
const count = (j, type) => j.filter((e) => e.type === type).length;

// Consecutive workdays with some shipped work (time logged, a PR, a finish). Weekends never break it, and an
// empty today doesn't either, until the day is over.
export function streak(journal, now = Date.now()) {
  const days = new Set(journal.filter((e) => WORK.has(e.type) && e.t <= now).map((e) => dayKey(e.t)));
  let d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (!days.has(dayKey(d)) || d.getDay() === 0 || d.getDay() === 6) d = previousWorkday(d);
  let n = 0;
  while (days.has(dayKey(d))) {
    n++;
    d = previousWorkday(d);
  }
  return n;
}

export const BADGES = [
  { id: 'first-pr', name: 'First PR', icon: 'branch', hint: 'Open a pull request from Ajwain', test: (j) => count(j, 'pr') >= 1 },
  { id: 'shipper', name: 'Shipper', icon: 'branch', hint: 'Open 10 pull requests', test: (j) => count(j, 'pr') >= 10 },
  { id: 'finisher', name: 'Finisher', icon: 'check', hint: 'Finish 10 tickets', test: (j) => count(j, 'finish') >= 10 },
  { id: 'bug-squasher', name: 'Bug squasher', icon: 't_bug', hint: 'Finish 5 bugs', test: (j) => j.filter((e) => e.type === 'finish' && e.issue_type === 'BUG').length >= 5 },
  { id: 'planner', name: 'Planner', icon: 't_subtask', hint: 'Break down 3 tickets', test: (j) => count(j, 'breakdown') >= 3 },
  { id: 'well-written', name: 'Well written', icon: 'sparkle', hint: 'Create 5 tickets with full ticket health', test: (j) => j.filter((e) => e.type === 'ticket' && e.score === 100).length >= 5 },
  { id: 'timekeeper', name: 'Timekeeper', icon: 'clock', hint: 'Log time on 5 different days', test: (j) => new Set(j.filter((e) => e.type === 'log').map((e) => dayKey(e.t))).size >= 5 },
  { id: 'clean-desk', name: 'Clean desk', icon: 'trash', hint: 'Tidy up 5 branches or worktrees when finishing', test: (j) => j.filter((e) => e.type === 'finish' && e.cleanup).length >= 5 },
  { id: 'deep-focus', name: 'Deep focus', icon: 'eye', hint: 'Stay focused for 90 minutes straight', test: (j) => j.some((e) => e.type === 'focus' && e.minutes >= 90) },
  { id: 'bendy', name: 'Bendy', icon: 'stretch', hint: 'Take 10 stretch breaks', test: (j) => count(j, 'break') >= 10 },
  { id: 'lucky', name: 'Feeling lucky', icon: 'dice', hint: 'Start a ticket from the lucky dip', test: (j) => count(j, 'lucky') >= 1 },
  { id: 'storyteller', name: 'Storyteller', icon: 'comment', hint: 'Share 5 standups', test: (j) => count(j, 'standup') >= 5 },
  { id: 'on-a-roll', name: 'On a roll', icon: 'flame', hint: 'Keep a 5-workday shipping streak', test: (j) => streak(j, j[j.length - 1]?.t) >= 5 },
];

// Each badge with when it was unlocked (the journal entry that first satisfied it), or null.
export function badges(journal) {
  const j = [...journal].sort((a, b) => a.t - b.t);
  return BADGES.map(({ test, ...b }) => {
    if (!test(j)) return { ...b, unlockedAt: null };
    let lo = 0, hi = j.length - 1; // the first prefix that passes (tests are monotonic in the journal)
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (test(j.slice(0, mid + 1))) hi = mid;
      else lo = mid + 1;
    }
    return { ...b, unlockedAt: j[lo].t };
  });
}

// Lucky dip: a weighted pick from the queue. Higher priority, overdue or due soon = more likely.
const PRIORITY_WEIGHT = { HIGHEST: 5, HIGH: 4, MEDIUM: 3, LOW: 2, LOWEST: 1 };
// How much the lucky dip favours an issue: priority, times 3 if overdue or 2 if due within three days.
export function luckyWeight(i, today = new Date().toLocaleDateString('en-CA')) {
  const soon = new Date(Date.parse(today) + 3 * 864e5).toISOString().slice(0, 10);
  const due = i.due_date ? String(i.due_date).slice(0, 10) : null;
  return (PRIORITY_WEIGHT[i.priority] ?? 3) * (due && due < today ? 3 : due && due <= soon ? 2 : 1);
}
// What kind of win a pick is, which sets the machine's lights and sound. A bug is its own (sad) thing; then how
// urgent it is (jackpot: highest priority or overdue; big: high priority or due within three days); then how small
// (easy: low priority, or an hour or less); otherwise a plain win.
export function luckyMood(i, today = new Date().toLocaleDateString('en-CA')) {
  if (i.issue_type === 'BUG') return 'bug';
  const p = PRIORITY_WEIGHT[i.priority] ?? 3, due = luckyWeight(i, today) / p;
  if (i.priority === 'HIGHEST' || due >= 3) return 'jackpot';
  if (i.priority === 'HIGH' || due >= 2) return 'big';
  return p <= 2 || (i.estimate_minutes > 0 && i.estimate_minutes <= 60) ? 'easy' : 'win';
}
export const luckyPayout = (i, today) => luckyWeight(i, today) * 100; // the WIN meter: points for taking it on
export function luckyPick(issues, rand = Math.random, today = new Date().toLocaleDateString('en-CA')) {
  const weighted = issues.map((i) => [i, luckyWeight(i, today)]);
  let r = rand() * weighted.reduce((a, [, w]) => a + w, 0);
  for (const [i, w] of weighted) if ((r -= w) < 0) return i;
  return weighted.at(-1)?.[0] ?? null;
}

// The week so far (Monday 00:00 to now): the numbers behind "Ajwain Wrapped".
export function weekStats(journal, commits = [], now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const inWeek = (t) => t >= start.getTime() && t <= now;
  const j = journal.filter((e) => inWeek(e.t));
  const cs = commits.filter((c) => inWeek(c.time * 1000));
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0)); // [Mon..Sun][hour]
  for (const c of cs) {
    const d = new Date(c.time * 1000);
    heat[(d.getDay() + 6) % 7][d.getHours()]++;
  }
  const perDay = heat.map((h) => h.reduce((a, b) => a + b, 0));
  const busiest = perDay.indexOf(Math.max(...perDay));
  const s = {
    start: start.getTime(),
    commits: cs.length,
    tickets: new Set(cs.map((c) => c.key).filter(Boolean)).size,
    prs: count(j, 'pr'),
    finished: count(j, 'finish'),
    bugs: j.filter((e) => e.type === 'finish' && e.issue_type === 'BUG').length,
    minutes: j.filter((e) => e.type === 'log').reduce((a, e) => a + (e.minutes ?? 0), 0),
    breaks: count(j, 'break'),
    focus: Math.max(0, ...j.filter((e) => e.type === 'focus').map((e) => e.minutes ?? 0)),
    breakdowns: count(j, 'breakdown'),
    late: cs.filter((c) => new Date(c.time * 1000).getHours() >= 21).length,
    heat,
    busiest: perDay[busiest] ? busiest : null,
    streak: streak(journal, now),
  };
  s.title =
    s.bugs >= 3 ? ['Bug squasher', 'Three or more bugs gone this week.']
    : s.prs >= 3 ? ['The shipper', 'Pull request after pull request.']
    : s.breakdowns >= 2 ? ['The planner', 'Big tickets, neatly broken down.']
    : s.late >= 3 ? ['Night owl', 'A lot of late commits. Get some sleep.']
    : s.minutes >= 30 * 60 ? ['The machine', 'Over 30 hours logged.']
    : s.focus >= 90 ? ['Deep diver', 'Long, focused sessions.']
    : ['Steady hand', 'Consistent, quiet progress.'];
  return s;
}

export const TIPS = [
  'Hover a ticket key in code to see its status, start it, or hand it to Claude.',
  'A TODO with a lightbulb becomes a ticket in two keystrokes, then gets tagged TODO(KEY).',
  'Paste a screenshot into a description or comment and it is attached automatically.',
  'Stuck choosing? The lucky dip picks your next ticket, weighted by priority and due date.',
  'Break big tickets down before starting: smaller pull requests get reviewed faster.',
  'Start work in a worktree to keep two tickets moving without stashing.',
  '"Draft from notes" turns a chat thread or an email into a ticket using the app\'s own AI.',
  'Ticket health checks titles, context, acceptance criteria and estimates as you type.',
  'Type a filter in plain words: "my open bugs this sprint".',
  'Open PR pushes, creates the pull request, moves the ticket to review and links it.',
  'Finish logs your timer, sets the final status and tidies up the branch.',
  'Ajwain (carom seed) is famous for helping digestion. Small tickets are easier to digest too.',
  'A 20-20-20 break: every 20 minutes, look 20 feet away for 20 seconds.',
  'Your standup is already written: Today → Write standup.',
  'Commit messages that start with the ticket key are credited to that ticket in Today.',
  'Friday afternoon brings your week, wrapped.',
];
export const tipOfTheDay = (date = new Date()) => TIPS[Math.floor(date.getTime() / 864e5) % TIPS.length];
