// In-memory project management API (the real server's shape) for tests and the board preview. Node built-ins only.
//   import { startMockApi } from './mock-api.mjs'; const mock = await startMockApi(); ... mock.url, mock.state, mock.log
//   node test/mock-api.mjs [port]   (default 8765) then open http://localhost:8765/dev/preview.html#view=board&project=OG
// Responses use the real envelope: {success:true, data} / {success:false, message, status_code, errors}.
// Every user's password is "secret"; the bearer token "test" is always accepted as sam.
// Control endpoints (no auth): GET /_log, POST /_reset, POST /_busy (next AI call -> 429), GET /_fixtures/commits.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PASSWORD = 'secret';
// Readable fixed ids: uid(1) = 00000000-0000-4000-8000-000000000001.
export const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();

export function fixture() {
  const [ME, ANA, KAI, NIA] = [1, 2, 3, 4].map(uid);
  const user = (id, username, first_name, last_name) => ({ id, username, first_name, last_name, email: `${username}@example.com`, is_active: true });
  const users = [user(ME, 'sam', 'Sam', 'Lee'), user(ANA, 'ana', 'Ana', 'Ruiz'), user(KAI, 'kai', 'Kai', 'Moreau'), user(NIA, 'nia', 'Nia', 'Shah')];
  const [W1, W2] = [uid(11), uid(12)];
  const workspaces = [{ id: W1, name: 'Acme' }, { id: W2, name: 'Personal' }];
  const project = (id, workspace, key, name, members) => ({
    id, workspace, name, key, accent_color: '#F28C28', is_private: false, members, is_archived: false,
    sprint_naming: 'Sprint {n}', created_at: '2025-01-06T09:00:00Z', updated_at: '2026-09-01T09:00:00Z',
  });
  const [OG, ESG, HOME] = [uid(21), uid(22), uid(23)];
  const projects = [project(OG, W1, 'OG', 'Platform', [ME, ANA, KAI, NIA]), project(ESG, W1, 'ESG', 'Reporting', [ME, ANA]), project(HOME, W2, 'HOME', 'Home', [ME, ANA])];
  let sid = 31;
  const statusSet = (pid, names) => names.map(([name, category, color], order) => ({ id: uid(sid++), project: pid, name, category, custom_category: null, color, order }));
  const statuses = [
    ...statusSet(OG, [['To Do', 'TODO', null], ['In Progress', 'IN_PROGRESS', 'amber'], ['To be Tested', 'IN_PROGRESS', 'blue'], ['Done', 'DONE', 'green']]),
    ...statusSet(ESG, [['To Do', 'TODO', null], ['In Progress', 'IN_PROGRESS', 'amber'], ['In Review', 'IN_PROGRESS', 'sky'], ['Done', 'DONE', 'green']]),
    ...statusSet(HOME, [['To Do', 'TODO', null], ['Doing', 'IN_PROGRESS', null], ['Done', 'DONE', null]]),
  ];
  const st = (pid, n) => statuses.filter((s) => s.project === pid)[n].id;
  const sprints = [
    { id: uid(51), project: OG, name: 'Sprint 13', state: 'CLOSED', start_date: day(-21), end_date: day(-8) },
    { id: uid(52), project: OG, name: 'Sprint 14', state: 'ACTIVE', start_date: day(-7), end_date: day(6) },
    { id: uid(53), project: OG, name: 'Sprint 15', state: 'PLANNED', start_date: day(7), end_date: day(20) },
    { id: uid(54), project: ESG, name: 'ESG Sprint 3', state: 'ACTIVE', start_date: day(-3), end_date: day(10) },
  ];
  const [CLOSED, ACTIVE, PLANNED] = [uid(51), uid(52), uid(53)];
  const tags = [
    { id: uid(61), workspace: W1, title: 'frontend', slug: 'frontend', color: 'violet' },
    { id: uid(62), workspace: W1, title: 'api', slug: 'api', color: 'blue' },
    { id: uid(63), workspace: W1, title: 'customer', slug: 'customer', color: 'rose' },
    { id: uid(64), workspace: W2, title: 'errands', slug: 'errands', color: 'green' },
  ];
  const [FE, API, CUST] = [uid(61), uid(62), uid(63)];
  let mid = 501;
  const members = [
    ...[[ME, 'ADMIN'], [ANA, 'MEMBER'], [KAI, 'MEMBER'], [NIA, 'MEMBER']].map(([u, role]) => ({ workspace: W1, u, role })),
    ...[[ME, 'OWNER'], [ANA, 'MEMBER']].map(([u, role]) => ({ workspace: W2, u, role })),
  ].map(({ workspace, u, role }) => {
    const { id, username, first_name, last_name, is_active } = users.find((x) => x.id === u);
    return { id: uid(mid++), workspace, user: { id, username, first_name, last_name, is_active }, role, invite_pending: false, created_at: '2025-01-06T09:00:00Z' };
  });

  const DESC_1730 = '## Why\nWebhook deliveries fail silently when the receiver is down for **a few seconds**.\n\n## What\nRetry with exponential backoff in `webhooks/delivery.py`.\n\n## Acceptance criteria\n- [x] Retries up to 3 times\n- [ ] Final failure is logged with the request id';
  const DESC_1731 = 'Users with 2FA get bounced back to the login page on Safari 17.\n\n## Steps to reproduce\n1. Enable 2FA\n2. Sign in on Safari\n\n## Expected\nThe dashboard opens.\n\n## Actual\nThe login page reloads.';
  // [project, number, title, type, priority, status#, assignee, reporter, sprint, tags, estimate, logged, due, description, parent number]
  const rows = [
    [OG, 1730, 'Add retry with backoff to webhook delivery', 'TASK', 'HIGH', 1, ME, ANA, ACTIVE, [API], 240, 120, day(2), DESC_1730],
    [OG, 1731, 'Login fails on Safari when 2FA is enabled', 'BUG', 'HIGHEST', 1, ANA, ME, ACTIVE, [FE, CUST], 180, 200, day(-4), DESC_1731],
    [OG, 1732, 'Dashboard: show sprint burndown chart', 'STORY', 'MEDIUM', 2, ME, KAI, ACTIVE, [FE], 480, 60, day(-1), ''], // overdue, mine
    [OG, 1733, 'Migrate report exports to background jobs', 'TASK', 'MEDIUM', 3, KAI, ME, ACTIVE, [API], 960, 300, null, ''],
    [OG, 1734, 'Holiday calendar ignores timezone', 'BUG', 'LOW', 0, null, ANA, ACTIVE, [], null, 0, null, ''], // unassigned
    [OG, 1735, 'Allow bulk status change from the table', 'STORY', 'MEDIUM', 1, ME, NIA, PLANNED, [FE], 120, 0, null, ''],
    [OG, 1736, 'Report PDF has broken table borders', 'BUG', 'HIGH', 0, NIA, ME, ACTIVE, [CUST], 90, 30, day(1), ''],
    [OG, 1737, 'Write onboarding guide for new PMs', 'TASK', 'LOWEST', 2, ANA, ANA, null, [], 60, 0, null, ''],
    [OG, 1738, 'Add RetryQueue table', 'SUBTASK', 'LOW', 3, ME, KAI, ACTIVE, [API], 30, 30, null, '', 1730],
    [OG, 1739, 'Notifications: mark all as read', 'STORY', 'MEDIUM', 0, KAI, ME, PLANNED, [FE], null, 0, null, ''],
    [OG, 1740, 'Time tracking v2', 'EPIC', 'HIGH', 1, ME, ANA, ACTIVE, [], 2400, 900, day(55), '## Goal\nTrack time where the work happens.'],
    [OG, 1741, 'Search by key returns stale results', 'BUG', 'MEDIUM', 0, null, NIA, CLOSED, [API], 120, 0, null, ''],
    [ESG, 11, 'Import usage data from CSV', 'TASK', 'MEDIUM', 0, ME, ANA, uid(54), [API], 240, 0, day(5), ''],
    [ESG, 12, 'Export misses section C', 'BUG', 'HIGH', 1, ANA, ME, uid(54), [CUST], 120, 60, null, ''],
    [HOME, 1, 'Renew passport', 'TASK', 'MEDIUM', 0, ME, ME, null, [], 60, 0, null, ''],
  ];
  const issues = rows.map(([pid, number, title, issue_type, priority, s, assignee, reporter, sprint, tg, estimate_minutes, logged_minutes, due_date, description], n) => ({
    id: uid(101 + n), project: pid, number, key: `${projects.find((p) => p.id === pid).key}-${number}`, issue_type, priority, title,
    parent: null, status: st(pid, s), sprint, reporter, assignee, tags: tg, estimate_minutes, logged_minutes,
    start_date: null, due_date, resolved_at: statuses.find((x) => x.id === st(pid, s)).category === 'DONE' ? ago(60 * 24 * 2) : null,
    description, created_at: ago(60 * 24 * (30 - n)), updated_at: ago(n === 6 ? 60 * 24 * 9 : 60 * (n + 1)), // OG-1736 (n = 6) has been idle for 9 days
  }));
  issues.find((i) => i.key === 'OG-1738').parent = issues.find((i) => i.key === 'OG-1730').id;
  const issue = (key) => issues.find((i) => i.key === key).id;

  return {
    users, workspaces, projects, statuses, sprints, tags, members, issues,
    comments: [
      { id: uid(201), issue: issue('OG-1730'), author: ANA, body: 'Can we also cap the retry window at **1 minute**?', created_at: ago(180) },
      { id: uid(202), issue: issue('OG-1731'), author: ME, body: 'Reproduced on Safari 17.4.', created_at: ago(60 * 26) },
    ],
    worklogs: [
      { id: uid(301), issue: issue('OG-1730'), user: ME, minutes: 30, logged_on: day(0), note: 'Retry scheduler' },
      { id: uid(302), issue: issue('OG-1730'), user: ANA, minutes: 90, logged_on: day(-1), note: 'Review' },
      { id: uid(303), issue: issue('OG-1733'), user: KAI, minutes: 300, logged_on: day(-2), note: 'Export worker' },
    ],
    // Attachments of all issues: {id, issue, key (storage), name, size, content_type, created_at, uploaded_by}.
    attachments: [{ id: uid(401), issue: issue('OG-1731'), key: 'fixtures/safari.txt', name: 'safari.txt', size: 19, content_type: 'text/plain', created_at: ago(600), uploaded_by: ME }],
    storage: { 'fixtures/safari.txt': { type: 'text/plain', bytes: Buffer.from('Safari 17.4, macOS\n') } },
    summaries: {}, tokens: { test: ME }, refresh: {}, busy: false, estimateFirst: false,
    me: ME, // the user the fixture is written for (username "sam")
  };
}

// Today's commits for the board's Today view, as the extension's myCommits() returns them.
export function fixtureCommits(now = Math.floor(Date.now() / 1000)) {
  const M = 60;
  return [
    { hash: 'a1b2c3d4e5f60718', time: now - 300 * M, subject: 'OG-1730: add retry scheduler', branch: 'feat/OG-1730-add-retry', key: 'OG-1730', repo: 'app' },
    { hash: 'b2c3d4e5f6071829', time: now - 255 * M, subject: 'OG-1730: exponential backoff', branch: 'feat/OG-1730-add-retry', key: 'OG-1730', repo: 'app' },
    { hash: 'c3d4e5f60718293a', time: now - 210 * M, subject: 'fix: safari 2fa redirect', branch: 'fix/OG-1731-login-safari', key: 'OG-1731', repo: 'app' },
    { hash: 'd4e5f60718293a4b', time: now - 120 * M, subject: 'fix(pdf): table borders in export', branch: 'pdf-export-fixes', key: null, repo: 'app' },
    { hash: 'e5f60718293a4b5c', time: now - 90 * M, subject: 'chore: bump pdf lib', branch: 'pdf-export-fixes', key: null, repo: 'app' },
  ];
}

class HttpError extends Error {
  constructor(status, message, errors = {}) { super(message); Object.assign(this, { status, errors }); }
}
const need = (cond, status, message, errors) => { if (!cond) throw new HttpError(status, message, errors); };
const same = (a, b) => String(a ?? '') === String(b ?? '');
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
const STATIC_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const ISSUE_FIELDS = ['title', 'description', 'issue_type', 'priority', 'status', 'assignee', 'reporter', 'sprint', 'parent', 'tags', 'estimate_minutes', 'start_date', 'due_date'];

export function startMockApi({ port = 0 } = {}) {
  const state = fixture();
  const log = [];
  const S = state;

  // ---------- serializers ----------
  const project = (id) => S.projects.find((p) => same(p.id, id));
  const status = (id) => S.statuses.find((s) => same(s.id, id));
  const attachment = (a) => ({ id: a.id, name: a.name, size: a.size, content_type: a.content_type, created_at: a.created_at, uploaded_by: a.uploaded_by });
  const issueView = (i) => {
    const s = status(i.status), sp = S.sprints.find((x) => same(x.id, i.sprint)), parent = S.issues.find((x) => same(x.id, i.parent));
    return {
      id: i.id, project: i.project, number: i.number, key: i.key, issue_type: i.issue_type, priority: i.priority, title: i.title,
      parent: i.parent, parent_key: parent?.key ?? null, parent_title: parent?.title ?? null, status: i.status,
      status_detail: s ? { id: s.id, name: s.name, category: s.category, color: s.color } : null,
      sprint: i.sprint, sprint_detail: sp ? { id: sp.id, name: sp.name, state: sp.state } : null,
      reporter: i.reporter, assignee: i.assignee, tags: [...i.tags], estimate_minutes: i.estimate_minutes, logged_minutes: i.logged_minutes,
      start_date: i.start_date, due_date: i.due_date, resolved_at: i.resolved_at,
      attachment_count: S.attachments.filter((a) => a.issue === i.id).length, description: i.description, created_at: i.created_at, updated_at: i.updated_at,
    };
  };
  const issueDetail = (i) => ({
    ...issueView(i),
    children: S.issues.filter((c) => c.parent === i.id).map(issueView),
    attachments: S.attachments.filter((a) => a.issue === i.id).map(attachment),
  });
  const projectView = (p) => ({ ...p, issue_count: S.issues.filter((i) => i.project === p.id).length });
  const findIssue = (ref, q) => {
    const i = S.issues.find((x) => x.id === ref || (x.key.toUpperCase() === decodeURIComponent(ref).toUpperCase() && (!q?.get('project') || same(x.project, q.get('project')))));
    need(i, 404, 'Not found.');
    return i;
  };
  const paginate = (rows, q, base, pathname) => {
    const size = Math.min(Number(q.get('page_size')) || 25, 500), page = Number(q.get('page')) || 1;
    const link = (n) => { const u = new URLSearchParams(q); u.set('page', String(n)); return `${base}${pathname}?${u}`; };
    return { count: rows.length, next: page * size < rows.length ? link(page + 1) : null, previous: page > 1 ? link(page - 1) : null, results: rows.slice((page - 1) * size, page * size) };
  };
  const ai = () => {
    if (!S.busy) return;
    S.busy = false;
    throw new HttpError(429, 'The assistant is busy. Try again in a minute.');
  };
  const applyIssue = (i, b, user) => {
    // "Estimate first" (state.estimateFirst): a ticket can't move into progress without an estimate.
    need(!(S.estimateFirst && b.status !== undefined && status(b.status)?.category === 'IN_PROGRESS' && !(b.estimate_minutes ?? i.estimate_minutes)),
      400, 'Invalid input.', { estimate_minutes: ['Estimate First: add an estimate first.'] });
    for (const k of ISSUE_FIELDS) if (b[k] !== undefined) i[k] = k === 'tags' ? [...(b[k] ?? [])] : b[k];
    if (b.status !== undefined) {
      need(status(i.status) && same(status(i.status).project, i.project), 400, 'Invalid status.', { status: ['Not a status of this project.'] });
      i.resolved_at = status(i.status).category === 'DONE' ? (i.resolved_at ?? new Date().toISOString()) : null;
    }
    i.updated_at = new Date().toISOString();
    i.updated_by = user;
  };

  // ---------- routes: [method, pattern, handler({m, q, b, user, base, req})] ----------
  const routes = [
    ['POST', /^\/auth\/token\/$/, ({ b }) => {
      const u = S.users.find((x) => x.username === b?.username);
      need(u && b?.password === PASSWORD, 401, 'No active account found with the given credentials');
      const access = `access-${crypto.randomUUID()}`, refresh = `refresh-${crypto.randomUUID()}`;
      S.tokens[access] = u.id;
      S.refresh[refresh] = u.id;
      return { access, refresh };
    }],
    ['POST', /^\/auth\/token\/refresh\/$/, ({ b }) => {
      const u = S.refresh[b?.refresh];
      need(u, 401, 'Token is invalid or expired');
      const access = `access-${crypto.randomUUID()}`;
      S.tokens[access] = u;
      return { access };
    }],
    ['GET', /^\/auth\/me\/$/, ({ user }) => ({ ...S.users.find((u) => u.id === user), ai_enabled: true, avatar: null, timezone: 'UTC' })],
    ['GET', /^\/api\/workspaces\/$/, () => S.workspaces],
    ['GET', /^\/api\/projects\/$/, ({ q }) => S.projects.filter((p) => !q.get('workspace') || same(p.workspace, q.get('workspace'))).map(projectView)],
    ['GET', /^\/api\/projects\/([^/]+)\/statuses\/$/, ({ m }) => (need(project(m[1]), 404, 'Not found.'), S.statuses.filter((s) => same(s.project, m[1])).map(({ project: _, ...s }) => s))],
    ['POST', /^\/api\/projects\/([^/]+)\/filter-from-text\/$/, ({ m, b, user }) => {
      const p = project(m[1]);
      need(p, 404, 'Not found.');
      ai();
      const text = String(b?.text ?? '').toLowerCase(), q = new URLSearchParams({ project: p.key, view: 'board' });
      if (/\bbugs?\b/.test(text)) q.set('type', 'BUG');
      if (/\b(my|mine|me)\b/.test(text)) q.set('assignee', user);
      if (/\b(high|urgent)\b/.test(text)) q.set('priority', 'HIGH');
      if (/\b(this|current|active) sprint\b/.test(text)) q.set('sprint', 'active');
      return { url: `/project?${q}`, unmatched: [...q.keys()].length > 2 ? [] : [b?.text ?? ''] };
    }],
    ['GET', /^\/api\/members\/$/, () => S.members],
    ['GET', /^\/api\/tags\/$/, ({ q }) => S.tags.filter((t) => !q.get('workspace') || same(t.workspace, q.get('workspace')))],
    ['GET', /^\/api\/sprints\/$/, ({ q }) => S.sprints.filter((s) => !q.get('project') || same(s.project, q.get('project'))).map(({ project: _, ...s }) => s)],
    ['GET', /^\/api\/issues\/$/, ({ q, base }) => {
      const any = (k, f) => { const vs = q.getAll(k); return !vs.length || vs.some(f); };
      let xs = S.issues.filter((i) =>
        (!q.get('project') || same(i.project, q.get('project'))) &&
        (!q.get('workspace') || same(project(i.project).workspace, q.get('workspace'))) &&
        any('assignee', (v) => (v === 'none' ? i.assignee == null : same(i.assignee, v))) &&
        any('reporter', (v) => same(i.reporter, v)) &&
        any('type', (v) => i.issue_type === v.toUpperCase()) &&
        any('priority', (v) => i.priority === v.toUpperCase()) &&
        any('sprint', (v) => (v === 'none' ? i.sprint == null : same(i.sprint, v))) &&
        any('tags', (v) => (v === 'none' ? !i.tags.length : i.tags.some((t) => same(t, v)))) &&
        (q.get('open') !== 'true' || status(i.status)?.category !== 'DONE') &&
        (q.get('planning') !== 'true' || S.sprints.find((s) => same(s.id, i.sprint))?.state !== 'CLOSED'));
      const order = q.get('ordering');
      if (order) {
        const k = order.replace(/^-/, ''), dir = order.startsWith('-') ? -1 : 1;
        xs = [...xs].sort((a, b) => (String(a[k] ?? '~') < String(b[k] ?? '~') ? -1 : String(a[k] ?? '~') > String(b[k] ?? '~') ? 1 : 0) * dir);
      }
      return paginate(xs.map(issueView), q, base, '/api/issues/');
    }],
    ['POST', /^\/api\/issues\/draft\/$/, ({ b }) => {
      const p = project(b?.project), text = String(b?.text ?? '').trim();
      need(p, 400, 'Invalid project.', { project: ['Choose a project.'] });
      need(text, 400, 'Nothing to draft from yet.');
      ai();
      const first = text.split('\n')[0].replace(/^[-*#\s]+/, '').trim();
      const bug = /\b(bug|error|fails?|crash\w*|broken)\b/i.test(text);
      return {
        title: (first[0].toUpperCase() + first.slice(1)).replace(/[.!]+$/, '').slice(0, 90),
        description: bug ? `## Steps to reproduce\n1. ${first}\n\n## Expected\nIt works.\n\n## Actual\n${text}` : `## Why\n${text}\n\n## Acceptance criteria\n- [ ] ${first}`,
        issue_type: bug ? 'BUG' : 'TASK', priority: /\b(urgent|asap|crash\w*|blocker)\b/i.test(text) ? 'HIGH' : 'MEDIUM',
        tags: S.tags.filter((t) => same(t.workspace, p.workspace) && new RegExp(`\\b${t.title}\\b`, 'i').test(text)).map((t) => t.id),
      };
    }],
    ['GET', /^\/api\/issues\/similar\/$/, ({ q }) => {
      const w = words(q.get('q') ?? '');
      return S.issues.filter((i) => same(i.project, q.get('project')) && status(i.status)?.category !== 'DONE' && [...words(i.title)].some((x) => w.has(x)))
        .map((i) => ({ id: i.id, key: i.key, title: i.title, status: status(i.status)?.name, category: status(i.status)?.category }));
    }],
    ['GET', /^\/api\/issues\/([^/]+)\/summary\/$/, ({ m, req }) => {
      const i = findIssue(m[1]);
      const comments = S.comments.filter((c) => c.issue === i.id);
      need(i.description.trim() || comments.length, 400, 'Nothing to summarize yet.');
      ai();
      const prev = S.summaries[i.id];
      if (!prev || /no-cache/i.test(req.headers['cache-control'] ?? '')) {
        const at = Math.max(Date.now(), prev ? Date.parse(prev.generated_at) + 1 : 0);
        S.summaries[i.id] = {
          text: `**${i.key}** ${i.title}\n\n- Status: ${status(i.status)?.name}\n- ${comments.length} comment(s)\n- Logged ${i.logged_minutes ?? 0}m of ${i.estimate_minutes ?? 0}m`,
          generated_at: new Date(at).toISOString(),
        };
      }
      return S.summaries[i.id];
    }],
    ['GET', /^\/api\/issues\/([^/]+)\/$/, ({ m, q }) => issueDetail(findIssue(m[1], q))],
    ['POST', /^\/api\/issues\/$/, ({ b, user }) => {
      const p = project(b?.project);
      need(p, 400, 'Invalid project.', { project: ['This field is required.'] });
      need(String(b?.title ?? '').trim(), 400, 'Invalid data.', { title: ['This field is required.'] });
      const number = Math.max(0, ...S.issues.filter((i) => i.project === p.id).map((i) => i.number)) + 1;
      const i = {
        id: crypto.randomUUID(), project: p.id, number, key: `${p.key}-${number}`, issue_type: 'TASK', priority: 'MEDIUM', title: '', parent: null,
        status: S.statuses.find((s) => s.project === p.id)?.id, sprint: null, reporter: user, assignee: null, tags: [], estimate_minutes: null,
        logged_minutes: 0, start_date: null, due_date: null, resolved_at: null, description: '', created_at: new Date().toISOString(),
      };
      applyIssue(i, { ...b, description: b.description ?? '' }, user);
      S.issues.push(i);
      return [201, issueDetail(i)];
    }],
    ['PATCH', /^\/api\/issues\/([^/]+)\/$/, ({ m, b, user }) => {
      const i = findIssue(m[1]);
      applyIssue(i, b ?? {}, user);
      return issueDetail(i);
    }],
    ['GET', /^\/api\/comments\/$/, ({ q }) => S.comments.filter((c) => !q.get('issue') || same(c.issue, q.get('issue')))],
    ['POST', /^\/api\/comments\/$/, ({ b, user }) => {
      const i = findIssue(String(b?.issue ?? ''));
      need(String(b?.body ?? '').trim(), 400, 'Invalid data.', { body: ['This field may not be blank.'] });
      const c = { id: crypto.randomUUID(), issue: i.id, author: user, body: b.body, created_at: new Date().toISOString() };
      S.comments.push(c);
      return [201, c];
    }],
    ['GET', /^\/api\/worklogs\/$/, ({ q }) => S.worklogs.filter((w) => !q.get('issue') || same(w.issue, q.get('issue')))],
    ['POST', /^\/api\/worklogs\/$/, ({ b, user }) => {
      const i = findIssue(String(b?.issue ?? ''));
      need(Number.isInteger(b?.minutes) && b.minutes > 0, 400, 'Invalid data.', { minutes: ['Ensure this value is greater than 0.'] });
      const w = { id: crypto.randomUUID(), issue: i.id, user, minutes: b.minutes, logged_on: b.logged_on || day(0), note: b.note ?? '' };
      S.worklogs.push(w);
      i.logged_minutes = (i.logged_minutes ?? 0) + w.minutes;
      return [201, w];
    }],
    ['POST', /^\/api\/attachments\/presign\/$/, ({ b, base }) => {
      need(b?.target_type === 'issues.issue', 400, 'Invalid target.', { target_type: ['Unsupported target.'] });
      findIssue(String(b.target_id ?? ''));
      need(b.name && b.size <= 20 * 1024 * 1024, 400, 'File is too large or has no name.');
      const key = `uploads/${crypto.randomUUID()}/${encodeURIComponent(b.name)}`;
      return { key, url: `${base}/_storage/${key}` };
    }],
    ['POST', /^\/api\/attachments\/$/, ({ b, user }) => {
      const i = findIssue(String(b?.target_id ?? ''));
      const f = S.storage[b?.key];
      need(f, 400, 'Upload the file before registering it.', { key: ['Unknown upload.'] });
      const a = { id: crypto.randomUUID(), issue: i.id, key: b.key, name: b.name, size: f.bytes.length, content_type: f.type, created_at: new Date().toISOString(), uploaded_by: user };
      S.attachments.push(a);
      return [201, attachment(a)];
    }],
    ['GET', /^\/api\/attachments\/([^/]+)\/url\/$/, ({ m, q, base }) => {
      const a = S.attachments.find((x) => x.id === m[1]);
      need(a, 404, 'Not found.');
      return { url: `${base}/_storage/${a.key}${q.get('download') ? '?download=1' : ''}` };
    }],
    ['DELETE', /^\/api\/attachments\/([^/]+)\/$/, ({ m }) => {
      const n = S.attachments.findIndex((x) => x.id === m[1]);
      need(n >= 0, 404, 'Not found.');
      S.attachments.splice(n, 1);
      return [204];
    }],
    ['GET', /^\/api\/activity\/users\/([^/]+)\/standup\/$/, ({ m, q }) => {
      ai();
      const mine = S.issues.filter((i) => same(i.assignee, m[1]) && (!q.get('workspace') || same(project(i.project).workspace, q.get('workspace'))));
      const line = (i) => `• ${i.key} ${i.title}`;
      const yesterday = S.worklogs.filter((w) => same(w.user, m[1]) && w.logged_on === day(-1)).map((w) => line(S.issues.find((i) => i.id === w.issue)));
      const doing = mine.filter((i) => status(i.status)?.category === 'IN_PROGRESS').map(line);
      return { text: `*Yesterday*\n${yesterday.join('\n') || '• Reviews'}\n\n*Today*\n${doing.join('\n') || '• Planning'}\n\n*Blockers*\n• None`, generated_at: new Date().toISOString() };
    }],
    ['GET', /^\/api\/reports\/people\/$/, ({ q }) => {
      const from = q.get('from') ?? '0000-00-00', to = q.get('to') ?? '9999-99-99';
      const inWs = (issueId) => { const i = S.issues.find((x) => x.id === issueId); return i && (!q.get('workspace') || same(project(i.project).workspace, q.get('workspace'))); };
      const users = q.get('user') ? [q.get('user')] : [...new Set(S.members.filter((x) => !q.get('workspace') || same(x.workspace, q.get('workspace'))).map((x) => x.user.id))];
      return users.map((u) => ({
        user: u,
        logged_minutes: S.worklogs.filter((w) => same(w.user, u) && w.logged_on >= from && w.logged_on <= to && inWs(w.issue)).reduce((a, w) => a + w.minutes, 0),
        issues_done: S.issues.filter((i) => same(i.assignee, u) && inWs(i.id) && i.resolved_at && i.resolved_at.slice(0, 10) >= from && i.resolved_at.slice(0, 10) <= to).length,
      }));
    }],
  ];

  // ---------- server ----------
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body);
  };
  const fail = (res, status, message, errors = {}) => send(res, status, { success: false, message, status_code: status, errors });
  const reset = () => {
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, fixture());
    log.length = 0;
  };

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams;
    const base = `http://${req.headers.host}`;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,Cache-Control' });
      return res.end();
    }
    // ----- control + storage (no auth) -----
    if (p === '/_log') return send(res, 200, log);
    if (p === '/_reset' && req.method === 'POST') return reset(), send(res, 200, { reset: true });
    if (p === '/_busy' && req.method === 'POST') return (state.busy = true), send(res, 200, { busy: true });
    if (p === '/_fixtures/commits') return send(res, 200, fixtureCommits());
    if (p.startsWith('/_storage/')) {
      const key = p.slice('/_storage/'.length);
      if (req.method === 'PUT') return (state.storage[key] = { type: req.headers['content-type'] || 'application/octet-stream', bytes: raw }), send(res, 200, undefined, 'text/plain');
      const f = state.storage[key];
      if (!f) return send(res, 404, 'NoSuchKey', 'text/plain');
      if (q.get('download')) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(decodeURIComponent(key))}"`);
      return send(res, 200, f.bytes, f.type);
    }
    // ----- the API -----
    if (p.startsWith('/api/') || p.startsWith('/auth/')) {
      let b = null;
      try { b = raw.length ? JSON.parse(raw) : null; } catch { return fail(res, 400, 'JSON parse error.'); }
      const query = {};
      for (const [k, v] of q) query[k] = k in query ? [].concat(query[k], v) : v;
      log.push({ method: req.method, path: p, query, body: b });
      try {
        const r = routes.find(([m, rx]) => m === req.method && rx.test(p));
        if (!r) return fail(res, 404, 'Not found.');
        let user = null;
        if (!(p.startsWith('/auth/token'))) {
          const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
          need(auth, 401, 'Authentication credentials were not provided.');
          user = state.tokens[auth[1]];
          need(user, 401, 'Given token not valid for any token type');
        }
        // state.slowList: milliseconds to hold every ticket list, to test what shows while a reload is under way.
        if (state.slowList && req.method === 'GET' && p === '/api/issues/') await new Promise((r) => setTimeout(r, state.slowList));
        const out = await r[2]({ m: p.match(r[1]), q, b, user, base, req });
        const [status, data] = Array.isArray(out) && typeof out[0] === 'number' ? out : [200, out];
        return status === 204 ? send(res, 204) : send(res, status, { success: true, data });
      } catch (e) {
        if (e instanceof HttpError) return fail(res, e.status, e.message, e.errors);
        return fail(res, 500, e.stack);
      }
    }
    // ----- static files from the repo root (the board preview) -----
    if (p === '/favicon.ico') return send(res, 204);
    const file = path.join(ROOT, decodeURIComponent(p));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream');
  }

  const server = http.createServer((req, res) => handle(req, res).catch((e) => fail(res, 500, e.message)));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, state, log, reset,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  })));
}

// A git repo whose origin looks like CodeCommit but pushes to a local bare repo. Fetches and pulls from the
// fake URL fail instantly (dead proxy, https disabled), so nothing ever reaches the network.
export function makeRepo(dir) {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim();
  const old = new Date(Date.now() - 2 * 864e5).toISOString(); // the initial commit is from before "today"
  let env = { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old };
  const bare = path.join(dir, 'remote.git'), repo = path.join(dir, 'app');
  fs.mkdirSync(repo, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'master', bare);
  git(repo, 'init', '-q', '-b', 'master');
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['http.proxy', 'http://127.0.0.1:9'], ['protocol.https.allow', 'never']])
    git(repo, 'config', k, v);
  git(repo, 'remote', 'add', 'origin', 'https://git-codecommit.ap-south-1.amazonaws.com/v1/repos/TEST');
  git(repo, 'config', 'remote.origin.pushurl', bare);
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  env = {};
  git(repo, 'push', '-q', 'origin', 'master');
  git(repo, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
  return { repo, bare, git: (...a) => git(repo, ...a) };
}

// Run directly (not when a bare `node --test` picks this file up as a test).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && !process.env.NODE_TEST_CONTEXT) {
  const mock = await startMockApi({ port: Number(process.argv[2] ?? 8765) });
  const local = mock.url.replace('127.0.0.1', 'localhost');
  console.log(`Mock PM API on ${local} (users: sam, ana, kai, nia; password "${PASSWORD}")`);
  console.log(`Board preview: ${local}/dev/preview.html#view=board&project=OG   (hash: view, project, open=KEY, plan, standup, light, since, side)`);
}
