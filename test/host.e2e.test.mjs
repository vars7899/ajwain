// The real extension.js, activated against a stub `vscode` (test/vscode-stub.cjs) and the mock API, driven through its
// command registry. One extension instance; the tests run in order like a user's session: sign in, scope, board,
// start work, timer, pull request, finish, Claude, ticket from a TODO. Git work happens in a temp repo whose
// "CodeCommit" remote pushes to a local bare repo; aws and claude are fake scripts first on PATH. HOME and
// XDG_CONFIG_HOME point at a temp dir, so nothing touches the network, ~/.config or your git config.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startMockApi, makeRepo } from './mock-api.mjs';
import { branchName } from '../pm.mjs';

const require = createRequire(import.meta.url);
const { createVscode, install } = require('./vscode-stub.cjs');
const ROOT = path.resolve(import.meta.dirname, '..');

let mock, vs, ctx, tmp, repo, uninstall, awsLog, claudeBin;
const envBefore = {};

before(async () => {
  mock = await startMockApi();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ajwain-host-')));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(tmp, 'home'));
  const script = (name, body) => (fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 }), path.join(bin, name));
  awsLog = path.join(tmp, 'aws.log');
  script('aws', `require('fs').appendFileSync(${JSON.stringify(awsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({ pullRequest: { pullRequestId: '77' } }));`);
  claudeBin = script('claude', 'process.exit(0);');
  const env = { XDG_CONFIG_HOME: path.join(tmp, 'config'), HOME: path.join(tmp, 'home'), PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: '1' };
  for (const [k, v] of Object.entries(env)) [envBefore[k], process.env[k]] = [process.env[k], v];
  repo = makeRepo(tmp);

  vs = createVscode({
    settings: {
      'ajwain.apiUrl': mock.url, 'ajwain.appUrl': 'https://pm.example.com', 'ajwain.reminders.schedule': [], 'ajwain.branchTemplate': '{key}-{slug}',
      'ajwain.startWorkIn': 'branch', 'ajwain.timer.autoStart': true, 'ajwain.claude.path': claudeBin,
    },
  });
  uninstall = install(vs);
  ctx = vs.context({ root: ROOT, storage: path.join(tmp, 'storage') });
  // Timers the extension starts while activating (scheduler, status bar ticks) must not keep this process alive.
  const timers = { setTimeout, setInterval };
  globalThis.setTimeout = (...a) => timers.setTimeout(...a).unref();
  globalThis.setInterval = (...a) => timers.setInterval(...a).unref();
  try {
    await require('../extension.js').activate(ctx);
  } finally {
    Object.assign(globalThis, timers);
  }
});

after(async () => {
  for (const d of ctx?.subscriptions ?? []) d?.dispose?.();
  uninstall?.();
  for (const [k, v] of Object.entries(envBefore)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  await mock?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- helpers ----------
const ask = (...answers) => vs.answers.push(...answers);
// Runs a command like the palette does; it must not show an error and must use exactly the scripted answers.
async function run(name, ...args) {
  const seen = vs.messages.length;
  await vs.api.commands.executeCommand(name, ...args);
  assert.deepEqual(vs.messages.slice(seen).filter((m) => m.level === 'error').map((m) => m.msg), [], `${name} showed an error`);
  assert.deepEqual(vs.answers, [], `${name} left scripted answers unused`);
}
const issue = (key) => mock.state.issues.find((i) => i.key === key);
const project = (key) => mock.state.projects.find((p) => p.key === key);
const statusOf = (key) => mock.state.statuses.find((s) => s.id === issue(key).status);
const writes = (method, p) => mock.log.filter((l) => l.method === method && l.path === p);
const scopeFile = () => JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'ajwain', 'scope.json'), 'utf8'));
const tree = () => vs.trees['ajwain.issues'];
const board = () => vs.panels.find((p) => p.viewType === 'ajwain.board');
const [W1, W2] = [0, 1].map((n) => () => mock.state.workspaces[n].id);
const myOpen = (filter = () => true) => mock.state.issues
  .filter((i) => i.assignee === mock.state.me && mock.state.statuses.find((s) => s.id === i.status).category !== 'DONE' && filter(i))
  .map((i) => i.key).sort();
const today = () => new Date().toLocaleDateString('en-CA');

// ---------- tests ----------
test('the stub implements every vscode API extension.js uses', () => {
  const src = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
  const used = [...new Set(src.match(/(?<!['"\w])vscode(\.[A-Za-z]+){1,2}/g))]; // namespace.member; deeper parts are runtime values
  const missing = used.filter((p) => {
    let o = vs.api;
    for (const k of p.split('.').slice(1)) {
      if (o == null || !(k in Object(o))) return true;
      o = o[k];
    }
    return false;
  });
  assert.deepEqual(missing, [], 'add these to test/vscode-stub.cjs');
});

test('activation: signed out, scope.json written, commands registered', () => {
  assert.deepEqual(vs.executed.find((e) => e.name === 'setContext')?.args, ['ajwain.signedIn', false]);
  assert.deepEqual(scopeFile(), { workspace: null, project: null });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !vs.api.commands.registry.has(c));
  assert.deepEqual(missing, [], 'commands in package.json without a handler');
});

test('sign in: the sidebar lists my open issues in the workspace, grouped by status', async () => {
  ask('sam', 'secret');
  await run('ajwain.signIn');
  assert.deepEqual(vs.executed.filter((e) => e.name === 'setContext').at(-1).args, ['ajwain.signedIn', true]);
  assert.ok(JSON.parse(await ctx.secrets.get('ajwain.tokens')).access, 'tokens are in the secret store');

  ask('Acme');
  await run('ajwain.pickWorkspace');
  assert.deepEqual(scopeFile(), { workspace: W1(), project: null });

  const groups = await tree().treeDataProvider.getChildren();
  const inW1 = (i) => mock.state.projects.find((p) => p.id === i.project).workspace === W1();
  assert.deepEqual(groups.flatMap((g) => g.issues.map((i) => i.key)).sort(), myOpen(inW1));
  for (const g of groups) for (const i of g.issues) assert.equal(i.status_detail.name, g.group);
  assert.equal(tree().description, 'All projects');
  const [g] = groups;
  assert.equal(tree().treeDataProvider.getTreeItem(g).label, g.group);
  const item = tree().treeDataProvider.getTreeItem(g.issues[0]);
  assert.ok(item.label.startsWith(g.issues[0].key));
  assert.deepEqual(item.command, { command: 'ajwain.openBoard', title: 'Open', arguments: [g.issues[0].key] });
});

test('scope: picking a project re-scopes the sidebar and writes scope.json for the CLI', async () => {
  ask('OG · Platform');
  await run('ajwain.pickProject');
  const og = project('OG');
  assert.deepEqual(scopeFile(), { workspace: W1(), project: og.id });
  const groups = await tree().treeDataProvider.getChildren();
  assert.deepEqual(groups.flatMap((g) => g.issues.map((i) => i.key)).sort(), myOpen((i) => i.project === og.id));
  assert.equal(tree().description, og.name);
});

test('board: the webview calls the host API; scope changes anywhere reach it', async () => {
  await run('ajwain.openBoard');
  const panel = board();
  assert.match(panel.webview.html, /board\.js/);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  const og = project('OG'), esg = project('ESG');

  const init = await panel.call('init');
  assert.equal(init.me.username, 'sam');
  assert.deepEqual([init.workspace, init.project, init.timer, init.startWorkIn], [W1(), og.id, null, 'branch']);

  const page = await panel.call('req', `/api/issues/?project=${og.id}&page_size=5`, null);
  assert.equal(page.count, mock.state.issues.filter((i) => i.project === og.id).length);
  assert.equal(page.results.length, 5);
  assert.ok(page.next, 'paginated');
  await assert.rejects(panel.call('req', 'https://example.com/steal', null), /Bad path/);
  await assert.rejects(panel.call('req', '/api/issues/NOPE-1/', null), /Not found/);
  const { id } = issue('OG-1739');
  await panel.call('req', `/api/issues/${id}/`, { method: 'PATCH', body: { priority: 'LOW' } });
  assert.deepEqual(writes('PATCH', `/api/issues/${id}/`).at(-1).body, { priority: 'LOW' });
  assert.equal(issue('OG-1739').priority, 'LOW');

  await panel.call('save', { view: 'list', filters: { sprint: ['active'] } });
  assert.deepEqual(ctx.globalState.get('ajwain.boardState')[W1()], { view: 'list', filters: { sprint: ['active'] } });
  assert.deepEqual(await panel.call('workspaces'), { list: mock.state.workspaces, current: W1() });

  // From the command palette, from the settings UI (another window), and a workspace switch.
  let seen = panel.outbox.length;
  ask('ESG · Reporting');
  await run('ajwain.pickProject');
  assert.deepEqual(panel.outbox.slice(seen).filter((m) => m.type === 'scope'), [{ type: 'scope', project: esg.id }]);
  seen = panel.outbox.length;
  await vs.api.workspace.getConfiguration('ajwain').update('project', og.id, vs.api.ConfigurationTarget.Global);
  assert.deepEqual(panel.outbox.slice(seen).filter((m) => m.type === 'scope'), [{ type: 'scope', project: og.id }]);
  assert.equal(scopeFile().project, og.id);
  seen = panel.outbox.length;
  ask('Personal');
  await run('ajwain.pickWorkspace');
  assert.ok(panel.outbox.slice(seen).some((m) => m.type === 'reinit'), 'reinit after a workspace switch');
  assert.deepEqual(scopeFile(), { workspace: W2(), project: null });
  assert.deepEqual((await panel.call('init')).workspace, W2());

  // Back to OG for the rest of the session, through the board's own setScope.
  await panel.call('setScope', { workspace: W1(), project: '' });
  await panel.call('setScope', { project: og.id });
  assert.deepEqual(scopeFile(), { workspace: W1(), project: og.id });
});

test("sidebar Home view: the board's host API plus opening the board, New issue and a ticket's menu; it hears the scope", async () => {
  const view = vs.resolveView('ajwain.home');
  assert.match(view.webview.html, /side\.js/);
  assert.match(view.webview.html, /side\.css/);
  assert.match(view.webview.html, /Content-Security-Policy/);
  assert.equal(view.webview.options.enableScripts, true);
  const og = project('OG');
  const init = await view.call('init');
  assert.equal(init.me.username, 'sam');
  assert.deepEqual([init.workspace, init.project, init.timer], [W1(), og.id, null]);
  await assert.rejects(view.call('save', {}), /No host method "save"/);

  await view.call('openBoard', { view: 'sprints' });
  assert.deepEqual(board().outbox.filter((m) => m.type === 'intent').at(-1).intent, { view: 'sprints' });
  let shown;
  ask((items) => { shown = items.map((x) => x.label); });
  await view.call('actions', { key: 'OG-1730' });
  assert.ok(shown.some((l) => /Change status/.test(l)) && shown.some((l) => /Open pull request/.test(l)), shown?.join());

  const seen = view.outbox.length;
  ask('ESG · Reporting');
  await run('ajwain.pickProject');
  assert.deepEqual(view.outbox.slice(seen).filter((m) => m.type === 'scope'), [{ type: 'scope', project: project('ESG').id }]);
  await view.call('setScope', { project: og.id });
  assert.equal(scopeFile().project, og.id);
});

test('staying current: coming back to VS Code or to the board wakes both webviews; the board\'s changes reach the sidebar', async () => {
  const view = vs.panels.find((p) => p.viewType === 'ajwain.home'), panel = board();
  const wakes = (p) => p.outbox.filter((m) => m.type === 'wake').length;
  const before = [wakes(panel), wakes(view)];
  vs.focusWindow(false);
  vs.focusWindow(true);
  assert.deepEqual([wakes(panel), wakes(view)], [before[0] + 1, before[1] + 1], 'refocusing the window wakes both');
  panel.show(false);
  panel.show(true);
  assert.equal(wakes(panel), before[0] + 2, 'showing the board tab again wakes it');
  const refreshes = view.outbox.filter((m) => m.type === 'refresh').length, boardRefreshes = panel.outbox.filter((m) => m.type === 'refresh').length;
  await panel.call('changed');
  assert.equal(view.outbox.filter((m) => m.type === 'refresh').length, refreshes + 1, 'the sidebar reloads after the board creates or changes something');
  assert.equal(panel.outbox.filter((m) => m.type === 'refresh').length, boardRefreshes, 'the board is not told about its own change');
});

const BRANCH = () => branchName(issue('OG-1734'), '{key}-{slug}');

test('start work: branch from origin/master, assigned to me, In Progress, timer running', async () => {
  vs.setFolders(repo.repo);
  const seen = board().outbox.length;
  await run('ajwain.startWork', 'OG-1734');
  assert.equal(BRANCH(), 'OG-1734-holiday-calendar-ignores-timezone');
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), BRANCH());
  assert.equal(issue('OG-1734').assignee, mock.state.me);
  assert.equal(statusOf('OG-1734').name, 'In Progress');
  assert.equal(ctx.globalState.get('ajwain.timer')?.key, 'OG-1734');
  assert.ok(board().outbox.slice(seen).some((m) => m.type === 'timer' && m.timer?.key === 'OG-1734'), 'the board hears about the timer');
  assert.ok(vs.panels.find((p) => p.viewType === 'ajwain.home').outbox.some((m) => m.type === 'timer' && m.timer?.key === 'OG-1734'), 'so does the sidebar');
});

test('start work where the server wants an estimate first: asks for it before touching git; backing out changes nothing', async () => {
  mock.state.estimateFirst = true;
  const before = { branch: repo.git('rev-parse', '--abbrev-ref', 'HEAD'), status: issue('OG-1739').status, assignee: issue('OG-1739').assignee };
  assert.equal(issue('OG-1739').estimate_minutes, null);
  try {
    // Esc at the estimate prompt: no branch, the ticket untouched, no error.
    ask(undefined);
    await run('ajwain.startWork', 'OG-1739');
    assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), before.branch);
    assert.deepEqual([issue('OG-1739').status, issue('OG-1739').assignee, issue('OG-1739').estimate_minutes], [before.status, before.assignee, null]);
    // With an estimate: it's saved, the ticket starts, and only then the branch is made.
    ask('2h', undefined); // the estimate; then Esc at "stop the timer on OG-1734?" keeps that timer running
    await run('ajwain.startWork', 'OG-1739');
    assert.equal(issue('OG-1739').estimate_minutes, 120);
    assert.equal(statusOf('OG-1739').name, 'In Progress');
    assert.equal(issue('OG-1739').assignee, mock.state.me);
    assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), branchName(issue('OG-1739'), '{key}-{slug}'));
  } finally {
    mock.state.estimateFirst = false;
  }
  assert.equal(ctx.globalState.get('ajwain.timer')?.key, 'OG-1734');
  repo.git('checkout', '-q', BRANCH()); // back on OG-1734's branch for the tests that follow
});

test('timer: stopping it logs the time, noted with my commits made meanwhile', async () => {
  // Started a minute ago (commits from the second it started in don't count), and a teammate's commit lands meanwhile.
  await ctx.globalState.update('ajwain.timer', { ...ctx.globalState.get('ajwain.timer'), start: Date.now() - 60e3 });
  fs.writeFileSync(path.join(repo.repo, 'tz.js'), 'export const tz = "UTC";\n');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'OG-1734: use the user timezone');
  repo.git('commit', '-q', '--allow-empty', '--author=Ana <ana@example.com>', '-m', 'OG-1690: tidy the export');
  ask('$(check) Log');
  await run('ajwain.timerToggle', 'OG-1734');
  const w = writes('POST', '/api/worklogs/').at(-1);
  assert.deepEqual(w.body, { issue: issue('OG-1734').id, minutes: 5, logged_on: today(), note: 'OG-1734: use the user timezone' });
  assert.equal(ctx.globalState.get('ajwain.timer'), undefined);
  repo.git('reset', '-q', '--hard', 'HEAD~1'); // the teammate's commit isn't part of what the next tests ship
});

test('open PR: pushes, creates the CodeCommit PR with aws, moves the ticket to review and comments the link', async () => {
  await run('ajwain.openPR', 'OG-1734');

  const calls = fs.readFileSync(awsLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  const [a] = calls, arg = (flag) => a[a.indexOf(flag) + 1];
  assert.deepEqual(a.slice(0, 2), ['codecommit', 'create-pull-request']);
  assert.equal(arg('--title'), 'OG-1734: Holiday calendar ignores timezone');
  assert.equal(arg('--targets'), `repositoryName=TEST,sourceReference=${BRANCH()},destinationReference=master`);
  assert.equal(arg('--region'), 'ap-south-1');
  assert.match(arg('--description'), /^Ticket: \[OG-1734\]\(.+\)[\s\S]*## Commits\n- OG-1734: use the user timezone/);
  execFileSync('git', ['--git-dir', repo.bare, 'rev-parse', '--verify', `refs/heads/${BRANCH()}`]); // pushed

  assert.equal(statusOf('OG-1734').name, 'To be Tested');
  assert.equal(writes('POST', '/api/comments/').at(-1).body.body,
    'Pull request: https://ap-south-1.console.aws.amazon.com/codesuite/codecommit/repositories/TEST/pull-requests/77/details?region=ap-south-1');
  assert.ok(vs.messages.some((m) => m.msg.startsWith('Opened a pull request for OG-1734')));
});

test('finish: Done, back on master, the merged-upstream branch deleted', async () => {
  ask('Done', 'Switch back');
  await run('ajwain.finish', 'OG-1734');
  assert.equal(statusOf('OG-1734').category, 'DONE');
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'master');
  assert.equal(repo.git('branch', '--list', BRANCH()), '');
  assert.ok(vs.messages.some((m) => m.msg.startsWith('OG-1734 finished') && m.msg.includes('Deleted')));
});

test('implement with Claude: a worktree next to the repo, a terminal running claude with the ticket as the prompt', async () => {
  ask('In a new worktree');
  await run('ajwain.implementWithClaude', 'OG-1730');
  const wt = `${repo.repo}-OG-1730`;
  assert.ok(fs.existsSync(wt), 'worktree created');
  assert.equal(execFileSync('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), branchName(issue('OG-1730'), '{key}-{slug}'));
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'master', 'the main checkout stays put');
  const t = vs.terminals.at(-1);
  assert.deepEqual([t.name, t.cwd, t.shellPath, t.shown], ['Claude · OG-1730', wt, claudeBin, true]);
  const [prompt] = t.shellArgs;
  assert.match(prompt, /^Implement ticket OG-1730: Add retry with backoff to webhook delivery/);
  assert.match(prompt, /exponential backoff/);
  assert.match(prompt, /Subtasks:\n- OG-1738 Add RetryQueue table/);
  assert.equal(ctx.globalState.get('ajwain.timer')?.key, 'OG-1730');
});

test('ticket from a TODO: the code action creates the ticket with file:line context and tags the TODO', async () => {
  const file = path.join(repo.repo, 'src', 'retry.js');
  const text = 'export async function send(url) {\n  // TODO: handle retries\n  return fetch(url);\n}\n';
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, text);
  const uri = vs.api.Uri.file(file);
  const doc = vs.makeDocument(uri, text, 'javascript');
  vs.documents.set(uri.toString(), doc);
  const { provider } = vs.providers.CodeActionsProvider;
  assert.deepEqual(provider.provideCodeActions(vs.makeDocument(uri, '// TODO(OG-1): done'), new vs.api.Range(0, 0, 0, 0)), [], 'tagged TODOs are skipped');
  const [action] = provider.provideCodeActions(doc, new vs.api.Range(1, 0, 1, 0));
  assert.deepEqual(action.command.arguments, [uri, 1]);

  ask('OG', 'Handle retries in send()');
  await run(action.command.command, ...action.command.arguments);
  const created = mock.state.issues.at(-1);
  const body = writes('POST', '/api/issues/').at(-1).body;
  assert.deepEqual([body.title, body.issue_type, body.project, body.assignee, created.key], ['Handle retries in send()', 'TASK', project('OG').id, mock.state.me, 'OG-1742']);
  assert.match(body.description, /`src\/retry\.js:2` \(on `master`\)/);
  assert.match(body.description, /```javascript\n[\s\S]*\/\/ TODO: handle retries[\s\S]*```/);

  const [e] = vs.edits.at(-1).edits;
  assert.equal(e.uri, uri);
  const line = text.split('\n')[e.range.start.line];
  assert.equal(line.slice(0, e.range.start.character) + e.text + line.slice(e.range.start.character), '  // TODO(OG-1742): handle retries');
});

test('the whole session: nothing logged as an error, no unanswered prompts that block', () => {
  const expected = (t) => t.includes('/api/issues/NOPE-1/ → 404'); // the board test's deliberate 404
  assert.deepEqual(vs.logs.filter((l) => l.level === 'error' && !expected(l.text)).map((l) => l.text), []);
  assert.deepEqual(vs.messages.filter((m) => m.level === 'error'), []);
  assert.deepEqual(vs.unanswered.filter((u) => u.kind !== 'message'), [], 'quick picks or input boxes nobody answered');
});
