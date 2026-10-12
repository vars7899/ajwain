// The board's writing help, attachments and fun features, end to end: real board.js in headless Chrome,
// dev/preview.html as the extension host, the mock API as the server. Same conventions as board.e2e.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
async function until(fn, what = String(fn), timeout = 15000) {
  for (const end = Date.now() + timeout; ; await sleep(40)) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
  }
}
const writes = (method, path) => mock.log.filter((l) => l.method === method && (path instanceof RegExp ? path.test(l.path) : l.path === path));
const reads = (path) => mock.log.filter((l) => l.method === 'GET' && (path instanceof RegExp ? path.test(l.path) : l.path === path));
const issue = (key) => mock.state.issues.find((i) => i.key === key);
const hostCalls = (page, method) => page.eval((m) => window.__host.calls.filter((c) => c.method === m), method);
async function open(t, hash) {
  mock.reset();
  const page = await browser.page(`${mock.url}/dev/preview.html?lead=${++run}#${hash}`);
  t.after(() => page.close());
  // The shell renders before data arrives: wait for the projects (init done) and the first load to finish.
  await page.waitFor(() => document.querySelectorAll('#project option').length > 1 && !document.querySelector('#view .skeleton'), { timeout: 15000 });
  return page;
}
async function clean(page) {
  await sleep(200);
  assert.deepEqual(await page.eval(() => window.__host.errors), [], 'webview reported errors');
  assert.deepEqual(page.consoleErrors, [], 'console errors or uncaught exceptions');
  assert.deepEqual(await page.eval(() => [...document.querySelectorAll('.toast.error')].map((e) => e.textContent)), [], 'error toasts');
}
// A tiny PNG, made in the page, as a File.
const pngFile = (name) => `new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))], ${JSON.stringify(name)}, { type: 'image/png' })`;

it('new issue: draft from notes fills the form; similar issues and ticket health update live', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  await page.click('[data-act=new]');
  await page.click('[data-act=toggle-notes]');
  await page.fill('#notes', 'Customers say the login page crashes on Safari when 2FA is on, right after entering the code.');
  await page.click('[data-act=draft-notes]');
  await until(() => page.eval(() => document.querySelector('form[data-form=create]').title.value.length > 0), 'draft fills the title');
  const draft = writes('POST', '/api/issues/draft/');
  assert.equal(draft.length, 1);
  assert.match(draft[0].body.text, /Safari/);
  assert.ok(await page.eval(() => document.querySelector('form[data-form=create]').description.value.length > 20), 'description drafted');
  // The draft's type and priority survive the form re-rendering after the draft (the mock drafts a crash as a HIGH bug).
  assert.deepEqual(await page.eval(() => { const f = document.querySelector('form[data-form=create]'); return [f.issue_type.value, f.priority.value]; }), ['BUG', 'HIGH']);

  await page.fill('form[data-form=create] [name=title]', 'Login fails on Safari');
  await until(() => page.eval(() => document.querySelectorAll('#new-similar .row').length > 0), 'similar issues');
  assert.ok(reads('/api/issues/similar/').length >= 1);

  const score = () => page.eval(() => Number(document.querySelector('#new-health b.mono')?.textContent.replace('%', '')));
  const before = await score();
  await page.fill('form[data-form=create] [name=estimate]', '3h');
  await until(async () => (await score()) > before, 'health goes up with an estimate');
  await clean(page);
});

it('new issue: a pasted screenshot uploads after create and its reference points at the real attachment', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  await page.click('[data-act=new]');
  await page.fill('form[data-form=create] [name=title]', 'Chart labels overlap on small screens');
  await page.eval(`(() => {
    const ta = document.querySelector('form[data-form=create] textarea[name=description]');
    ta.focus();
    const dt = new DataTransfer();
    dt.items.add(${pngFile('overlap.png')});
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await until(() => page.eval(() => document.querySelector('form[data-form=create] textarea[name=description]').value.includes('attachment:new-')), 'placeholder inserted');
  await page.eval(() => document.querySelector('form[data-form=create]').requestSubmit());
  await until(() => writes('PATCH', /^\/api\/issues\/[^/]+\/$/).length, 'description patched with the real id');
  const created = writes('POST', '/api/issues/')[0];
  assert.equal(writes('POST', '/api/attachments/presign/').length, 1);
  assert.equal(writes('POST', '/api/attachments/').length, 1);
  const patchBody = writes('PATCH', /^\/api\/issues\/[^/]+\/$/).at(-1).body;
  assert.match(patchBody.description, /!\[overlap\.png\]\(attachment:[^n)][^)]*\)/);
  assert.doesNotMatch(patchBody.description, /attachment:new-/);
  assert.equal(created.body.title, 'Chart labels overlap on small screens');
  await clean(page);
});

it('ticket panel: health quick fix, AI summary, improve, attachments (drop, list, delete)', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  const target = mock.state.issues.find((i) => i.key.startsWith('OG-') && !/acceptance criteria/i.test(i.description ?? '') && i.issue_type !== 'EPIC' && i.issue_type !== 'BUG');
  await page.eval((k) => { location.hash = `view=board&project=OG&open=${k}`; }, target.key);
  await page.eval(() => location.reload());
  await page.waitFor('.drawer .health.strip');

  // health: append only the missing template sections
  if (await page.eval(() => !!document.querySelector('[data-act=health-template]'))) {
    await page.click('[data-act=health-template]');
    await until(() => writes('PATCH', `/api/issues/${target.id}/`).length, 'sections appended');
    assert.match(writes('PATCH', `/api/issues/${target.id}/`).at(-1).body.description, /## Acceptance criteria/);
    await page.click('[data-act=cancel-desc]'); // the quick fix opens the editor so the new sections can be filled in
  }

  await page.click('[data-act=summarize]');
  await page.waitFor('.ai-summary .md');
  assert.equal(reads(`/api/issues/${target.id}/summary/`).length, 1);

  await page.click('[data-act=improve]');
  await page.waitFor('[data-act=improve-accept]');
  await page.click('[data-act=improve-accept]');
  await until(() => writes('PATCH', `/api/issues/${target.id}/`).some((w) => 'title' in w.body && 'description' in w.body), 'rewrite saved');

  // drop a file onto the panel
  const files = () => mock.state.attachments.filter((a) => a.issue === target.id).length;
  const had = files();
  await page.eval(`(() => {
    const dt = new DataTransfer();
    dt.items.add(${pngFile('screen.png')});
    const zone = document.querySelector('.drawer');
    zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await until(() => page.eval(() => document.querySelectorAll('.attachments .att').length > 0), 'attachment listed');
  assert.equal(writes('POST', '/api/attachments/').at(-1).body.target_id, target.id);
  assert.equal(files(), had + 1);

  // delete asks twice
  await page.click('[data-act=att-delete]');
  assert.equal(writes('DELETE', /^\/api\/attachments\//).length, 0, 'first click only arms the delete');
  await page.click('[data-act=att-delete]');
  await until(() => writes('DELETE', /^\/api\/attachments\//).length === 1, 'deleted on the second click');
  await clean(page);
});

it('filter in plain words maps the AI result onto the filters', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  await page.waitFor('form[data-form=ask]');
  await page.fill('form[data-form=ask] input', 'my open bugs this sprint');
  await page.eval(() => document.querySelector('form[data-form=ask]').requestSubmit());
  await until(() => writes('POST', /filter-from-text/).length, 'asked the AI');
  const on = await until(() => page.eval(() => {
    const xs = [...document.querySelectorAll('.filter-btn.on')].map((b) => b.dataset.key);
    return xs.includes('type') ? xs : null; // sprint is on by default, so wait for the AI's filters
  }), 'filters applied');
  assert.ok(on.includes('type') && on.includes('assignee'), `filters on: ${on}`);
  await clean(page);
});

it('standup: the AI version replaces the text; copying records it', async (t) => {
  const page = await open(t, 'view=today&standup');
  await page.waitFor('#standup');
  const local = await page.eval(() => document.querySelector('#standup').value);
  await page.click('[data-act=standup-source][data-src=ai]');
  await until(async () => (await page.eval(() => document.querySelector('#standup').value)) !== local, 'AI text');
  assert.equal(reads(/^\/api\/activity\/users\/[^/]+\/standup\/$/).length, 1);
  await page.click('[data-act=copy-standup]');
  await until(async () => (await hostCalls(page, 'record')).some((c) => c.args[0]?.type === 'standup'), 'standup recorded');
  await clean(page);
});

it('Today: fun bar, badges, tip; lucky dip lands and starts the pick', async (t) => {
  const page = await open(t, 'view=today');
  await page.waitFor('.funbar');
  assert.ok(await page.eval(() => document.querySelectorAll('.badges .badge').length >= 10), 'badge wall');
  assert.ok(await page.eval(() => document.querySelector('.hero .tip')?.textContent.length > 10), 'tip of the day');
  await page.click('[data-act=lucky]');
  await page.waitFor('[data-act=lucky-start]:not([disabled])', { timeout: 8000 });
  await page.click('[data-act=lucky-start]');
  await until(async () => (await hostCalls(page, 'startWork')).length, 'started');
  assert.ok((await hostCalls(page, 'record')).some((c) => c.args[0]?.type === 'lucky'));
  await clean(page);
});

it('wind down saves tomorrow\'s first ticket and note; Wrapped copies and saves', async (t) => {
  const page = await open(t, 'view=today');
  await page.click('[data-act=shutdown]');
  await page.waitFor('#tomorrow-key');
  const key = await page.eval(() => document.querySelector('#tomorrow-key').value);
  await page.fill('#tomorrow-note', 'Retry queue is half done: wire it into deliver()');
  await page.click('[data-act=shutdown-save]');
  await page.waitFor('.modal.shutdown.done');
  const saved = (await hostCalls(page, 'setTomorrow')).at(-1).args[0];
  assert.deepEqual(saved, { key, note: 'Retry queue is half done: wire it into deliver()' });
  await page.click('[data-act=close-modal]');

  await page.click('[data-act=wrapped]');
  await page.waitFor('.wrapped-card svg', { timeout: 8000 });
  await page.click('[data-act=wrapped-copy]');
  await until(async () => (await hostCalls(page, 'copy')).some((c) => /Ajwain Wrapped/.test(c.args[0])), 'copied text');
  await page.click('[data-act=wrapped-save]');
  const img = await until(async () => (await hostCalls(page, 'saveImage')).at(-1), 'saved image');
  assert.match(img.args[0], /^data:image\/png;base64,/);
  await clean(page);
});

it('moving a ticket to a done column celebrates and records a finish', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  await page.waitFor('.card');
  const moved = await page.eval(() => {
    const done = [...document.querySelectorAll('.col[data-drop=status]')].at(-1);
    const card = [...document.querySelectorAll('.card')].find((c) => !done.contains(c));
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    done.querySelector('.cards').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return card.dataset.key;
  });
  await page.waitFor('.cheer');
  await until(async () => (await hostCalls(page, 'record')).some((c) => c.args[0]?.type === 'finish' && c.args[0].key === moved), 'finish recorded');
  await clean(page);
});

it('New issue clicked the moment the button appears waits for the first load instead of failing', async (t) => {
  mock.reset();
  const page = await browser.page(`${mock.url}/dev/preview.html?lead=${++run}#view=board&project=OG`);
  t.after(() => page.close());
  await page.waitFor('[data-act=new]');
  await page.click('[data-act=new]');
  await page.waitFor('form[data-form=create]', { timeout: 15000 });
  await clean(page);
});

it('the New issue form keeps what you typed through re-renders and host pushes', async (t) => {
  const page = await open(t, 'view=board&project=OG&open=OG-1730');
  await page.waitFor('[data-act=new-sub]');
  await page.click('[data-act=new-sub]'); // the form opens on top of the ticket panel
  await page.waitFor('form[data-form=create]');
  await page.fill('form[data-form=create] [name=estimate]', '3h');
  await page.select('form[data-form=create] [name=priority]', 'HIGH');
  const status = await page.eval(() => document.querySelector('form[data-form=create] [name=status] option:last-child').value);
  await page.select('form[data-form=create] [name=status]', status);
  // Three ways the form re-renders: the notes panel, adding a tag, a timer push from the host.
  if (await page.eval(() => !!document.querySelector('[data-act=toggle-notes]'))) await page.click('[data-act=toggle-notes]');
  const tag = await page.eval(() => document.querySelector('form[data-form=create] select[data-change=add-tag] option:nth-child(2)')?.value);
  if (tag) await page.select('form[data-form=create] select[data-change=add-tag]', tag);
  await page.eval(() => window.postMessage({ type: 'timer', timer: { key: 'OG-1730', id: 'x', title: 'x', start: Date.now() } }, '*'));
  await sleep(250);
  const values = await page.eval(() => { const f = document.querySelector('form[data-form=create]'); return [f.estimate.value, f.priority.value, f.status.value]; });
  assert.deepEqual(values, ['3h', 'HIGH', status]);
  await clean(page);
});
