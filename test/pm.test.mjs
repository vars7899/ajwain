import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, fmtDuration, branchName } from '../pm.mjs';

test('durations', () => {
  assert.equal(parseDuration('2h'), 120);
  assert.equal(parseDuration('1h30m'), 90);
  assert.equal(parseDuration('1h 30m'), 90);
  assert.equal(parseDuration('45m'), 45);
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('1.5h'), 90);
  assert.equal(parseDuration('1d 2h'), 600);
  for (const bad of ['', 'h', 'soon', '2x']) assert.throws(() => parseDuration(bad));
  assert.equal(fmtDuration(90), '1h 30m');
  assert.equal(fmtDuration(0), '');
});

test('branch names', () => {
  assert.equal(branchName({ key: 'ESG-12', title: 'Fix: login fails on Safari!', issue_type: 'BUG' }), 'fix/ESG-12-fix-login-fails-on-safari');
  assert.equal(branchName({ key: 'ESG-3', title: 'A very long title that keeps going and going forever', issue_type: 'TASK' }), 'feat/ESG-3-a-very-long-title-that-keeps-going-and');
});

test('req accepts null opts (webview messages are JSON-serialized)', async () => {
  const { createClient } = await import('../pm.mjs');
  const seen = [];
  globalThis.fetch = async (url, init) => (seen.push([url, init.method]), { ok: true, status: 200, json: async () => ({ data: { ok: 1 } }) });
  const api = createClient({ load: () => ({ access: 't' }), save: () => {}, base: 'https://api.example.com/' });
  assert.deepEqual(await api.req('/auth/me/', null), { ok: 1 });
  assert.deepEqual(seen, [['https://api.example.com/auth/me/', 'GET']]);
});

test('no server address is built in: the client says so, and follows a changed address at once', async () => {
  const { createClient, appFromApi, issueUrl, setApp } = await import('../pm.mjs');
  let base = '';
  const seen = [];
  globalThis.fetch = async (url) => (seen.push(url), { ok: true, status: 200, json: async () => ({ data: {} }) });
  const api = createClient({ load: () => null, save: () => {}, base: () => base });
  await assert.rejects(api.me(), (e) => e.noServer === true && /No server address set/.test(e.message));
  assert.deepEqual(seen, [], 'nothing was requested');
  base = 'http://localhost:8765';
  await api.me();
  assert.deepEqual(seen, ['http://localhost:8765/auth/me/']);
  // The web app's address is guessed from the API's, when it can be.
  assert.equal(appFromApi('https://pm-api.example.com'), 'https://pm-app.example.com');
  assert.equal(appFromApi('https://api.example.com:8443/'), 'https://app.example.com:8443');
  assert.equal(appFromApi('http://localhost:8765'), '');
  assert.equal(appFromApi('nonsense'), '');
  setApp('');
  assert.equal(issueUrl('OG-1'), '', 'no web app, no link');
  setApp('https://pm.example.com/');
  assert.equal(issueUrl('OG-1'), 'https://pm.example.com/issues/OG-1');
});

test('ticket keys', async () => {
  const { ticketKey } = await import('../pm.mjs');
  assert.equal(ticketKey('feat/OG-12-add-x'), 'OG-12');
  assert.equal(ticketKey('main', 'ESG-3: fix pdf'), 'ESG-3');
  assert.equal(ticketKey('main', 'tidy up'), null);
});

test('time from commits', async () => {
  const { timeFromCommits } = await import('../pm.mjs');
  const t = (h, m) => (h * 60 + m) * 60;
  // 09:00 OG-1 (new session 30m), 09:40 OG-1 (+40), 10:10 OG-2 (+30), 15:00 OG-2 (new session 30m)
  assert.deepEqual(timeFromCommits([{ time: t(9, 40), key: 'OG-1' }, { time: t(9, 0), key: 'OG-1' }, { time: t(10, 10), key: 'OG-2' }, { time: t(15, 0), key: 'OG-2' }]), { 'OG-1': 75, 'OG-2': 60 });
  assert.deepEqual(timeFromCommits([{ time: 0, key: null }]), { '': 30 });
});

test('reminders are due once, in their window, on their days', async () => {
  const { isDue } = await import('../pm.mjs');
  const tue = (h, m) => new Date(2026, 9, 6, h, m); // Tue 6 Oct 2026
  assert.equal(isDue({ time: '16:00' }, tue(15, 59), undefined), false);
  assert.equal(isDue({ time: '16:00' }, tue(16, 0), undefined), true);
  assert.equal(isDue({ time: '16:00' }, tue(17, 30), undefined), true);
  assert.equal(isDue({ time: '16:00' }, tue(18, 1), undefined), false);
  assert.equal(isDue({ time: '16:00' }, tue(16, 5), '2026-10-06'), false);
  assert.equal(isDue({ time: '16:00', days: ['mon'] }, tue(16, 5), undefined), false);
  assert.equal(isDue({ time: '16:00' }, new Date(2026, 9, 10, 16, 5), undefined), false); // Saturday
  assert.equal(isDue({ time: 'soon' }, tue(16, 5), undefined), false);
});

test('branch templates', async () => {
  const { branchName } = await import('../pm.mjs');
  const i = { key: 'OG-12', title: 'Add login page', issue_type: 'TASK' };
  assert.equal(branchName(i), 'feat/OG-12-add-login-page');
  assert.equal(branchName(i, '{key}-{slug}'), 'OG-12-add-login-page');
  assert.equal(branchName({ ...i, issue_type: 'BUG' }, '{type}/{key}'), 'fix/OG-12');
});

test('remotes and pull request urls', async () => {
  const { parseRemote, newPrUrl, codecommitPrUrl } = await import('../pm.mjs');
  const cc = parseRemote('https://git-codecommit.ap-south-1.amazonaws.com/v1/repos/acme-platform');
  assert.deepEqual(cc, { kind: 'codecommit', region: 'ap-south-1', repo: 'acme-platform' });
  assert.deepEqual(parseRemote('codecommit::eu-west-1://my-repo'), { kind: 'codecommit', region: 'eu-west-1', repo: 'my-repo' });
  assert.equal(newPrUrl(cc, 'OG-12-x', 'master'), 'https://ap-south-1.console.aws.amazon.com/codesuite/codecommit/repositories/acme-platform/pull-requests/new/refs/heads/master/.../refs/heads/OG-12-x?region=ap-south-1');
  assert.equal(codecommitPrUrl(cc, 42), 'https://ap-south-1.console.aws.amazon.com/codesuite/codecommit/repositories/acme-platform/pull-requests/42/details?region=ap-south-1');
  assert.deepEqual(parseRemote('git@github.com:acme/app.git'), { kind: 'github', host: 'github.com', slug: 'acme/app' });
  assert.deepEqual(parseRemote('https://gitlab.com/acme/sub/app.git'), { kind: 'gitlab', host: 'gitlab.com', slug: 'acme/sub/app' });
  assert.match(newPrUrl(parseRemote('git@github.com:acme/app.git'), 'b', 'main', 'T'), /^https:\/\/github\.com\/acme\/app\/compare\/main\.\.\.b\?expand=1&title=T/);
  assert.equal(parseRemote('https://example.com/x.git').kind, 'other');
});

test('pull request body and standup day', async () => {
  const { prBody, previousWorkday, setApp } = await import('../pm.mjs');
  setApp('');
  assert.match(prBody({ key: 'OG-1', title: 'T' }, []), /^Ticket: OG-1 T/, 'without a web app, the ticket is named, not linked');
  setApp('https://pm.example.com');
  const body = prBody({ key: 'OG-1', title: 'T', description: 'Why', children: [{ key: 'OG-2', title: 'a', status_detail: { category: 'DONE' } }, { key: 'OG-3', title: 'b' }] }, ['x (abc)']);
  assert.match(body, /^Ticket: \[OG-1\]\(https:\/\/pm\.example\.com\/issues\/OG-1\) T\n\nWhy\n\n## Subtasks\n- \[x\] OG-2 a\n- \[ \] OG-3 b\n\n## Commits\n- x \(abc\)$/);
  assert.equal(previousWorkday(new Date(2026, 9, 5, 10)).toDateString(), new Date(2026, 9, 2).toDateString()); // Mon -> Fri
  assert.equal(previousWorkday(new Date(2026, 9, 6, 10)).toDateString(), new Date(2026, 9, 5).toDateString()); // Tue -> Mon
});

test('ticket health', async () => {
  const { ticketQuality, TEMPLATES } = await import('../pm.mjs');
  const bad = ticketQuality({ title: 'Webhooks', description: '', issue_type: 'TASK' });
  assert.equal(bad.score, 0);
  assert.deepEqual(bad.checks.map((c) => c.id), ['title', 'description', 'criteria', 'estimate']);
  const good = ticketQuality({
    title: 'Add retry to webhook delivery', issue_type: 'TASK', estimate_minutes: 240,
    description: '## Why\nReceivers drop events when they restart.\n\n## Acceptance criteria\n- [ ] Retries 3 times with backoff',
  });
  assert.equal(good.score, 100);
  const bug = ticketQuality({ title: 'Login fails on Safari with 2FA', issue_type: 'BUG', estimate_minutes: 60, description: TEMPLATES.BUG });
  assert.equal(bug.checks.find((c) => c.id === 'repro').ok, true);
  assert.equal(bug.checks.find((c) => c.id === 'description').ok, false); // an empty template isn't a description
  const big = ticketQuality({ title: 'Rebuild the reporting engine', issue_type: 'TASK', estimate_minutes: 2400, description: 'x'.repeat(50) });
  assert.equal(big.checks.find((c) => c.id === 'size').warn, true);
});

test('attachments: presign, PUT to storage, register', async () => {
  const { createClient, mimeOf, attachmentKind, fmtSize } = await import('../pm.mjs');
  assert.equal(mimeOf('Screen Shot.PNG'), 'image/png');
  assert.equal(attachmentKind('spec.pdf'), 'pdf');
  assert.equal(fmtSize(1536), '2 KB');
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push([init.method, url, init.headers?.['Content-Type'], init.body instanceof Uint8Array ? `${init.body.length} bytes` : init.body]);
    const data = url.endsWith('/presign/') ? { key: 'k1', url: 'https://bucket.example/put' } : url.endsWith('/api/attachments/') ? { id: 'a1', name: 'shot.png' } : null;
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const api = createClient({ load: () => ({ access: 't' }), save: () => {}, base: 'http://mock' });
  const a = await api.attach({ target_type: 'issues.issue', target_id: 'i1' }, { name: 'shot.png', bytes: new Uint8Array(10) });
  assert.deepEqual(a, { id: 'a1', name: 'shot.png' });
  assert.deepEqual(seen, [
    ['POST', 'http://mock/api/attachments/presign/', 'application/json', '{"target_type":"issues.issue","target_id":"i1","name":"shot.png","size":10,"content_type":"image/png"}'],
    ['PUT', 'https://bucket.example/put', 'image/png', '10 bytes'],
    ['POST', 'http://mock/api/attachments/', 'application/json', '{"target_type":"issues.issue","target_id":"i1","key":"k1","name":"shot.png"}'],
  ]);
  await assert.rejects(api.attach({}, { name: 'big.zip', bytes: { length: 21 * 1024 * 1024 } }), /larger than 20 MB/);
});

test('streaks skip weekends and an unfinished today', async () => {
  const { streak } = await import('../pm.mjs');
  const at = (d, h = 12) => new Date(2026, 9, d, h).getTime(); // Oct 2026: 2 = Fri, 5 = Mon, 6 = Tue
  const j = [{ t: at(1), type: 'log' }, { t: at(2), type: 'pr' }, { t: at(5), type: 'finish' }];
  assert.equal(streak(j, at(5, 18)), 3); // Thu, Fri, Mon
  assert.equal(streak(j, at(6, 9)), 3); // Tuesday morning: nothing yet today, still 3
  assert.equal(streak(j, at(7, 9)), 0); // missed Tuesday
  assert.equal(streak([{ t: at(1), type: 'break' }], at(1, 18)), 0); // breaks aren't shipped work
});

test('badges unlock once, with the moment they were earned', async () => {
  const { badges } = await import('../pm.mjs');
  const j = [{ t: 1, type: 'start' }, { t: 2, type: 'pr' }, { t: 3, type: 'pr' }, ...Array.from({ length: 5 }, (_, n) => ({ t: 10 + n, type: 'finish', issue_type: 'BUG', cleanup: true }))];
  const b = Object.fromEntries(badges(j).map((x) => [x.id, x.unlockedAt]));
  assert.equal(b['first-pr'], 2);
  assert.equal(b['bug-squasher'], 14);
  assert.equal(b['clean-desk'], 14);
  assert.equal(b.shipper, null);
});

test('server errors read as sentences, with the field errors kept for code', async () => {
  const { errorText, createClient } = await import('../pm.mjs');
  assert.equal(errorText('Invalid input.', { estimate_minutes: ['Estimate First: add an estimate first.'] }), 'Estimate First: add an estimate first.');
  assert.equal(errorText('Invalid data.', { title: ['This field may not be blank.'] }), 'Title: This field may not be blank.');
  assert.equal(errorText('Invalid data.', { non_field_errors: ['Pick one.'], due_date: 'Not a date.' }), 'Pick one. Due date: Not a date.');
  assert.equal(errorText('Not found.', {}), 'Not found.');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: false, message: 'Invalid input.', errors: { estimate_minutes: ['Estimate First: add an estimate first.'] } }), { status: 400 });
  try {
    const api = createClient({ load: async () => ({ access: 'a' }), save: async () => {}, base: 'https://api.example.com' });
    await assert.rejects(api.update('x', { status: 1 }), (e) => e.message === 'Estimate First: add an estimate first.' && e.status === 400 && !!e.errors.estimate_minutes);
  } finally { globalThis.fetch = realFetch; }
});

test('lucky dip moods: a bug is a bug; then urgency; then how small it is', async () => {
  const { luckyMood, luckyPayout } = await import('../pm.mjs');
  const T = '2026-10-07', mood = (i) => luckyMood({ issue_type: 'TASK', priority: 'MEDIUM', ...i }, T);
  assert.equal(mood({ issue_type: 'BUG', priority: 'HIGHEST', due_date: '2026-10-01' }), 'bug');
  assert.equal(mood({ priority: 'HIGHEST' }), 'jackpot');
  assert.equal(mood({ due_date: '2026-10-06' }), 'jackpot', 'overdue');
  assert.equal(mood({ priority: 'HIGH' }), 'big');
  assert.equal(mood({ due_date: '2026-10-09' }), 'big', 'due within three days');
  assert.equal(mood({ priority: 'LOW', estimate_minutes: 480 }), 'easy', 'low priority');
  assert.equal(mood({ estimate_minutes: 60 }), 'easy', 'an hour or less');
  assert.equal(mood({ estimate_minutes: 240, due_date: '2026-10-20' }), 'win');
  assert.equal(mood({}), 'win');
  assert.equal(luckyPayout({ priority: 'HIGHEST', due_date: '2026-10-01' }, T), 1500);
});

// A stand-in for WebAudio that counts what gets scheduled.
function fakeAudio() {
  const made = { ctx: 0, osc: 0, noise: 0, started: [], lfo: 0 };
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime(v, t) { if (!(v > 0) || !Number.isFinite(t)) throw new Error(`bad ramp to ${v} at ${t}`); } });
  const node = (extra = {}) => ({ connect(to) { if (to?.isParam) made.lfo++; return to; }, ...extra });
  class Ctx {
    constructor() { made.ctx++; this.currentTime = 5; this.sampleRate = 8000; this.state = 'running'; this.destination = node(); }
    createOscillator() { made.osc++; return node({ type: 'sine', frequency: { ...param(), isParam: true }, start(t) { made.started.push(t); }, stop() {} }); }
    createGain() { return node({ gain: param() }); }
    createBiquadFilter() { return node({ type: '', frequency: param() }); }
    createDynamicsCompressor() { return node(); }
    createWaveShaper() { return node({ curve: null }); }
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
    createBufferSource() { made.noise++; return node({ buffer: null, start(t) { made.started.push(t); } }); }
  }
  return { Ctx, made };
}
test('slot machine sounds: every cue plays; a jackpot is the biggest; a bug boings and droops; muted means silent', async () => {
  const { createSfx, SFX_CUES } = await import('../media/sfx.mjs');
  const size = {};
  for (const cue of SFX_CUES) {
    const { Ctx, made } = fakeAudio();
    createSfx(() => true, Ctx)(cue, 1);
    assert.ok(made.osc + made.noise > 0, `${cue} schedules something`);
    assert.ok(made.started.every((t) => t >= 5), `${cue} never starts in the past`);
    size[cue] = { n: made.osc + made.noise, lfo: made.lfo, last: Math.max(...made.started) - 5 };
  }
  assert.ok(size.jackpot.n > size.big.n && size.big.n > size.win.n && size.win.n > size.tick.n, JSON.stringify(size));
  assert.ok(size.jackpot.last > 3, 'the jackpot keeps paying out for seconds');
  assert.ok(size.bug.lfo >= 4, 'three poings and a wavering last note');
  assert.equal(size.win.lfo + size.jackpot.lfo + size.easy.lfo, 0, 'wins do not wobble');
  // One audio context for the lot, none at all while muted, and an unknown cue is ignored.
  const { Ctx, made } = fakeAudio();
  let on = false;
  const sfx = createSfx(() => on, Ctx);
  sfx('jackpot');
  assert.equal(made.ctx, 0);
  on = true;
  sfx('win'); sfx('tick'); sfx('nope');
  assert.equal(made.ctx, 1);
  assert.doesNotThrow(() => createSfx(() => true, undefined)('win'), 'no WebAudio: quiet, not broken');
});

test('lucky dip favours urgent work', async () => {
  const { luckyPick } = await import('../pm.mjs');
  const issues = [{ key: 'A', priority: 'LOWEST' }, { key: 'B', priority: 'HIGHEST', due_date: '2026-10-01' }];
  const tally = { A: 0, B: 0 };
  for (let n = 0; n < 1000; n++) tally[luckyPick(issues, () => n / 1000, '2026-10-06').key]++;
  assert.equal(tally.A, 63); // weights 1 vs 15 → 1/16 of the spins
  assert.equal(luckyPick([], () => 0.5), null);
});

test('week stats: heatmap, busiest day, title', async () => {
  const { weekStats, tipOfTheDay, TIPS } = await import('../pm.mjs');
  const now = new Date(2026, 9, 7, 17).getTime(); // Wed
  const c = (d, h, key) => ({ time: new Date(2026, 9, d, h).getTime() / 1000, key });
  const s = weekStats(
    [{ t: now - 1, type: 'finish', issue_type: 'BUG' }, { t: now - 2, type: 'finish', issue_type: 'BUG' }, { t: now - 3, type: 'finish', issue_type: 'BUG' }, { t: now - 4, type: 'log', minutes: 90 }],
    [c(5, 10, 'OG-1'), c(6, 22, 'OG-2'), c(6, 23, 'OG-2'), c(2, 10, 'OG-9')], now);
  assert.equal(s.commits, 3); // Friday's commit is last week
  assert.equal(s.tickets, 2);
  assert.equal(s.busiest, 1); // Tuesday
  assert.equal(s.heat[1][22], 1);
  assert.equal(s.minutes, 90);
  assert.equal(s.title[0], 'Bug squasher');
  assert.ok(TIPS.includes(tipOfTheDay(new Date(2026, 9, 6))));
});
