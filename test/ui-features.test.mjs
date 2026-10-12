// The board's power features, end to end with real key presses: the command palette, keyboard moves on the board,
// quick add, swimlanes (drop to reassign), "since you were last here", the slot machine, the day ruler and the
// live timer, the sprint pulse and workload. Real board.js in headless Chrome, dev/preview.html as the host.
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
const issue = (key) => mock.state.issues.find((i) => i.key === key);
const statusId = (name) => String(mock.state.statuses.find((s) => s.project === issue('OG-1730').project && s.name === name).id);
const statusName = (key) => mock.state.statuses.find((s) => String(s.id) === String(issue(key).status)).name;
const hostCalls = (page, method) => page.eval((m) => window.__host.calls.filter((c) => c.method === m), method);
const focused = (page) => page.eval(() => document.activeElement?.dataset.key ?? document.activeElement?.id ?? document.activeElement?.tagName);
async function open(t, hash) {
  mock.reset();
  const page = await browser.page(`${mock.url}/dev/preview.html?ui=${++run}#${hash}`);
  t.after(() => page.close());
  await page.waitFor(() => document.querySelectorAll('#project option').length > 1 && !document.querySelector('#view .skeleton'), { timeout: 15000 });
  return page;
}
async function clean(page) {
  await sleep(200);
  assert.deepEqual(await page.eval(() => window.__host.errors), [], 'webview reported errors');
  assert.deepEqual(page.consoleErrors, [], 'console errors or uncaught exceptions');
  assert.deepEqual(await page.eval(() => [...document.querySelectorAll('.toast.error')].map((e) => e.textContent)), [], 'error toasts');
}

it('command palette: Ctrl+K, a ticket number and Enter opens it; commands run by name; Shift+Enter starts work', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  await page.press('k', { ctrl: true });
  await page.waitFor('#pal-q');
  assert.equal(await focused(page), 'pal-q');
  await page.type('1736');
  await page.waitFor(() => document.querySelector('.pal-row.on')?.textContent.includes('OG-1736'));
  await page.press('Enter');
  await page.waitFor(() => document.querySelector('.drawer .title-input')?.value);
  assert.equal(await page.eval(() => document.querySelector('.drawer .title-input').value), issue('OG-1736').title);
  assert.equal(await page.eval(() => document.querySelector('#palette').innerHTML), '', 'the palette closed');
  await page.press('Escape');
  await page.waitFor(() => !document.querySelector('.drawer'));

  await page.click('[data-act=palette]');
  await page.type('go to sprints');
  await page.press('Enter');
  await page.waitFor('[data-view=sprints][aria-pressed=true]');

  await page.press('k', { ctrl: true });
  await page.type('OG-1734');
  await page.waitFor(() => document.querySelector('.pal-row.on')?.textContent.includes('Holiday calendar'));
  await page.press('ArrowDown');
  await page.press('ArrowUp');
  await page.press('Enter', { shift: true });
  await until(async () => (await hostCalls(page, 'startWork')).some((c) => c.args[0]?.key === 'OG-1734'), 'start work on OG-1734');
  await clean(page);
});

it('board keys: arrows walk the cards, Shift+→ moves the card to the next status and keeps focus, 1–5 switch views, ? lists shortcuts', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  await page.eval(() => document.querySelector('.card[data-key="OG-1734"]').focus());
  await page.press('ArrowDown');
  assert.equal(await focused(page), 'OG-1736');
  await page.press('ArrowRight');
  assert.equal(await page.eval(() => document.activeElement.closest('.col').dataset.value), statusId('In Progress'));
  await page.press('ArrowLeft');
  assert.equal(await focused(page), 'OG-1736');
  await page.press('ArrowRight', { shift: true });
  await until(() => statusName('OG-1736') === 'In Progress', 'OG-1736 moved to In Progress');
  await until(async () => (await focused(page)) === 'OG-1736', 'focus stays on the moved card');
  assert.equal(await page.eval(() => document.activeElement.closest('.col').dataset.value), statusId('In Progress'));
  await page.press('3');
  await page.waitFor('[data-view=list][aria-pressed=true]');
  await page.press('?', { shift: true });
  await page.waitFor('.modal.keys');
  assert.ok(await page.eval(() => document.querySelectorAll('.keys-grid .kbd').length >= 8));
  await page.press('Escape');
  await page.waitFor(() => !document.querySelector('.modal.keys'));
  await clean(page);
});

it('quick add: a title and Enter creates the issue in that column and the active sprint, assigned to me; the input stays for the next', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  const todo = statusId('To Do');
  await page.click(`.col[data-value="${todo}"] [data-act=quick]`);
  await page.waitFor('form[data-form=quick] input');
  assert.equal(await page.eval(() => document.activeElement.closest('form')?.dataset.form), 'quick');
  await page.type('Rate-limit the export endpoint');
  await page.press('Enter');
  const made = await until(() => mock.state.issues.find((i) => i.title === 'Rate-limit the export endpoint'), 'issue created');
  assert.equal(String(made.status), todo);
  assert.equal(made.assignee, mock.state.me);
  assert.equal(String(made.sprint), String(mock.state.sprints.find((s) => s.name === 'Sprint 14').id));
  await page.waitFor((k) => document.querySelector(`.col .card[data-key="${k}"]`) && document.activeElement.closest('form')?.dataset.form === 'quick', { args: [made.key] });
  assert.equal(await page.eval(() => document.querySelector('form[data-form=quick] input').value), '');
  assert.equal(await page.eval((k) => document.querySelector(`.card[data-key="${k}"] .flag`)?.title, made.key), 'You just created this', 'flagged as just made, not as a change by someone else');
  await page.press('Escape');
  await page.waitFor(() => !document.querySelector('form[data-form=quick]'));
  await clean(page);
});

it('swimlanes by assignee: me first; a drop in another lane and column reassigns and moves in one PATCH; lanes collapse and persist', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  await page.select('[data-change=lanes]', 'assignee');
  await page.waitFor('.lanes .lane-head');
  const me = mock.state.me, prog = statusId('In Progress');
  const lanes = await page.eval(() => [...document.querySelectorAll('.lane-head')].map((b) => b.dataset.lane));
  assert.equal(lanes[0], `assignee:${me}`);
  assert.equal(lanes.at(-1), 'assignee:', 'Unassigned comes last');
  const before = mock.log.length;
  await page.eval((key, lane, st) => {
    const dt = new DataTransfer();
    document.querySelector(`.card[data-key="${key}"]`).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const zone = document.querySelector(`.cell[data-lane-value="${lane}"][data-value="${st}"]`);
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, 'OG-1736', me, prog);
  await until(() => issue('OG-1736').assignee === me && String(issue('OG-1736').status) === prog, 'reassigned and moved');
  const patches = mock.log.slice(before).filter((l) => l.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(Object.keys(patches[0].body).sort(), ['assignee', 'status']);
  await page.waitFor((m, st) => document.querySelector(`.cell[data-lane-value="${m}"][data-value="${st}"] .card[data-key="OG-1736"]`), { args: [me, prog] });

  await page.click(`.lane-head[data-lane="assignee:${me}"]`);
  await page.waitFor((m) => document.querySelector(`.lane-head[data-lane="assignee:${m}"]`).closest('.lane').matches('.shut:not(:has(.lane-row))'), { args: [me] });
  await until(async () => (await hostCalls(page, 'save')).at(-1)?.args[0].lanes === 'assignee', 'lanes saved');
  await clean(page);
});

it('since you were last here: changes are flagged on cards and listed; my own change is not news; Mark all seen clears it', async (t) => {
  const page = await open(t, 'view=board&project=OG&since');
  await page.waitFor('details.since');
  const flags = () => page.eval(() => Object.fromEntries([...document.querySelectorAll('.card .flag')].map((f) => [f.closest('.card').dataset.key, f.classList[1]])));
  assert.deepEqual(await flags(), { 'OG-1730': 'edited', 'OG-1733': 'moved', 'OG-1736': 'assigned', 'OG-1740': 'new' });
  await page.click('details.since > summary .label');
  await page.waitFor('details.since[open] .since-row');
  assert.match(await page.text('.since-row:has(.flag.moved)'), /In Progress → Done/);
  assert.match(await page.text('.since-row:has(.flag.assigned)'), /Sam Lee → Nia Shah/);

  // Moving a ticket myself doesn't flag it.
  await page.eval(() => document.querySelector('.card[data-key="OG-1734"]').focus());
  await page.press('ArrowRight', { shift: true });
  await until(() => statusName('OG-1734') === 'In Progress', 'moved');
  await sleep(150);
  assert.equal((await flags())['OG-1734'], undefined);

  await page.click('[data-act=mark-seen]');
  await page.waitFor(() => !document.querySelector('details.since') && !document.querySelector('.card .flag'));
  const pid = String(issue('OG-1730').project);
  const saved = await until(async () => (await hostCalls(page, 'save')).map((c) => c.args[0]).findLast((s) => s.snaps?.[pid]?.issues['OG-1740']), 'snapshot saved');
  assert.deepEqual(saved.snaps[pid].issues['OG-1734'].slice(0, 2), [statusId('In Progress'), '']);
  await clean(page);
});

it('lucky dip: the machine lands with odds and a payout; a held reel survives Space-to-spin-again', async (t) => {
  const page = await open(t, 'view=today');
  await page.click('[data-act=lucky]');
  assert.equal(await page.eval(() => document.querySelector('[data-act=lucky-start]').disabled), true, 'no starting mid-spin');
  await page.waitFor('.casino.landed', { timeout: 8000 });
  assert.match(await page.text('.meter:nth-child(2) b'), /^\d+%$/);
  // ESG-11 is a medium task with a 4h estimate, due in five days: a plain win, worth 300 points.
  assert.equal(await page.text('.payout b'), 'Nice pick');
  assert.ok(await page.eval(() => document.querySelector('.casino').classList.contains('win') && !!document.querySelector('.rays')), 'win lights');
  await until(async () => (await page.text('#win')) === '0300', 'the WIN meter counts up to the payout');
  assert.match(await page.text('.led'), /[A-Z]+-\d+ · /);
  await page.click('[data-act=lucky-hold][data-reel="1"]');
  await page.waitFor('.hold.on');
  await page.press(' ');
  await page.waitFor(() => !document.querySelector('.casino.landed'));
  await page.waitFor('.casino.landed', { timeout: 8000 });
  assert.match(await page.text('.sign-side'), /spin 02/i);
  assert.equal(await page.eval(() => document.querySelectorAll('.hold.on').length), 1, 'the priority hold is kept');
  // The machine is loud unless you mute it, and remembers that you did.
  assert.match(await page.eval(() => document.querySelector('[data-act=lucky-sound]').title), /on/);
  await page.click('[data-act=lucky-sound]');
  assert.equal((await hostCalls(page, 'save')).at(-1).args[0].sound, false);
  await page.click('[data-act=lucky-start]');
  await until(async () => (await hostCalls(page, 'startWork')).length, 'started');
  await clean(page);
});

it('lucky dip with an empty queue offers the sprint\'s unassigned work, up for grabs', async (t) => {
  const page = await open(t, 'view=today&project=OG');
  await page.click('[data-act=lucky]');
  await page.waitFor('.casino.landed', { timeout: 8000 });
  assert.match(await page.text('.sign-side'), /up for grabs/i);
  assert.match(await page.text('.led'), /OG-1734/);
  await clean(page);
});

it('Today: the day ruler plots the commits and now; the top bar shows a running timer with a live clock and stops it', async (t) => {
  const page = await open(t, 'view=today&open=OG-1730');
  assert.equal(await page.eval(() => document.querySelectorAll('.ruler .tick').length), 5);
  assert.ok(await page.eval(() => !!document.querySelector('.ruler .now') && document.querySelectorAll('.ruler .flow').length >= 1));
  await page.click('[data-act=timer]');
  await page.waitFor('#nowbar .nowbar');
  assert.equal(await page.text('#nowbar .key'), 'OG-1730');
  const first = await page.text('#now-clock');
  assert.match(first, /^0:00:0\d$/);
  await until(async () => (await page.text('#now-clock')) !== first, 'clock ticks', 3000);
  await page.click('.now-stop');
  await page.waitFor(() => !document.querySelector('#nowbar .nowbar'));
  await clean(page);
});

it('sprints: workload per person against capacity, and the sprint pulse counts the days', async (t) => {
  const page = await open(t, 'view=sprints&project=OG');
  await page.waitFor('.workload .wl-row');
  const rows = await page.eval(() => [...document.querySelectorAll('.wl-row .wl-name')].map((e) => e.textContent));
  assert.equal(rows[0], 'Sam Lee', 'most work left first');
  assert.ok(rows.includes('Unassigned'));
  assert.ok(await page.eval(() => !!document.querySelector('.wl-row .cap')), 'capacity marker');
  assert.equal(await page.eval(() => document.querySelectorAll('.pulse .days i').length), 14);
  assert.equal(await page.eval(() => [...document.querySelectorAll('.pulse .days i')].findIndex((i) => i.classList.contains('now'))), 7);
  assert.match(await page.text('.pulse b'), /^7d left$/);
  await clean(page);
});

it('my work: assigned, reported and recently done tabs; the attention strip narrows the list; group by due date', async (t) => {
  const page = await open(t, 'view=mine');
  await page.waitFor('.attention .attn');
  const me = mock.state.me;
  const mineOpen = mock.state.issues.filter((i) => i.assignee === me && !/^HOME/.test(i.key) && statusName(i.key) !== 'Done');
  assert.equal(await page.eval(() => document.querySelectorAll('#view tbody tr').length), mineOpen.length);
  assert.equal(await page.eval(() => [...document.querySelectorAll('#view th')].some((th) => th.dataset.key === 'assignee')), false, 'no Assignee column on my own work');
  // Attention: overdue narrows to OG-1732, clicking again shows all.
  await page.click('.attn-overdue');
  await page.waitFor(() => document.querySelectorAll('#view tbody tr').length === 1);
  assert.match(await page.text('#view tbody tr'), /OG-1732/);
  await page.click('.attn-overdue');
  await page.waitFor((n) => document.querySelectorAll('#view tbody tr').length === n, { args: [mineOpen.length] });
  // Group by due date.
  await page.select('[data-change=mine-group]', 'due');
  await page.waitFor(() => [...document.querySelectorAll('.group-title')].map((g) => g.textContent).join('|').includes('Overdue'));
  // Reported by me: open issues I filed, with an Assignee column.
  await page.click('[data-act=mine-tab][data-tab=reported]');
  const reported = mock.state.issues.filter((i) => i.reporter === me && !/^HOME/.test(i.key) && statusName(i.key) !== 'Done').map((i) => i.key).sort();
  await page.waitFor(() => document.querySelector('[data-tab=reported].on'));
  assert.deepEqual((await page.eval(() => [...document.querySelectorAll('#view tbody tr .key')].map((k) => k.textContent))).sort(), reported);
  assert.ok(await page.eval(() => [...document.querySelectorAll('#view th')].some((th) => th.dataset.key === 'assignee')));
  // Done, last 14 days: OG-1738 (mine, resolved two days ago).
  await page.click('[data-act=mine-tab][data-tab=done]');
  await page.waitFor(() => document.querySelector('[data-tab=done].on'));
  assert.deepEqual(await page.eval(() => [...document.querySelectorAll('#view tbody tr .key')].map((k) => k.textContent)), ['OG-1738']);
  assert.match(await page.text('.attention'), /done in 14 days/i);
  await until(async () => (await hostCalls(page, 'save')).at(-1)?.args[0].mineTab === 'done', 'tab remembered');
  await clean(page);
});

it('sorting and columns: sort by recently updated or newest everywhere; add Created, drop Sprint; headers sort newest first', async (t) => {
  const page = await open(t, 'view=list&project=OG');
  const keys = () => page.eval(() => [...document.querySelectorAll('#view tbody tr .key')].map((k) => k.textContent));
  const by = (field, dir) => [...mock.state.issues].filter((i) => /^OG-/.test(i.key) && String(i.sprint) === String(mock.state.sprints.find((s) => s.name === 'Sprint 14').id))
    .sort((a, b) => (Date.parse(a[field]) - Date.parse(b[field])) * dir).map((i) => i.key);
  await page.select('[data-change=sort]', 'updated:-1');
  await until(async () => JSON.stringify(await keys()) === JSON.stringify(by('updated_at', -1)), 'recently updated first');
  await page.select('[data-change=sort]', 'created:1');
  await until(async () => JSON.stringify(await keys()) === JSON.stringify(by('created_at', 1)), 'oldest first');

  await page.click('[data-act=menu][data-key=columns]');
  await page.click('.pop input[data-change=column][value=created]');
  await page.click('.pop input[data-change=column][value=sprint]');
  await page.waitFor(() => document.querySelector('th[data-key=created]') && !document.querySelector('th[data-key=sprint]'));
  await page.click('th[data-key=created]');
  await until(async () => JSON.stringify(await keys()) === JSON.stringify(by('created_at', -1)), 'header sorts newest first');
  assert.match(await page.text('th[data-key=created]'), /↓/);
  const saved = (await hostCalls(page, 'save')).at(-1).args[0];
  assert.ok(saved.columns.includes('created') && !saved.columns.includes('sprint'));
  assert.deepEqual(saved.sort, { key: 'created', dir: -1 });

  // The same order applies to the board's cards.
  await page.press('2');
  await page.waitFor('.col .card');
  const todo = await page.eval(() => [...document.querySelector('.col').querySelectorAll('.card')].map((c) => c.dataset.key));
  assert.deepEqual(todo, by('created_at', -1).filter((k) => statusName(k) === 'To Do'));
  await clean(page);
});

it('sidebar Home: numbers, my issues by urgency; filter, fold, open, timer, tiles, palette and scope all work', async (t) => {
  mock.reset();
  const page = await browser.page(`${mock.url}/dev/preview.html?ui=${++run}#side&project=OG`);
  t.after(() => page.close());
  await page.waitFor('.issue', { timeout: 15000 });
  const keys = () => page.eval(() => [...document.querySelectorAll('.issue')].map((r) => r.dataset.key));
  assert.deepEqual(await keys(), ['OG-1732', 'OG-1730', 'OG-1740', 'OG-1735'], 'overdue first, then priority, then due date');
  assert.equal(await page.text('.cell.late b'), '1');
  assert.ok(await page.eval(() => !!document.querySelector('.side-pulse .days i.today')), 'sprint pulse');

  await page.press('/');
  await page.type('time');
  await page.waitFor(() => document.querySelectorAll('.issue').length === 1);
  assert.deepEqual(await keys(), ['OG-1740']);
  await page.press('Escape');
  await page.waitFor(() => document.querySelectorAll('.issue').length === 4);

  await page.click('.grp-head');
  await page.waitFor(() => !document.querySelector('.issue'));
  await page.click('.grp-head');
  await page.waitFor('.issue');

  const calls = (m) => hostCalls(page, m).then((cs) => cs.map((c) => c.args[0]));
  await page.click('.issue[data-key="OG-1730"] .issue-title');
  await page.click('.tile[data-view=board]');
  await page.click('.tile.lucky');
  await page.click('.dock [data-act=palette]');
  assert.deepEqual(await calls('openBoard'), [{ key: 'OG-1730' }, { view: 'board' }, { view: 'today', lucky: true }, { palette: true }]);
  await page.click('.issue[data-key="OG-1735"] [data-act=more]');
  assert.deepEqual(await calls('actions'), [{ key: 'OG-1735' }]);

  await page.click('.issue[data-key="OG-1730"] [data-act=timer]');
  await page.waitFor('.now');
  assert.equal(await page.text('.now .key'), 'OG-1730');
  assert.ok(await page.eval(() => document.querySelector('.issue[data-key="OG-1730"]').classList.contains('live')));
  await page.click('.now-stop');
  await page.waitFor(() => !document.querySelector('.now'));

  await page.select('#scope', '');
  assert.deepEqual((await calls('setScope')).at(-1), { project: '' });
  await page.waitFor(() => document.querySelector('.issue[data-key="ESG-11"]'), { timeout: 8000 });
  await clean(page);
});

it('lucky dip moods: a bug gets the sad treatment, an urgent ticket the jackpot, a small one easy money', async (t) => {
  const land = async (changes) => {
    mock.reset();
    Object.assign(issue('ESG-11'), changes);
    const page = await browser.page(`${mock.url}/dev/preview.html?ui=${++run}#view=today`);
    t.after(() => page.close());
    await page.waitFor(() => document.querySelectorAll('#project option').length > 1 && !document.querySelector('#view .skeleton'), { timeout: 15000 });
    await page.click('[data-act=lucky]');
    await page.waitFor('.casino.landed', { timeout: 9000 });
    const seen = await page.eval(() => ({
      mood: [...document.querySelector('.casino').classList].find((c) => ['jackpot', 'big', 'win', 'easy', 'bug'].includes(c)),
      title: document.querySelector('.payout b').textContent, line: document.querySelector('.payout span').textContent, led: document.querySelector('.led').textContent,
      rays: !!document.querySelector('.rays'), chips: document.querySelectorAll('.fx.chips i').length, bugs: document.querySelectorAll('.fx.bugs i').length,
    }));
    await clean(page);
    return seen;
  };
  const bug = await land({ issue_type: 'BUG', priority: 'HIGH' });
  assert.deepEqual([bug.mood, bug.title, bug.rays, bug.chips], ['bug', 'Uh-oh, a bug', false, 0]);
  assert.match(bug.line, /big one/i);
  assert.match(bug.led, /^Bug alert · ESG-11/);
  assert.ok(bug.bugs > 10, 'bugs rain down');
  const jackpot = await land({ priority: 'HIGHEST' });
  assert.deepEqual([jackpot.mood, jackpot.title, jackpot.rays, jackpot.bugs], ['jackpot', 'Jackpot!', true, 0]);
  assert.ok(jackpot.chips > 100, 'a jackpot rains chips');
  const easy = await land({ priority: 'LOW', estimate_minutes: 30 });
  assert.deepEqual([easy.mood, easy.title], ['easy', 'Easy money']);
  assert.ok(easy.chips > 0 && easy.chips < jackpot.chips);
});

it("slot machine sounds, rendered by Chrome's audio engine: every cue is audible, nothing clips, a jackpot rings longest", async (t) => {
  const page = await open(t, 'view=today');
  const heard = await page.eval(async () => {
    const { createSfx, SFX_CUES } = await import('/media/sfx.mjs');
    const out = {};
    for (const cue of SFX_CUES) {
      let ctx;
      class Offline extends OfflineAudioContext { constructor() { super(1, 44100 * 6, 44100); ctx = this; } }
      createSfx(() => true, Offline)(cue, 1);
      const d = (await ctx.startRendering()).getChannelData(0);
      let peak = 0, last = 0;
      for (let k = 0; k < d.length; k++) { const a = Math.abs(d[k]); if (a > peak) peak = a; if (a > 0.004) last = k; }
      out[cue] = { peak, secs: last / 44100 };
    }
    return out;
  });
  // The limiter's ceiling is 0.94: no cue can clip, however the random noise in it falls.
  for (const [cue, { peak }] of Object.entries(heard)) assert.ok(peak > 0.05 && peak <= 0.945, `${cue} peaks at ${peak.toFixed(3)}`);
  for (const cue of ['win', 'easy', 'big', 'jackpot', 'bug']) assert.ok(heard[cue].peak > 0.6, `${cue} is loud (${heard[cue].peak.toFixed(2)})`);
  assert.ok(heard.jackpot.secs > 4 && heard.jackpot.secs > heard.big.secs && heard.big.secs > heard.win.secs, JSON.stringify(heard));
  assert.ok(heard.bug.secs > 2.5, 'three poings, then the trombone droops for a while');
  await clean(page);
});

it('a move the server refuses (estimate first) snaps back, explains itself in plain words and links to the ticket', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  mock.state.estimateFirst = true;
  t.after(() => { mock.state.estimateFirst = false; });
  await page.eval(() => document.querySelector('.card[data-key="OG-1734"]').focus());
  await page.press('ArrowRight', { shift: true }); // OG-1734 has no estimate
  await page.waitFor('.toast.error');
  assert.match(await page.text('.toast.error'), /^Estimate First: add an estimate first\. · Open$/);
  assert.equal(statusName('OG-1734'), 'To Do');
  await page.waitFor((todo) => document.querySelector(`.col[data-value="${todo}"] .card[data-key="OG-1734"]`), { args: [statusId('To Do')] });
  await page.click('.toast.error [data-act=open]');
  await page.waitFor(() => document.querySelector('.drawer .title-input')?.value);
  assert.equal(await page.eval(() => document.querySelector('.drawer [data-field=estimate_minutes]').value), '');
  assert.deepEqual(await page.eval(() => window.__host.errors), [], 'nothing reported as a webview error');
  assert.ok(page.consoleErrors.every((e) => /400 \(Bad Request\)/.test(e)), 'only the refused request itself shows in the console');
});

it('a ticket created on the board appears at once, at the top of its column and flagged New, before the reload is back', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  mock.state.slowList = 1500; // every ticket list takes 1.5s from now on
  t.after(() => { mock.state.slowList = 0; });
  await page.click('[data-act=new]');
  await page.waitFor('form[data-form=create]');
  await page.fill('form[data-form=create] [name=title]', 'Show the export queue length on the dashboard');
  await page.press('Enter', { ctrl: true });
  const made = await until(() => mock.state.issues.find((i) => i.title === 'Show the export queue length on the dashboard'), 'created on the server');
  const started = Date.now();
  await page.waitFor((k) => document.querySelector(`.card[data-key="${k}"]`), { args: [made.key], timeout: 1000 });
  assert.ok(Date.now() - started < 1000, 'shown without waiting for the 1.5s reload');
  const first = await page.eval((st) => document.querySelector(`.col[data-value="${st}"] .card`)?.dataset.key, String(made.status));
  assert.equal(first, made.key, 'first in its column');
  assert.match(await page.text(`.card[data-key="${made.key}"] .flag`), /New/);
  assert.ok(await page.eval((k) => document.querySelector(`.card[data-key="${k}"]`).classList.contains('just-made'), made.key), 'highlighted');
  // When the reload lands, it's still there and still first.
  await until(() => mock.log.filter((l) => l.method === 'GET' && l.path === '/api/issues/').length && page.eval(() => !document.querySelector('.count-label')?.textContent.includes('Loading')), 'reload done');
  await sleep(1700);
  assert.equal(await page.eval((st) => document.querySelector(`.col[data-value="${st}"] .card`)?.dataset.key, String(made.status)), made.key);
  await clean(page);
});

it("a ticket the view's filters would hide says so, with a link to open it", async (t) => {
  const page = await open(t, 'view=board&project=OG'); // the board starts on the active sprint
  await page.click('[data-act=new]');
  await page.waitFor('form[data-form=create]');
  await page.fill('form[data-form=create] [name=title]', 'Write the release notes for October');
  await page.select('form[data-form=create] [name=sprint]', '');
  await page.press('Enter', { ctrl: true });
  await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /filters don't show it/.test(t.textContent)));
  const made = mock.state.issues.find((i) => i.title === 'Write the release notes for October');
  assert.equal(await page.eval((k) => !!document.querySelector(`.card[data-key="${k}"]`), made.key), false);
  await page.click('.toast [data-act=open]');
  await page.waitFor(() => document.querySelector('.drawer .title-input')?.value === 'Write the release notes for October');
  await clean(page);
});

it('changes made on the web app show up when you come back, but never while you are typing', async (t) => {
  const page = await open(t, 'view=board&project=OG');
  // Someone else, on the web app: a new ticket in the sprint, and a rename.
  const og = mock.state.projects.find((p) => p.key === 'OG');
  const todo = mock.state.statuses.find((s) => s.project === og.id && s.name === 'To Do');
  const sprint = mock.state.sprints.find((s) => s.name === 'Sprint 14');
  const proto = issue('OG-1734');
  mock.state.issues.push({ ...proto, id: 'web-made-1', number: 1999, key: 'OG-1999', title: 'Filed on the web app', status: todo.id, sprint: sprint.id, tags: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  Object.assign(issue('OG-1730'), { title: 'Add retry with backoff (renamed on the web)', updated_at: new Date().toISOString() });
  const lists = () => mock.log.filter((l) => l.method === 'GET' && l.path === '/api/issues/').length;
  const later = () => page.eval(() => { const real = Date.now; Date.now = () => real() + 31e3; }); // half a minute on

  // Typing in the filter: a wake does nothing.
  await later();
  await page.eval(() => document.querySelector('#q').focus());
  const before = lists();
  await page.eval(() => window.postMessage({ type: 'wake' }, '*'));
  await sleep(300);
  assert.equal(lists(), before, 'no reload while typing');

  // Back on the board, not typing: it reloads quietly and both changes show.
  await page.eval(() => document.activeElement.blur());
  await page.eval(() => window.postMessage({ type: 'wake' }, '*'));
  await page.waitFor(() => document.querySelector('.card[data-key="OG-1999"]'), { timeout: 8000 });
  assert.match(await page.text('.card[data-key="OG-1730"] .title'), /renamed on the web/);
  assert.equal(await page.eval(() => !!document.querySelector('#view .skeleton')), false, 'no flash of empty board');
  // Woken again straight away: nothing to do, it's fresh.
  const after = lists();
  await page.eval(() => window.postMessage({ type: 'wake' }, '*'));
  await sleep(300);
  assert.equal(lists(), after, 'a fresh board is not reloaded');
  await clean(page);
});

it('a big project stays quick: 200 rows and 100 cards a column are drawn, "Show more" draws the rest, sorting covers all', async (t) => {
  mock.reset();
  const proto = issue('OG-1734');
  for (let n = 0; n < 450; n++) mock.state.issues.push({ ...proto, id: `bulk-${n}`, number: 5000 + n, key: `OG-${5000 + n}`, title: `Bulk ticket ${n}`, tags: [], created_at: new Date(Date.UTC(2026, 0, 1) + n * 6e4).toISOString() });
  const page = await browser.page(`${mock.url}/dev/preview.html?ui=${++run}#view=list&project=OG`);
  t.after(() => page.close());
  await page.waitFor('.show-more', { timeout: 15000 });
  const rows = () => page.eval(() => document.querySelectorAll('#view tbody tr').length);
  assert.equal(await rows(), 200);
  assert.match(await page.text('.show-more'), /Show 258 more \(458 in all\)/);
  // Sorting covers everything, not just what's drawn: newest first puts the newest bulk ticket on top.
  await page.select('[data-change=sort]', 'created:-1');
  await page.waitFor(() => document.querySelector('#view tbody tr .key')?.textContent === 'OG-1740' || document.querySelector('#view tbody tr .key')?.textContent === 'OG-5449');
  await page.click('.show-more');
  await page.waitFor(() => document.querySelectorAll('#view tbody tr').length === 458);
  // A status dropdown is a label until clicked.
  assert.equal(await page.eval(() => document.querySelectorAll('#view select').length), 0, 'no live dropdowns in the table');
  await page.press('2');
  await page.waitFor('.col .show-more');
  assert.equal(await page.eval(() => Math.max(...[...document.querySelectorAll('.col')].map((c) => c.querySelectorAll('.card').length))), 100);
  await clean(page);
});

it('the Workday box: a ticking timer in the sidebar and on Today; its button punches (a person clicking); connect when not set up', async (t) => {
  mock.reset();
  const page = await browser.page(`${mock.url}/dev/preview.html?ui=${++run}#side&project=OG`);
  t.after(() => page.close());
  await page.waitFor('.workday.is-in', { timeout: 15000 });
  const first = await page.text('.workday [data-att-timer]');
  assert.match(first, /^\d\d:\d\d:\d\d$/);
  await page.waitFor((v) => document.querySelector('.workday [data-att-timer]').textContent !== v, { args: [first], timeout: 3000 });
  assert.match(await page.text('.workday .wd-where'), /^in since .+ · /);
  assert.ok(await page.eval(() => document.querySelectorAll('.workday .wd-bar i').length >= 1), "today's stretch on the day bar");
  await page.click('.workday [data-act=att-punch]');
  await page.waitFor('.workday.is-out');
  assert.deepEqual((await hostCalls(page, 'punchByHand')).map((c) => c.args[0]), ['out']);
  assert.match(await page.text('.workday [data-act=att-punch]'), /Punch in/);

  const today = await browser.page(`${mock.url}/dev/preview.html?ui=${++run}#view=today&project=OG`);
  t.after(() => today.close());
  await today.waitFor('.today > .workday.wide.is-in', { timeout: 15000 });
  const off = await browser.page(`${mock.url}/dev/preview.html?ui=${++run}#view=today&project=OG&att=off`);
  t.after(() => off.close());
  await off.waitFor('.today > .workday.off', { timeout: 15000 });
  await off.click('.workday [data-act=att-connect]');
  assert.equal((await hostCalls(off, 'connectZoho')).length, 1);
  await clean(page);
  await clean(off);
});
