// The ajwain CLI as a child process against the mock API, with its config in a temp dir (never ~/.config).
// Commands not in `ajwain --help` yet are marked todo, so they turn into real tests once cli.mjs has them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { startMockApi, makeRepo } from './mock-api.mjs';
import { ticketQuality, TEMPLATES } from '../pm.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'cli.mjs');
const HELP = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
const todo = (cmd) => !new RegExp(`^\\s+ajwain ${cmd}\\b`, 'm').test(HELP) && `"ajwain ${cmd}" is not in cli.mjs yet`;

let mock, tmp, env;
before(async () => {
  mock = await startMockApi();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ajwain-cli-')));
  fs.mkdirSync(path.join(tmp, 'home'));
  env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AJWAIN_')));
  Object.assign(env, { AJWAIN_API: mock.url, AJWAIN_APP: 'https://pm.example.com', AJWAIN_PASSWORD: 'secret', XDG_CONFIG_HOME: path.join(tmp, 'config'), HOME: path.join(tmp, 'home'), GIT_CONFIG_NOSYSTEM: '1' });
  const r = await cli(['login', 'sam']);
  assert.equal(r.code, 0, r.err);
});
after(async () => {
  await mock?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// Runs `node cli.mjs ...args`; resolves {code, out, err, json} (json: stdout parsed, when it is JSON).
// With --raw (JSON) unless `pretty` asks for the readable layout people see.
function cli(args, { input = '', env: extra = {}, cwd = tmp, pretty = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, ...(pretty ? [] : ['--raw'])], { cwd, env: { ...env, ...extra } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      let json;
      try { json = JSON.parse(out); } catch {}
      resolve({ code, out, err, json });
    });
    p.stdin.end(input);
  });
}
async function ok(args, opts) {
  const r = await cli(args, opts);
  assert.equal(r.code, 0, `ajwain ${args.join(' ')} failed: ${r.err}`);
  return r.json ?? r.out;
}
const config = (f) => path.join(tmp, 'config', 'ajwain', f);
const issue = (key) => mock.state.issues.find((i) => i.key === key);
const project = (key) => mock.state.projects.find((p) => p.key === key);
const status = (key) => mock.state.statuses.find((s) => s.id === issue(key).status);
const last = (method, p) => mock.log.filter((l) => l.method === method && l.path === p).at(-1);
const myOpen = (filter) => mock.state.issues
  .filter((i) => i.assignee === mock.state.me && mock.state.statuses.find((s) => s.id === i.status).category !== 'DONE' && filter(i))
  .map((i) => i.key).sort();
const inWs = (n) => (i) => mock.state.projects.find((p) => p.id === i.project).workspace === mock.state.workspaces[n].id;

test('login: wrong password fails; the tokens file is private', async () => {
  const bad = await cli(['login', 'sam'], { env: { AJWAIN_PASSWORD: 'nope' } });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /No active account found/);
  assert.deepEqual(await ok(['login', 'sam']), { signed_in: 'sam' });
  const t = JSON.parse(fs.readFileSync(config('tokens.json'), 'utf8'));
  assert.ok(t.access && t.refresh);
  assert.equal(fs.statSync(config('tokens.json')).mode & 0o777, 0o600);
});

test('an expired access token is refreshed transparently', async () => {
  const t = JSON.parse(fs.readFileSync(config('tokens.json'), 'utf8'));
  fs.writeFileSync(config('tokens.json'), JSON.stringify({ ...t, access: 'expired' }));
  assert.equal((await ok(['me'])).username, 'sam');
  const now = JSON.parse(fs.readFileSync(config('tokens.json'), 'utf8'));
  assert.notEqual(now.access, 'expired');
  assert.equal(now.refresh, t.refresh);
});

test('me, workspaces, projects (AJWAIN_WORKSPACE picks another), statuses', async () => {
  const me = await ok(['me']);
  assert.deepEqual([me.id, me.username, me.ai_enabled], [mock.state.me, 'sam', true]);
  assert.deepEqual(await ok(['workspaces']), mock.state.workspaces);
  const [w1, w2] = mock.state.workspaces;
  assert.deepEqual((await ok(['projects'])).map((p) => p.key), mock.state.projects.filter((p) => p.workspace === w1.id).map((p) => p.key));
  assert.deepEqual(await ok(['projects'], { env: { AJWAIN_WORKSPACE: w2.id } }), [{ key: 'HOME', name: 'Home', id: project('HOME').id }]);
  assert.deepEqual(await ok(['statuses', 'OG']), mock.state.statuses.filter((s) => s.project === project('OG').id).map(({ name, category }) => ({ name, category })));
  assert.equal((await cli(['statuses', 'NOPE'])).code, 1);
});

test('mine: my open tickets, scoped by scope.json unless --all', async () => {
  fs.rmSync(config('scope.json'), { force: true });
  const all = await ok(['mine']);
  assert.deepEqual(all.map((i) => i.key).sort(), myOpen(inWs(0)));
  assert.deepEqual(Object.keys(all[0]), ['key', 'title', 'type', 'priority', 'status', 'estimate', 'logged', 'due', 'url']);
  const [w1] = mock.state.workspaces, og = project('OG');
  fs.writeFileSync(config('scope.json'), JSON.stringify({ workspace: w1.id, project: og.id }));
  assert.deepEqual((await ok(['mine'])).map((i) => i.key).sort(), myOpen((i) => i.project === og.id));
  assert.deepEqual((await ok(['mine', '--all'])).map((i) => i.key).sort(), myOpen(inWs(0)));
});

test('show: one ticket with its branch and description', async () => {
  const s = await ok(['show', 'OG-1730']);
  assert.deepEqual([s.key, s.title, s.type, s.status, s.estimate, s.logged], ['OG-1730', issue('OG-1730').title, 'TASK', 'In Progress', '4h', '2h']);
  assert.equal(s.branch, 'feat/OG-1730-add-retry-with-backoff-to-webhook');
  assert.equal(s.description, issue('OG-1730').description);
  assert.equal(s.url, 'https://pm.example.com/issues/OG-1730');
  const missing = await cli(['show', 'OG-9999']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /Not found/);
});

let created;
test('create: fields from flags, the description from stdin, assigned to me in the first status', async () => {
  const desc = '## Why\nExports time out for big boards.\n\n## Acceptance criteria\n- [ ] CSV under 5s';
  const c = await ok(['create', 'OG', 'Export board as CSV', '--type', 'bug', '--priority', 'high', '--estimate', '2h', '--due', '2026-12-01', '--desc', '-'], { input: desc });
  created = c.key;
  assert.match(created, /^OG-\d+$/);
  assert.deepEqual([c.title, c.type, c.priority, c.status, c.estimate, c.due], ['Export board as CSV', 'BUG', 'HIGH', 'To Do', '2h', '2026-12-01']);
  const { body } = last('POST', '/api/issues/');
  assert.deepEqual(body, {
    project: project('OG').id, title: 'Export board as CSV', issue_type: 'BUG', priority: 'HIGH', status: mock.state.statuses.find((s) => s.project === project('OG').id).id,
    estimate_minutes: 120, due_date: '2026-12-01', description: desc, assignee: mock.state.me,
  });
  const bad = await cli(['create', 'OG', 'x', '--type', 'chore']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /must be one of/);
});

test('update, status (by name and by category), log, comment', async () => {
  const u = await ok(['update', created, '--title', 'Export the board as CSV', '--due', '']);
  assert.equal(u.title, 'Export the board as CSV');
  assert.deepEqual(last('PATCH', `/api/issues/${issue(created).id}/`).body, { title: 'Export the board as CSV', due_date: null });

  assert.equal((await ok(['status', created, 'in progress'])).status, 'In Progress');
  assert.equal((await ok(['status', created, 'DONE'])).status, 'Done');
  assert.equal(status(created).category, 'DONE');
  const bad = await cli(['status', created, 'Shipped']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /To Do, In Progress, To be Tested, Done/);

  assert.deepEqual(await ok(['log', created, '1h30m', 'API', 'wiring']), { logged: '1h 30m', on: created });
  assert.deepEqual(last('POST', '/api/worklogs/').body, { issue: issue(created).id, minutes: 90, logged_on: new Date().toLocaleDateString('en-CA'), note: 'API wiring' });
  assert.equal(issue(created).logged_minutes, 90);

  assert.deepEqual(await ok(['comment', created, 'Shipped behind a flag']), { commented: created });
  assert.deepEqual(last('POST', '/api/comments/').body, { issue: issue(created).id, body: 'Shipped behind a flag' });
  await ok(['comment', created, '-'], { input: 'From **stdin**' });
  assert.equal(last('POST', '/api/comments/').body.body, 'From **stdin**');
});

test('branch: AJWAIN_BRANCH_TEMPLATE', async () => {
  assert.equal((await ok(['branch', 'OG-1731'])).trim(), 'fix/OG-1731-login-fails-on-safari-when-2fa-is');
  assert.equal((await ok(['branch', 'OG-1731'], { env: { AJWAIN_BRANCH_TEMPLATE: '{key}-{slug}' } })).trim(), 'OG-1731-login-fails-on-safari-when-2fa-is');
});

test('start --worktree: a sibling worktree on the ticket branch, assigned to me, In Progress', async () => {
  const { repo, git } = makeRepo(path.join(tmp, 'git'));
  const r = await ok(['start', 'OG-1734', '--worktree'], { cwd: repo, env: { AJWAIN_BRANCH_TEMPLATE: '{key}-{slug}' } });
  const branch = 'OG-1734-holiday-calendar-ignores-timezone';
  assert.deepEqual(r, { branch, path: `${repo}-OG-1734`, key: 'OG-1734', status: 'started' });
  assert.equal(execFileSync('git', ['-C', r.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), branch);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'master', 'the main checkout stays put');
  assert.equal(issue('OG-1734').assignee, mock.state.me);
  assert.equal(status('OG-1734').name, 'In Progress');
});

test('start where the server wants an estimate first: fails before any branch, and says how to carry on', async () => {
  const { repo, git } = makeRepo(path.join(tmp, 'git-estimate'));
  mock.state.estimateFirst = true;
  try {
    const env = { AJWAIN_BRANCH_TEMPLATE: '{key}-{slug}' };
    assert.equal(issue('OG-1739').estimate_minutes, null);
    const r = await cli(['start', 'OG-1739'], { cwd: repo, env });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /add an estimate first.*ajwain update OG-1739 --estimate/s);
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'master', 'no branch was made');
    assert.equal(status('OG-1739').name, 'To Do');
    await ok(['update', 'OG-1739', '--estimate', '3h']);
    const done = await ok(['start', 'OG-1739'], { cwd: repo, env });
    assert.equal(done.status, 'started');
    assert.equal(status('OG-1739').name, 'In Progress');
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), done.branch);
  } finally {
    mock.state.estimateFirst = false;
  }
});

test('scope: what VS Code chose', { todo: todo('scope') }, async () => {
  const og = project('OG');
  fs.writeFileSync(config('scope.json'), JSON.stringify({ workspace: og.workspace, project: og.id }));
  const s = await ok(['scope']);
  assert.deepEqual([s.workspace, s.project], [og.workspace, og.id]);
});

test('draft: notes become a ticket draft', { todo: todo('draft') }, async () => {
  const d = await ok(['draft', 'OG', 'Webhook api crashes when the payload is over 1 MB']);
  assert.deepEqual(Object.keys(d).sort(), ['description', 'issue_type', 'priority', 'tags', 'title']);
  assert.equal(d.issue_type, 'BUG');
  assert.deepEqual(last('POST', '/api/issues/draft/').body, { project: project('OG').id, text: 'Webhook api crashes when the payload is over 1 MB' });
});

test('draft --create: from stdin, created with the drafted fields and tags', { todo: todo('draft') }, async () => {
  const before = mock.state.issues.length;
  const c = await ok(['draft', 'OG', '-', '--create'], { input: 'Add an api to export sprint reports as PDF\nCustomers ask for it every week.' });
  assert.match(c.key, /^OG-\d+$/);
  assert.equal(mock.state.issues.length, before + 1);
  const { body } = last('POST', '/api/issues/');
  assert.equal(body.title, 'Add an api to export sprint reports as PDF');
  assert.match(body.description, /Customers ask for it/);
  assert.deepEqual(body.tags, [mock.state.tags.find((t) => t.title === 'api').id]);
  assert.equal(body.assignee, mock.state.me);
});

test('similar: open tickets that look like the text', { todo: todo('similar') }, async () => {
  const s = await ok(['similar', 'OG', 'webhook delivery retry']);
  assert.ok(s.some((x) => x.key === 'OG-1730' && x.title === issue('OG-1730').title), JSON.stringify(s));
  assert.deepEqual(await ok(['similar', 'OG', 'zzzz qqqq']), []);
});

test('similar: each match shows its status', async () => {
  const [s] = await ok(['similar', 'OG', 'webhook delivery retry']);
  assert.equal(s.status, 'In Progress');
});

test('summary: AI summary, cached until --fresh; 400 and 429 are reported', { todo: todo('summary') }, async () => {
  const a = await ok(['summary', 'OG-1730']);
  assert.equal(a.key, 'OG-1730');
  assert.ok(a.text.length > 10 && a.generated_at);
  assert.equal((await ok(['summary', 'OG-1730'])).generated_at, a.generated_at);
  assert.notEqual((await ok(['summary', 'OG-1730', '--fresh'])).generated_at, a.generated_at);
  const empty = await cli(['summary', 'OG-1739']);
  assert.equal(empty.code, 1);
  assert.match(empty.err, /Nothing to summarize/);
  await fetch(`${mock.url}/_busy`, { method: 'POST' });
  const busy = await cli(['summary', 'OG-1730']);
  assert.equal(busy.code, 1);
  assert.match(busy.err, /busy/i);
});

test('standup: plain text from the AI; my queue when it is busy', { todo: todo('standup') }, async () => {
  const s = await ok(['standup']);
  assert.equal(typeof s, 'string');
  assert.throws(() => JSON.parse(s));
  assert.match(s, /OG-1730/);
  await fetch(`${mock.url}/_busy`, { method: 'POST' });
  const r = await cli(['standup']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /busy/i);
  assert.match(r.out, /OG-1730/);
});

test('quality: the ticket health checklist', { todo: todo('quality') }, async () => {
  const q = await ok(['quality', 'OG-1730']);
  const expected = ticketQuality(issue('OG-1730'));
  assert.equal(q.score, expected.score);
  assert.deepEqual(q.checks.map((c) => [c.id, c.ok]), expected.checks.map((c) => [c.id, c.ok]));
  for (const c of q.checks) assert.ok(c.label && c.hint, JSON.stringify(c));
  assert.equal((await ok(['quality', '--title', 'Fix', '--type', 'BUG'])).score, 0);
});

test('template: the description skeleton for a type', { todo: todo('template') }, async () => {
  assert.equal(await ok(['template', 'BUG']), `${TEMPLATES.BUG}\n`);
});

test('attach and attachments: upload through presign + storage, list with download links', { todo: todo('attach') || todo('attachments') }, async () => {
  const png = path.join(tmp, 'shot.png'), log = path.join(tmp, 'server.log');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  fs.writeFileSync(log, 'line 1\nline 2\n');
  const up = await ok(['attach', 'OG-1731', png, log]);
  assert.deepEqual(up.map((a) => [a.name, a.size]), [['shot.png', '7 B'], ['server.log', '14 B']]);
  assert.ok(up.every((a) => a.id));
  const list = await ok(['attachments', 'OG-1731']);
  assert.deepEqual(list.map((a) => a.name), ['safari.txt', 'shot.png', 'server.log']);
  const shot = list.find((a) => a.name === 'shot.png');
  const res = await fetch(shot.url);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(png));
  const missing = await cli(['attach', 'OG-1731', path.join(tmp, 'nope.png')]);
  assert.equal(missing.code, 1);
});

test('comments: the discussion with author names', { todo: todo('comments') }, async () => {
  const cs = await ok(['comments', 'OG-1730']);
  assert.deepEqual(cs.map((c) => [c.author, c.body]), [['Ana Ruiz', 'Can we also cap the retry window at **1 minute**?']]);
  assert.ok(cs[0].created_at);
});

test('no server set: commands say how to set one; login --server remembers it', async () => {
  const bare = { AJWAIN_API: '', AJWAIN_APP: '', XDG_CONFIG_HOME: path.join(tmp, 'fresh-config') };
  const lost = await cli(['mine'], { env: bare });
  assert.equal(lost.code, 1);
  assert.match(lost.err, /No server address set: run `ajwain login --server/);
  assert.match((await cli(['login', 'sam', '--server', 'pm.example.com'], { env: bare })).err, /starting with https/);
  assert.deepEqual(await ok(['login', 'sam', '--server', `${mock.url}/`], { env: bare }), { signed_in: 'sam' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'fresh-config', 'ajwain', 'server.json'), 'utf8')), { api: mock.url, app: '' });
  const s = await ok(['show', 'OG-1730'], { env: bare });
  assert.deepEqual([s.key, s.url], ['OG-1730', null], 'works from the saved address; no web app known, so no link');
});

test('readable by default: tables, ticket pages and confirmations; --raw is the JSON; no colour codes when piped', async () => {
  const human = async (args) => {
    const r = await cli(args, { pretty: true, env: { COLUMNS: '120' } });
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /\x1b\[/, 'no colour codes when the output is not a terminal');
    return r.out;
  };
  const mine = await human(['mine', '--all']);
  const [head, ...rows] = mine.trim().split('\n');
  assert.match(head, /^KEY\s+TYPE\s+STATUS\s+PRIORITY\s+TIME\s+DUE\s+TITLE$/);
  assert.match(mine, /^OG-1730\s+Task\s+In Progress\s+↑ High\s+\S+\s+\w+ \d+\s+Add retry with backoff to webhook delivery$/m);
  assert.match(rows.at(-1), /^\d+ open tickets?$/);
  assert.throws(() => JSON.parse(mine));

  const show = await human(['show', 'OG-1730']);
  assert.match(show, /^OG-1730  Add retry with backoff to webhook delivery\n─+\nTask · ↑ High · In Progress · /);
  assert.match(show, /^health {3}100%$/m);
  assert.match(show, /^branch {3}feat\/OG-1730-/m);
  assert.match(show, /^ {2}Acceptance criteria\n {2}☑ Retries up to 3 times\n {2}☐ Final failure/m, 'headings and checklists, indented');
  assert.match(show, /down for a few seconds\./, 'inline **bold** without the stars');

  assert.match(await human(['log', 'OG-1731', '15m', 'pairing']), /^✓ Logged 15m on OG-1731\n$/);
  assert.match(await human(['create', 'OG', 'Readable output check', '--estimate', '1h']), /^✓ Created OG-\d+ {2}Readable output check\n {2}Task · = Medium · To Do · 0m of 1h\n/);
  assert.match(await human(['quality', 'OG-1730']), /^OG-1730 {2}health █+░* 100%\n {2}✓ /);
  assert.match(await human(['similar', 'OG', 'retry', 'webhook']), /^KEY\s+STATUS\s+TITLE\nOG-1730/);
  assert.equal(await human(['branch', 'OG-1730']), await ok(['branch', 'OG-1730']), 'plain-text commands print the same either way');
  // --raw: exactly the JSON the scripts and the skill read.
  assert.deepEqual((await ok(['mine', '--all'])).map((i) => i.key).sort(), myOpen(inWs(0)));
});

test('logout: signed out, and commands say how to sign in again', async () => {
  assert.deepEqual(await ok(['logout']), { signed_out: true });
  assert.equal(fs.existsSync(config('tokens.json')), false);
  const r = await cli(['me']);
  assert.equal(r.code, 1);
  assert.match(r.err, /run: ajwain login/);
});

test('no attendance from the command line: punching is for a person, in VS Code', async () => {
  for (const c of ['punch', 'punch-in', 'checkin', 'check-out', 'attendance', 'zoho', 'clockout']) {
    const r = await cli([c, 'in']);
    assert.equal(r.code, 2, c);
    assert.match(r.err, /attendance \(Zoho People\) is not available from the command line, by design/);
  }
});

test('unknown command prints help and fails', async () => {
  const r = await cli(['frobnicate']);
  assert.equal(r.code, 1);
  assert.match(r.out, /ajwain: Ajwain CLI/);
});
