// The extension host's newer features against the stub `vscode` and the mock API: journal + badges + celebrations,
// attachments (bytes from the board, file dialog, Explorer command), activity-based stretch breaks, focus sessions,
// the break screen's messages, fun reminders. Time is faked (Date.now) and the scheduler's interval is driven by hand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import http from 'node:http';
import { startMockApi } from './mock-api.mjs';
import { zohoTime } from '../zoho.mjs';

const require = createRequire(import.meta.url);
const { createVscode, install } = require('./vscode-stub.cjs');
const ROOT = path.resolve(import.meta.dirname, '..');
// extension.js needs the stub vscode before it loads, so the switch is read from its source.
const ATTENDANCE = /^const ATTENDANCE = true;/m.test(fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8'));
const whenOn = { skip: !ATTENDANCE && 'attendance is switched off (ATTENDANCE in extension.js)' };

let mock, vs, ctx, tmp, uninstall, zoho, now = Date.now();
const ticks = []; // the extension's setInterval callbacks (scheduler, status bar timers)
const listeners = { selection: [] };
const envBefore = {};
const realNow = Date.now;
const tick = async () => { for (const fn of ticks) await fn(); };
const board = () => vs.panels.findLast((p) => p.viewType === 'ajwain.board');
const breaks = () => vs.panels.filter((p) => p.viewType === 'ajwain.break');
const journal = () => ctx.globalState.get('ajwain.journal') ?? [];
const issueByKey = (k) => mock.state.issues.find((i) => i.key === k);

// A stand-in for Zoho: the token endpoint and the two attendance calls, with today's punches in memory.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fromZoho = (s) => { const [d, t] = s.split(' '), [dd, mm, yy] = d.split('/').map(Number), [h, m, sec] = t.split(':').map(Number); return new Date(yy, mm - 1, dd, h, m, sec); };
const entryTime = (d) => `${String(d.getDate()).padStart(2, '0')}-${MON[d.getMonth()]}-${d.getFullYear()} - ${String(d.getHours() % 12 || 12).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
function startZoho() {
  const z = { punches: [], entries: [], token: null, emails: new Set() };
  const open = () => z.entries.at(-1) && !z.entries.at(-1).out;
  z.server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const u = new URL(req.url, 'http://x'), b = Object.fromEntries(new URLSearchParams(raw));
    const send = (status, j) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/oauth/v2/token') {
      if (b.grant_type === 'authorization_code') return b.code === 'good-code' ? send(200, { access_token: (z.token = 'zat'), refresh_token: 'zrt', expires_in: 3600 }) : send(400, { error: 'invalid_code' });
      return b.refresh_token === 'zrt' ? send(200, { access_token: (z.token = 'zat2'), expires_in: 3600 }) : send(400, { error: 'invalid_code' });
    }
    if (req.headers.authorization !== `Zoho-oauthtoken ${z.token}`) return send(401, { message: 'Invalid OAuth token' });
    if (u.pathname === '/people/api/attendance/getAttendanceEntries') {
      z.reads = (z.reads ?? 0) + 1;
      z.query = Object.fromEntries(u.searchParams);
      if (z.fail) return send(200, { response: { message: 'Error occurred', status: 1, errors: { code: 7005, message: 'Please specify a valid date' } } });
      return send(200, { result: [{ allowedToCheckIn: !open(), entries: z.entries.map((e) => ({ checkIn: entryTime(e.in), checkOut: e.out ? entryTime(e.out) : '' })) }] });
    }
    if (u.pathname === '/people/api/attendance' && req.method === 'POST') {
      z.punches.push(b);
      z.emails.add(b.emailId);
      if (b.checkIn) z.entries.push({ in: fromZoho(b.checkIn), out: null });
      if (b.checkOut && open()) z.entries.at(-1).out = fromZoho(b.checkOut);
      return send(200, { response: { status: 0, message: 'Data added successfully' } });
    }
    send(404, { message: 'Not found' });
  });
  return new Promise((r) => z.server.listen(0, '127.0.0.1', () => r(Object.assign(z, { url: `http://127.0.0.1:${z.server.address().port}` }))));
}
async function until(fn, what, ms = 5000) {
  for (const end = realNow() + ms; ; await new Promise((r) => setTimeout(r, 20))) {
    const v = await fn();
    if (v) return v;
    if (realNow() > end) throw new Error(`Timed out waiting for ${what}`);
  }
}

before(async () => {
  mock = await startMockApi();
  zoho = await startZoho();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ajwain-lead-')));
  for (const [k, v] of Object.entries({ XDG_CONFIG_HOME: path.join(tmp, 'config'), HOME: tmp, AJWAIN_ZOHO_ACCOUNTS: zoho.url, AJWAIN_ZOHO_PEOPLE: zoho.url })) [envBefore[k], process.env[k]] = [process.env[k], v];
  vs = createVscode({
    settings: {
      'ajwain.apiUrl': mock.url, 'ajwain.reminders.schedule': [], 'ajwain.breaks.mode': 'activity', 'ajwain.breaks.every': 50,
      'ajwain.breaks.focusMinutes': 25, 'ajwain.fun.celebrations': true,
      // Attendance on any day, so the test doesn't depend on which day it runs; the hours come from the clock it sets.
      'ajwain.attendance.days': ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    },
  });
  // Grab what the extension subscribes to, so the test can play the user's activity and the clock.
  const w = vs.api.window;
  const onSel = w.onDidChangeTextEditorSelection;
  w.onDidChangeTextEditorSelection = (fn) => (listeners.selection.push(fn), onSel(fn));
  const create = w.createWebviewPanel;
  w.createWebviewPanel = (...a) => {
    const p = create(...a);
    const on = p.webview.onDidReceiveMessage;
    p.webview.onDidReceiveMessage = (fn) => ((p.send = fn), on(fn));
    return p;
  };
  uninstall = install(vs);
  ctx = vs.context({ root: ROOT, storage: path.join(tmp, 'storage') });
  // A carry-over file from another copy of the extension, waiting in the storage folder.
  fs.mkdirSync(path.join(tmp, 'storage'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'storage', 'import.json'), JSON.stringify({
    state: { 'ajwain.tomorrow': { key: 'OG-1730', note: 'carried over', date: '2026-01-01' }, 'other.thing': 1 },
    settings: { branchTemplate: '{key}-{slug}', 'breaks.every': 5 }, // breaks.every is already set here: it stays
  }));
  // Attendance switched off: a Zoho sign-in left over from before must stay unused.
  if (!ATTENDANCE) await ctx.secrets.store('ajwain.zoho', JSON.stringify({ clientId: 'id', clientSecret: 'sec', refresh: 'zrt' }));
  Date.now = () => now;
  const timers = { setTimeout, setInterval };
  globalThis.setTimeout = (fn, ms, ...a) => timers.setTimeout(fn, ms, ...a).unref();
  globalThis.setInterval = (fn, ms, ...a) => (ticks.push(fn), timers.setInterval(() => {}, 1e9).unref());
  try {
    await require('../extension.js').activate(ctx);
  } finally {
    Object.assign(globalThis, timers);
  }
  vs.answers.push('sam', 'secret');
  await vs.api.commands.executeCommand('ajwain.signIn');
});

after(async () => {
  Date.now = realNow;
  for (const d of ctx?.subscriptions ?? []) d?.dispose?.();
  uninstall?.();
  for (const [k, v] of Object.entries(envBefore)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  await mock?.close();
  zoho?.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the journal unlocks badges once and celebrates on the board', async () => {
  await vs.api.commands.executeCommand('ajwain.openBoard');
  const panel = board();
  assert.ok(panel, 'board open');
  await panel.call('record', { type: 'pr', key: 'OG-1730' });
  const cheer = panel.outbox.filter((m) => m.type === 'celebrate');
  assert.deepEqual(cheer.map((m) => m.title), ['Badge unlocked: First PR']);
  assert.equal(typeof ctx.globalState.get('ajwain.unlocked')['first-pr'], 'number');
  await panel.call('record', { type: 'pr', key: 'OG-1731' });
  assert.equal(panel.outbox.filter((m) => m.type === 'celebrate').length, 1, 'no second cheer for the same badge');
  // Time logged and tickets created straight from the board land in the journal too.
  const target = issueByKey('OG-1730');
  await panel.call('req', '/api/worklogs/', { method: 'POST', body: { issue: target.id, minutes: 45, logged_on: '2026-10-06', note: '' } });
  await panel.call('req', '/api/issues/', { method: 'POST', body: { project: target.project, title: 'Add retry to webhook delivery', issue_type: 'TASK', estimate_minutes: 60, description: '## Why\nReceivers drop events when they restart.\n\n## Acceptance criteria\n- [ ] Retries' } });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(journal().some((e) => e.type === 'log' && e.minutes === 45));
  assert.ok(journal().some((e) => e.type === 'ticket' && e.score === 100));
});

test('attachments: bytes from the board, the file dialog, the Explorer command', async () => {
  const panel = board();
  const i = issueByKey('OG-1731');
  const [a] = await panel.call('attachBytes', { id: i.id, key: i.key }, [{ name: 'notes.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') }]);
  assert.equal(a.name, 'notes.txt');
  const { url } = await panel.call('attachmentUrl', a.id, false);
  assert.equal(await (await fetch(url)).text(), 'hello', 'the stored bytes come back from the signed URL');

  const file = path.join(tmp, 'trace.log');
  fs.writeFileSync(file, 'boom');
  vs.answers.push([vs.api.Uri.file(file)]);
  const picked = await panel.call('pickAndAttach', { id: i.id, key: i.key });
  assert.deepEqual(picked.map((x) => x.name), ['trace.log']);

  const shot = path.join(tmp, 'screen.png');
  fs.writeFileSync(shot, Buffer.from('iVBORw0KGgo=', 'base64'));
  vs.answers.push((items) => items.at(-1), 'OG-1730'); // "Enter a key…", then the key
  await vs.api.commands.executeCommand('ajwain.attachFiles', vs.api.Uri.file(shot));
  const names = (k) => mock.state.attachments.filter((x) => x.issue === issueByKey(k).id).map((x) => x.name);
  assert.ok(['notes.txt', 'trace.log'].every((n) => names('OG-1731').includes(n)), names('OG-1731').join());
  assert.ok(names('OG-1730').includes('screen.png'));
  assert.match(board().webview.html, /img-src [^;]*https:/, 'the board may show signed attachment URLs');
});

test('a break is suggested after 50 minutes of continuous activity, and completing it is journaled', async () => {
  const start = now;
  // Typing every 4 minutes for 52 minutes: one continuous session (pauses under 5 minutes don't count as breaks).
  for (let m = 0; m <= 52; m += 4) {
    now = start + m * 60e3;
    for (const fn of listeners.selection) fn({});
    await tick();
    if (m < 48) assert.equal(breaks().length, 0, `no break yet at ${m} min`);
  }
  assert.equal(breaks().length, 1, 'break screen opened');
  const panel = breaks()[0];
  const info = JSON.parse(decodeURIComponent(panel.webview.html.match(/data-info="([^"]+)"/)[1]));
  assert.equal(info.kind, 'stretch');
  assert.ok(info.focused >= 50);
  assert.match(panel.webview.html, /break\.js/);
  await panel.send({ type: 'done', completed: true });
  assert.ok(journal().some((e) => e.type === 'break'));

  // Right after a break, no new one for a while.
  now += 10 * 60e3;
  for (const fn of listeners.selection) fn({});
  await tick();
  assert.equal(breaks().length, 1, 'no new break right after one');
});

test('a focus session counts down in the status bar and ends with a break', async () => {
  const before = vs.panels.filter((p) => p.viewType === 'ajwain.break').length;
  await vs.api.commands.executeCommand('ajwain.focus');
  now += 25 * 60e3 + 1000;
  await tick();
  assert.equal(vs.panels.filter((p) => p.viewType === 'ajwain.break').length, before + 1, 'break after the session');
  assert.ok(journal().some((e) => e.type === 'focus' && e.minutes === 25));
  const panel = vs.panels.filter((p) => p.viewType === 'ajwain.break').at(-1);
  const info = JSON.parse(decodeURIComponent(panel.webview.html.match(/data-info="([^"]+)"/)[1]));
  assert.equal(info.pomodoro, true);
  await panel.send({ type: 'snooze', minutes: 10 });
});

test('fun commands open the board with the right intent; the shutdown reminder offers Wind down', async () => {
  const intent = async (cmd) => {
    board()?.dispose();
    await vs.api.commands.executeCommand(cmd);
    return (await board().call('init')).intent;
  };
  assert.deepEqual(await intent('ajwain.windDown'), { view: 'today', shutdown: true });
  assert.deepEqual(await intent('ajwain.wrapped'), { view: 'today', wrapped: true });
  assert.deepEqual(await intent('ajwain.luckyDip'), { view: 'today', lucky: true });

  const d = new Date(realNow() - 60e3); // the scheduler reads the wall clock (new Date())
  vs.settings.set('ajwain.reminders.schedule', [{ time: `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, action: 'shutdown', days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] }]);
  vs.answers.push('Wind down');
  board()?.dispose();
  await tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(vs.messages.some((m) => /wind down/i.test(m.msg) && m.items.includes('Wind down')), 'reminder shown');
  assert.deepEqual((await board().call('init')).intent, { view: 'today', shutdown: true });
});

test('the server: the CLI is told where it is; changing it signs you out; the first sign-in asks for it', async () => {
  const cfg = vs.api.workspace.getConfiguration('ajwain'), G = vs.api.ConfigurationTarget.Global;
  const serverFile = () => JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'ajwain', 'server.json'), 'utf8'));
  assert.deepEqual(serverFile(), { api: mock.url, app: '' });
  await cfg.update('appUrl', 'https://pm.example.com/', G);
  assert.deepEqual(serverFile(), { api: mock.url, app: 'https://pm.example.com' });
  assert.equal(vs.executed.filter((e) => e.name === 'setContext').at(-1).args[1], true, 'still signed in: only the web address changed');

  // No server at all: signed out, and commands explain.
  await cfg.update('apiUrl', '', G);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(vs.executed.filter((e) => e.name === 'setContext').at(-1).args, ['ajwain.signedIn', false]);
  assert.equal(await ctx.secrets.get('ajwain.tokens'), undefined, 'the old login is gone');
  // Sign in asks for the address first, remembers it, and signs in there.
  vs.answers.push(`${mock.url}/`, 'sam', 'secret');
  await vs.api.commands.executeCommand('ajwain.signIn');
  assert.equal(cfg.get('apiUrl'), mock.url);
  assert.deepEqual(vs.executed.filter((e) => e.name === 'setContext').at(-1).args, ['ajwain.signedIn', true]);
  assert.equal((await board()?.call('init'))?.me.username ?? 'sam', 'sam');
});

test('carry-over: import.json in the storage folder was applied once at start-up, then removed', async () => {
  assert.equal(fs.existsSync(path.join(tmp, 'storage', 'import.json')), false);
  assert.deepEqual(ctx.globalState.get('ajwain.tomorrow'), { key: 'OG-1730', note: 'carried over', date: '2026-01-01' });
  assert.equal(ctx.globalState.get('other.thing'), undefined, "only Ajwain's own keys");
  const cfg = vs.api.workspace.getConfiguration('ajwain');
  assert.equal(cfg.get('branchTemplate'), '{key}-{slug}');
  assert.equal(cfg.get('breaks.every'), 50, 'a setting you already have wins');
});

test('Zoho People switched off: no timer, no Workday box, no commands or settings, and a stored sign-in is never used', { skip: ATTENDANCE }, async () => {
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pj.contributes.commands.filter((c) => /punch|zoho/i.test(c.command)), [], 'no attendance commands');
  assert.deepEqual(Object.keys(pj.contributes.configuration.properties).filter((k) => /attendance|zoho/.test(k)), [], 'no attendance settings');
  const parked = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'attendance.contributes.json'), 'utf8'));
  assert.equal(parked.commands.length, 3, 'parked, ready to put back');
  assert.ok(!vs.statusBars.find((b) => b.command === 'ajwain.punch')?.visible, 'no timer in the status bar');
  await vs.api.commands.executeCommand('ajwain.openBoard');
  const panel = vs.panels.findLast((p) => p.viewType === 'ajwain.board');
  assert.equal(await panel.call('attendance'), null, 'no Workday box');
  assert.equal(await panel.call('punchByHand', 'in'), null, 'its button does nothing');
  now = new Date(realNow()).setHours(10, 0, 0, 0);
  vs.focusWindow(false);
  vs.focusWindow(true);
  await tick();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await ctx.secrets.get('ajwain.zoho') !== undefined, true, 'the sign-in is kept for later');
  assert.deepEqual([zoho.reads ?? 0, zoho.punches.length], [0, 0], 'Zoho is never called');
  assert.ok(!vs.messages.some((m) => /Zoho People/.test(m.msg)), 'no pop-up');
});

test('Zoho People: connect; in at 09:00 and out at 18:00 by the clock; the timer ticks; a late start is punched in at the real time', whenOn, async () => {
  const bar = () => vs.statusBars.find((b) => b.command === 'ajwain.punch');
  const day = (d, h, m = 0) => { const t = new Date(realNow()); t.setDate(t.getDate() + d); t.setHours(h, m, 0, 0); return t.getTime(); };
  now = day(0, 8, 40);
  vs.settings.set('ajwain.attendance.punchIn', 'auto'); // the default asks; this test is the clock's
  assert.equal(bar().visible, false, 'nothing to show before connecting');
  // Connect: data centre, "I have them", client id, secret, a stale code first.
  vs.answers.push((items) => items.find((i) => i.k === 'in'), 'I have them', 'client-id', 'client-secret', 'stale-code', 'sam@example.com');
  await vs.api.commands.executeCommand('ajwain.zohoConnect');
  assert.ok(vs.messages.some((m) => m.level === 'error' && /code was wrong or expired/.test(m.msg)), 'a stale code explains itself');
  vs.answers.push((items) => items.find((i) => i.k === 'in'), 'I have them', 'client-id', 'client-secret', 'good-code', 'sam@example.com');
  await vs.api.commands.executeCommand('ajwain.zohoConnect');
  assert.equal(JSON.parse(await ctx.secrets.get('ajwain.zoho')).refresh, 'zrt', 'the refresh token is in the secret store');
  assert.match(vs.messages.at(-1).msg, /You're punched out\. Punch-in: automatically at 09:00 · punch-out: automatically at 18:00/);
  assert.deepEqual([bar().visible, bar().text], [true, '$(circle-large-outline) Out']);

  // 08:59: nothing. 09:00: in.
  now = day(0, 8, 59);
  await tick();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(zoho.punches.length, 0, 'not before 09:00');
  now = day(0, 9, 0);
  await tick();
  await until(() => zoho.punches.length === 1, 'the 09:00 punch-in');
  assert.deepEqual(zoho.punches[0], { dateFormat: 'dd/MM/yyyy HH:mm:ss', checkIn: zohoTime(new Date(now)), emailId: 'sam@example.com' });
  // The status bar timer counts while you're in.
  now = day(0, 11, 30, 0) + 7000;
  await tick(); // the 1s ticker is captured with the scheduler's
  await until(() => bar().text === '$(pass-filled) In 2:30:07', `the timer (${bar().text})`);
  // The webviews were told, for the Workday box.
  assert.ok(board()?.outbox.some((m) => m.type === 'attendance' && m.attendance.in === true) ?? true);

  // No activity rules any more: hours with nothing happening change nothing.
  now = day(0, 16, 0);
  await tick();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(zoho.punches.length, 1, 'still in');

  // 18:00: out, at 18:00, even if Ajwain only gets to it at 18:40.
  now = day(0, 18, 40);
  await tick();
  await until(() => zoho.punches.length === 2, 'the 18:00 punch-out');
  assert.equal(zoho.punches[1].checkOut, zohoTime(new Date(day(0, 18, 0))));
  await until(() => bar().text.startsWith('$(circle-large-outline) Out · 9:00'), `Out with the day's total (${bar().text})`);

  // Tomorrow VS Code starts at 10:15: punched in at 10:15, not backdated to 09:00.
  now = day(1, 10, 15);
  await tick();
  await until(() => zoho.punches.length === 3, 'the late punch-in');
  assert.equal(zoho.punches[2].checkIn, zohoTime(new Date(day(1, 10, 15))));
});

test('Zoho People: punches only by a person; your punch-out sticks; a punch on the Zoho app is respected; a missed punch-out is asked about', whenOn, async () => {
  const bar = () => vs.statusBars.find((b) => b.command === 'ajwain.punch');
  const day = (d, h, m = 0) => { const t = new Date(realNow()); t.setDate(t.getDate() + d); t.setHours(h, m, 0, 0); return t.getTime(); };
  // There is no command that punches by itself: only the menu, where a person picks.
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pj.contributes.commands.filter((c) => /punch/i.test(c.command)).map((c) => c.command), ['ajwain.punch']);
  vs.answers.push(undefined); // a script runs the command: the menu opens, nobody picks, nothing happens
  await vs.api.commands.executeCommand('ajwain.punch');
  assert.equal(zoho.punches.length, 3);

  // A person picks "Punch out now" at lunch: out, and the schedule doesn't punch them back in today.
  now = day(1, 13, 0);
  vs.answers.push((items) => items.find((i) => i.a === 'out'));
  await vs.api.commands.executeCommand('ajwain.punch');
  assert.ok(zoho.punches[3].checkOut);
  now = day(1, 13, 30);
  await tick();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(zoho.punches.length, 4, 'stays out: back in is yours');

  // Back in on the Zoho app: Ajwain sees it at the next check, doesn't punch again, and the Workday button works.
  zoho.entries.push({ in: new Date(day(1, 14, 0)), out: null });
  now = day(1, 14, 20);
  await tick();
  await until(() => bar().text.startsWith('$(pass-filled) In'), 'In, from the Zoho app');
  await vs.api.commands.executeCommand('ajwain.openBoard');
  const panel = vs.panels.findLast((p) => p.viewType === 'ajwain.board');
  assert.equal((await panel.call('attendance')).in, true);
  assert.equal(await panel.call('punchByHand', 'sideways'), null, 'only "in" or "out"');
  const after = await panel.call('punchByHand', 'out'); // the Workday box's button, clicked
  assert.equal(after.in, false);
  assert.equal(zoho.punches.length, 5);

  // Punched in by hand in the evening, then VS Code isn't running at 18:00 and starts the next morning:
  // Ajwain doesn't decide when you left. It asks.
  vs.answers.push((items) => items.find((i) => i.a === 'in'));
  now = day(1, 17, 0);
  await vs.api.commands.executeCommand('ajwain.punch');
  assert.equal(zoho.punches.length, 6);
  now = day(2, 9, 30);
  vs.answers.push((items) => items.find((i) => /^Punch out at 18:00/.test(i)));
  await tick();
  await until(() => zoho.punches.length === 7, 'the punch-out the person chose');
  assert.equal(zoho.punches[6].checkOut, zohoTime(new Date(day(1, 18, 0))));
  assert.ok(vs.messages.some((m) => /still punched in to Zoho People since .*VS Code wasn't running at 18:00/.test(m.msg)));
  assert.deepEqual([...zoho.emails], ['sam@example.com']);

  await vs.api.commands.executeCommand('ajwain.zohoDisconnect');
  assert.equal(await ctx.secrets.get('ajwain.zoho'), undefined);
  assert.equal(bar().visible, false);
});

test('Zoho People, ask mode: a pop-up when you open VS Code, once a day; punch-out asked from 18:00; nothing without a click', whenOn, async () => {
  const day = (d, h, m = 0) => { const t = new Date(realNow()); t.setDate(t.getDate() + d); t.setHours(h, m, 0, 0); return t.getTime(); };
  const asks = () => vs.messages.filter((m) => /Punch (in to|out of) Zoho People\?/.test(m.msg));
  const quiet = () => new Promise((r) => setTimeout(r, 150));
  vs.settings.set('ajwain.attendance.punchIn', 'ask');
  vs.settings.set('ajwain.attendance.punchOut', 'ask');
  now = day(3, 5, 0);
  vs.answers.push((items) => items.find((i) => i.k === 'in'), 'I have them', 'client-id', 'client-secret', 'good-code', 'sam@example.com');
  await vs.api.commands.executeCommand('ajwain.zohoConnect');
  assert.match(vs.messages.at(-1).msg, /Punch-in: ask me when VS Code opens · punch-out: ask me at 18:00/);
  const base = zoho.punches.length;
  await tick();
  await quiet();
  assert.equal(asks().length, 0, '05:00 is too early to ask');

  // 08:00, VS Code open but you're elsewhere: not asked. You come back: asked at once. "Not today": nothing punched.
  vs.focusWindow(false);
  now = day(3, 8, 0);
  await tick();
  await quiet();
  assert.equal(asks().length, 0, 'not asked while you are away from the window');
  vs.answers.push((items) => items.find((i) => i.title === 'Not today'));
  vs.focusWindow(true);
  await until(() => asks().length === 1, 'the pop-up on coming back');
  assert.match(asks()[0].msg, /^Good morning, \w+\. Punch in to Zoho People\?$/);
  assert.deepEqual(asks()[0].items.map((i) => i.title), ['Punch in', 'Not today']);
  now = day(3, 8, 30);
  await tick();
  await quiet();
  assert.deepEqual([asks().length, zoho.punches.length], [1, base], 'asked once a day; nothing punched');

  // The next morning: "Punch in", at the real time. From 18:00 the punch-out is asked, and done when you click.
  now = day(4, 7, 30);
  vs.answers.push((items) => items.find((i) => i.title === 'Punch in'));
  await tick();
  await until(() => zoho.punches.length === base + 1, 'the punch-in you clicked');
  assert.equal(zoho.punches.at(-1).checkIn, zohoTime(new Date(day(4, 7, 30))));
  now = day(4, 17, 59);
  await tick();
  await quiet();
  assert.equal(asks().length, 2, 'not before 18:00');
  now = day(4, 18, 20);
  vs.answers.push((items) => items.find((i) => i.title === 'Punch out'));
  await tick();
  await until(() => zoho.punches.length === base + 2, 'the punch-out you clicked');
  assert.match(asks().at(-1).msg, /^Your day ends at 18:00\. Punch out of Zoho People\?$/);
  assert.equal(zoho.punches.at(-1).checkOut, zohoTime(new Date(day(4, 18, 20))));

  // Zoho refuses: the reason is shown in words, Zoho's reply goes to the log, and Zoho is left alone for 5 minutes.
  assert.deepEqual([zoho.query.emailId, zoho.query.dateFormat], ['sam@example.com', 'yyyy-MM-dd']);
  zoho.fail = true;
  const reads = zoho.reads;
  now = day(4, 19, 0); // over 15 minutes on: time to check with Zoho
  await tick();
  await until(() => vs.messages.some((m) => m.msg === 'Ajwain: Zoho People: Please specify a valid date'), 'the reason, in words');
  assert.ok(vs.logs.some((l) => /Zoho replied: .*"code":7005/.test(l.text)), "Zoho's reply is in the log");
  now = day(4, 19, 2);
  await tick();
  await quiet();
  assert.equal(zoho.reads, reads + 1, 'not asked again within 5 minutes');
  now = day(4, 19, 6);
  await tick();
  await until(() => zoho.reads === reads + 2, 'asked again after 5 minutes');
  zoho.fail = false;

  // The menu changes either mode.
  vs.answers.push((items) => items.find((i) => i.a === 'punchIn'), (items) => items.find((i) => i.k === 'auto'));
  await vs.api.commands.executeCommand('ajwain.punch');
  assert.equal(vs.settings.get('ajwain.attendance.punchIn'), 'auto');
});
