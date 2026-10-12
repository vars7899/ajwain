// The board webview (media/board.js) in headless Chrome, hosted by dev/preview.html on the mock API.
// Stable hooks only (data-act, data-field, form[data-form], .card, .col[data-drop], ...): the markup changes often.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startMockApi } from './mock-api.mjs';
import { launch, findChrome } from './cdp.mjs';

const chrome = findChrome();
const it = (name, fn) => test(name, { skip: !chrome && 'no Chrome found (set CHROME)' }, fn);
let mock, browser, run = 0;
before(async () => {
  mock = await startMockApi();
  if (chrome) browser = await launch({ chrome });
});
after(async () => {
  await browser?.close();
  await mock?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what = String(fn), timeout = 6000) {
  for (const end = Date.now() + timeout; ; await sleep(30)) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
  }
}
const issue = (key) => mock.state.issues.find((i) => i.key === key);
const project = (key) => mock.state.projects.find((p) => p.key === key);
const statuses = (key) => mock.state.statuses.filter((s) => s.project === project(key).id);
const activeSprint = (key) => mock.state.sprints.find((s) => s.project === project(key).id && s.state === 'ACTIVE');
const writes = (method, path) => mock.log.filter((l) => l.method === method && (path instanceof RegExp ? path.test(l.path) : l.path === path));
// Waits until at least `n` such requests reached the mock; returns them.
const written = (method, path, n = 1) => until(() => writes(method, path).length >= n && writes(method, path), `${n} × ${method} ${path}`);
const today = () => new Date().toLocaleDateString('en-CA');
const hostCalls = (page, method) => page.eval((m) => window.__host.calls.filter((c) => c.method === m), method);
const submit = (page, sel) => page.eval((s) => document.querySelector(s).requestSubmit(), sel);

// A fresh fixture and a fresh page for each test; the page is closed even when the test fails.
async function open(t, hash) {
  mock.reset();
  const page = await browser.page(`${mock.url}/dev/preview.html?run=${++run}#${hash}`);
  t.after(() => page.close());
  return page;
}
// Every test ends here: no errors reported by the webview, no uncaught exceptions, no error toasts.
async function clean(page) {
  await sleep(150); // let in-flight replies land
  assert.deepEqual(await page.eval(() => window.__host.errors), [], 'webview reported errors');
  assert.deepEqual(page.consoleErrors, [], 'console errors or uncaught exceptions');
  assert.deepEqual(await page.eval(() => [...document.querySelectorAll('.toast.error')].map((e) => e.textContent)), [], 'error toasts');
}

test('preview: dev/preview.html emulates every boardApi method of extension.js', () => {
  const methods = (file) => {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('const boardApi = {'), src.indexOf('\n};', src.indexOf('const boardApi = {')));
    return new Set([...body.matchAll(/^ {2}(?:async\s+)?([A-Za-z]\w*)\s*[:(]/gm)].map((m) => m[1]));
  };
  const host = methods('../extension.js'), preview = methods('../dev/preview.html');
  assert.ok(host.size > 10, 'found boardApi in extension.js');
  assert.deepEqual([...host].filter((m) => !preview.has(m)), [], 'add these to boardApi in dev/preview.html');
});

it('board: one column per status, cards from the active sprint in their status column', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  await page.waitFor('.card');
  const cols = await page.eval(() => [...document.querySelectorAll('.col[data-drop=status]')].map((c) => ({
    id: c.dataset.value, keys: [...c.querySelectorAll('.card')].map((x) => x.dataset.key),
  })));
  assert.deepEqual(cols.map((c) => c.id), statuses('OG').map((s) => s.id));
  const expected = mock.state.issues.filter((i) => i.project === project('OG').id && i.sprint === activeSprint('OG').id).map((i) => i.key);
  assert.deepEqual(cols.flatMap((c) => c.keys).sort(), expected.sort());
  for (const c of cols) for (const k of c.keys) assert.equal(issue(k).status, c.id, `${k} is in the wrong column`);
  assert.equal(await page.eval(() => document.querySelector('#project').value), project('OG').id);
  await clean(page);
});

it('board: dragging a card to another column PATCHes its status', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  await page.waitFor('.card[data-key="OG-1730"]');
  const done = statuses('OG').find((s) => s.category === 'DONE').id, id = issue('OG-1730').id;
  await page.eval((key, col) => {
    const dt = new DataTransfer();
    document.querySelector(`.card[data-key="${key}"]`).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const zone = document.querySelector(`.col[data-value="${col}"] .cards`);
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, 'OG-1730', done);
  const [p] = await written('PATCH', `/api/issues/${id}/`);
  assert.deepEqual(p.body, { status: done });
  await page.waitFor(`.col[data-value="${done}"] .card[data-key="OG-1730"]`);
  assert.equal(issue('OG-1730').status, done);
  await clean(page);
});

it('list: changing a status dropdown PATCHes the issue', async (t) => {
  const page = await open(t, 'view=list&project=OG');
  const { id } = issue('OG-1736'), tested = statuses('OG').find((s) => /test/i.test(s.name)).id;
  await page.click(`[data-act=cell-edit][data-field=status][data-id="${id}"]`); // a label until clicked
  await page.select(`select.status[data-id="${id}"]`, tested);
  const [p] = await written('PATCH', `/api/issues/${id}/`);
  assert.deepEqual(p.body, { status: tested });
  assert.equal(issue('OG-1736').status, tested);
  await clean(page);
});

it('new issue: the modal POSTs the issue with project, defaults and parsed estimate', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  await page.waitFor('.card');
  await page.click('[data-act=new]');
  const form = 'form[data-form=create]';
  await page.fill(`${form} [name=title]`, 'Export board as CSV');
  await page.select(`${form} [name=issue_type]`, 'STORY');
  await page.fill(`${form} [name=estimate]`, '1h30m');
  await submit(page, form);
  const [p] = await written('POST', '/api/issues/');
  const og = project('OG');
  assert.deepEqual(
    { ...p.body, description: undefined },
    { ...p.body, description: undefined, project: og.id, title: 'Export board as CSV', issue_type: 'STORY', estimate_minutes: 90, assignee: mock.state.me, status: statuses('OG')[0].id, sprint: activeSprint('OG').id },
  );
  const created = mock.state.issues.at(-1);
  assert.equal(created.key, 'OG-1742');
  await page.waitFor(`.card[data-key="${created.key}"]`);
  await page.waitFor('.toast');
  assert.equal(await page.eval(() => !!document.querySelector('form[data-form=create]')), false, 'the modal closes');
  await clean(page);
});

it('ticket drawer: log time and comment', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  await page.click('.card[data-key="OG-1730"]');
  await page.waitFor(() => document.querySelector('.drawer form[data-form=comment]') && !document.querySelector('.drawer .skeleton'));
  const { id } = issue('OG-1730'), logged = issue('OG-1730').logged_minutes;

  await page.fill('.drawer form[data-form=log] [name=d]', '1h');
  await page.fill('.drawer form[data-form=log] [name=note]', 'Wrote tests');
  await submit(page, '.drawer form[data-form=log]');
  const [w] = await written('POST', '/api/worklogs/');
  assert.deepEqual(w.body, { issue: id, minutes: 60, logged_on: today(), note: 'Wrote tests' });
  assert.equal(issue('OG-1730').logged_minutes, logged + 60);

  await page.fill('.drawer form[data-form=comment] [name=body]', 'Retries look good to me');
  await submit(page, '.drawer form[data-form=comment]');
  const [c] = await written('POST', '/api/comments/');
  assert.deepEqual(c.body, { issue: id, body: 'Retries look good to me' });
  await page.waitFor(() => document.querySelector('.drawer').textContent.includes('Retries look good to me'));
  await clean(page);
});

it("today: logs the time suggested from today's commits, one worklog per ticket", async (t) => {
  const page = await open(t, 'view=today');
  await page.waitFor('[data-act=today-log]:not([disabled])');
  await page.click('[data-act=today-log]');
  const logs = await written('POST', '/api/worklogs/', 2);
  assert.deepEqual(logs.map((l) => l.body.issue).sort(), [issue('OG-1730').id, issue('OG-1731').id].sort());
  for (const l of logs) {
    assert.ok(Number.isInteger(l.body.minutes) && l.body.minutes > 0, `minutes ${l.body.minutes}`);
    assert.equal(l.body.logged_on, today());
  }
  await page.waitFor('.toast');
  await clean(page);
});

it('today: "Create ticket" on untracked work creates it and links the branch', async (t) => {
  const page = await open(t, 'view=today');
  await page.click('[data-act=today-create][data-branch="pdf-export-fixes"]');
  const form = 'form[data-form=create]';
  await page.waitFor(form);
  assert.ok(await page.eval((f) => document.querySelector(`${f} [name=title]`).value.trim(), form), 'title is prefilled');
  await submit(page, form);
  const [p] = await written('POST', '/api/issues/');
  const created = mock.state.issues.at(-1);
  assert.equal(p.body.title, created.title);
  const [link] = await until(() => hostCalls(page, 'linkBranch').then((c) => c.length && c), 'host linkBranch');
  assert.deepEqual(link.args, ['pdf-export-fixes', created.key]);
  await clean(page);
});

it('breakdown: draft, approve and create subtasks, update the parent, start work', async (t) => {
  const page = await open(t, 'view=board&project=OG&open=OG-1730&plan');
  const parent = issue('OG-1730');
  await page.click('[data-act=plan-draft]');
  await page.waitFor(() => document.querySelector('[data-act=plan-create]:not([disabled])'));
  const [draft] = await hostCalls(page, 'draftBreakdown');
  assert.equal(draft.args[0].key, 'OG-1730');
  await page.click('[data-act=plan-create]');
  const [start] = await until(() => hostCalls(page, 'startWork').then((c) => c.length && c), 'host startWork');
  assert.equal(start.args[0].key, 'OG-1730');
  assert.equal(start.args[1], 'branch');

  const subs = writes('POST', '/api/issues/').map((l) => l.body);
  assert.deepEqual(subs.map((b) => [b.title, b.estimate_minutes]), [['Add RetryQueue with exponential backoff', 180], ['Call RetryQueue from deliver() on failure', 90]]);
  for (const b of subs) assert.deepEqual([b.parent, b.project, b.issue_type], [parent.id, parent.project, 'SUBTASK']);
  const desc = writes('PATCH', `/api/issues/${parent.id}/`).find((l) => 'description' in l.body);
  assert.ok(desc, 'parent description PATCHed');
  assert.ok(desc.body.description.startsWith(parent.description.slice(0, 40)), 'keeps the old description');
  assert.match(desc.body.description, /RetryQueue/);
  assert.equal(mock.state.issues.filter((i) => i.parent === parent.id).length, 3);
  await clean(page);
});

it('scope: "All projects" asks which project; choosing one and switching workspace go through the host', async (t) => {
  const page = await open(t, 'view=board&project=');
  await page.waitFor('.chooser');
  assert.equal(await page.eval(() => document.querySelector('#project').value), '');
  const og = project('OG');
  await page.click(`.choice[data-id="${og.id}"]`);
  await page.waitFor('.col[data-drop=status]');
  assert.deepEqual((await hostCalls(page, 'setScope')).map((c) => c.args), [[{ project: og.id }]]);
  assert.equal(await page.eval(() => document.querySelector('#project').value), og.id);

  const [, w2] = mock.state.workspaces;
  await page.select('#workspace', w2.id);
  const calls = await until(() => hostCalls(page, 'setScope').then((c) => c.length === 2 && c), 'second setScope');
  assert.deepEqual(calls[1].args, [{ workspace: w2.id, project: '' }]);
  const home = project('HOME');
  await page.waitFor((id) => [...document.querySelectorAll('#project option')].some((o) => o.value === id), { args: [home.id] });
  await page.waitFor(`.choice[data-id="${home.id}"]`);
  await clean(page);
});

it('standup: the modal has text and Copy hands it to the host', async (t) => {
  const page = await open(t, 'view=today&standup');
  const text = await page.waitFor(() => document.querySelector('#standup')?.value.trim());
  assert.match(text, /OG-1730/);
  await page.click('[data-act=copy-standup]');
  const [copy] = await until(() => hostCalls(page, 'copy').then((c) => c.length && c), 'host copy');
  assert.equal(copy.args[0].trim(), text);
  await clean(page);
});

it('theme: dropdown options follow the VS Code theme (light text on dark, and the reverse)', async (t) => {
  const luma = (rgb) => { const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).map(Number); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
  const look = () => {
    const o = document.querySelector('.fields select[data-field=issue_type]').options[0];
    return { bg: getComputedStyle(o).backgroundColor, fg: getComputedStyle(o).color, scheme: getComputedStyle(document.body).colorScheme };
  };
  const dark = await open(t, 'view=board&project=OG&open=OG-1730');
  await dark.waitFor('.fields select[data-field=issue_type]');
  const d = await dark.eval(look);
  assert.equal(await dark.eval(() => document.body.classList.contains('vscode-dark')), true);
  assert.equal(d.scheme, 'dark');
  assert.ok(luma(d.bg) < 0.3 && luma(d.fg) > 0.6, `dark: ${JSON.stringify(d)}`);
  await clean(dark);

  const light = await open(t, 'view=board&project=OG&open=OG-1730&light');
  await light.waitFor('.fields select[data-field=issue_type]');
  const l = await light.eval(look);
  assert.ok(luma(l.bg) > 0.7 && luma(l.fg) < 0.4, `light: ${JSON.stringify(l)}`);
  await clean(light);
});
