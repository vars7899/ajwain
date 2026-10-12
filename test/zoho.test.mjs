// zoho.mjs: Zoho People attendance. Formats, reading Zoho's replies, the automatic punching rules, and the
// requests themselves against a recorded stand-in for fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zohoTime, parseZohoTime, readStatus, attendanceStep, workedToday, atTime, createZoho, SCOPE, REGIONS } from '../zoho.mjs';

test('times: what Zoho wants, and both ways it writes them', () => {
  assert.equal(zohoTime(new Date(2026, 9, 12, 9, 5, 7)), '12/10/2026 09:05:07');
  assert.equal(parseZohoTime('2026-10-12 09:00:00').getTime(), new Date(2026, 9, 12, 9, 0, 0).getTime());
  assert.equal(parseZohoTime('12-Oct-2026 - 09:30 AM').getTime(), new Date(2026, 9, 12, 9, 30).getTime());
  assert.equal(parseZohoTime('12-Oct-2026 - 06:15 PM').getTime(), new Date(2026, 9, 12, 18, 15).getTime());
  assert.equal(parseZohoTime('12-Oct-2026 - 12:05 AM').getHours(), 0);
  assert.equal(parseZohoTime('12-Oct-2026 - 12:05 PM').getHours(), 12);
  assert.equal(parseZohoTime('2026-10-12 06:15 PM').getTime(), new Date(2026, 9, 12, 18, 15).getTime(), 'AM/PM in either shape');
  assert.equal(parseZohoTime(''), null);
  assert.equal(parseZohoTime('-'), null);
});

test("readStatus: in or out from allowedToCheckIn, the open entry's start, wrapped replies, unknown replies", () => {
  const out = readStatus({ allowedToCheckIn: true, firstIn: '2026-10-12 09:00:00', lastOut: '2026-10-12 13:00:00', entries: [{ checkIn: '12-Oct-2026 - 09:00 AM', checkOut: '12-Oct-2026 - 01:00 PM' }] });
  assert.deepEqual([out.in, out.since], [false, null]);
  assert.equal(out.lastOut, new Date(2026, 9, 12, 13).getTime());
  const back = readStatus({ result: [{ allowedToCheckIn: false, firstIn: '2026-10-12 09:00:00', entries: [{ checkIn: '12-Oct-2026 - 09:00 AM', checkOut: '12-Oct-2026 - 01:00 PM' }, { checkIn: '12-Oct-2026 - 02:10 PM', checkOut: '' }] }] });
  assert.deepEqual([back.in, back.since], [true, new Date(2026, 9, 12, 14, 10).getTime()], 'in since the afternoon entry, not the first-in');
  assert.equal(readStatus({ entries: [{ checkIn: '12-Oct-2026 - 09:00 AM', checkOut: '' }] }).in, true, 'no allowedToCheckIn: the open entry decides');
  assert.equal(readStatus({ allowedToCheckIn: 'true', entries: [] }).in, false);
  assert.throws(() => readStatus({ message: 'nope' }), /doesn't recognise \(keys: message\)/);
});

test('the schedule: in at 09:00 on workdays (at the real time if later), out at 18:00; never twice; missed punch-outs are asked', () => {
  const rules = { punchIn: 'auto', punchOut: 'auto', in: '09:00', out: '18:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] };
  const mon = (h, m = 0) => new Date(2026, 9, 12, h, m).getTime(); // 12 Oct 2026 is a Monday
  const step = (state, now, r = rules) => attendanceStep({ state, now, rules: r });
  assert.equal(step({ in: false }, mon(8, 59)), null, 'not before 09:00');
  assert.deepEqual(step({ in: false }, mon(9)), { act: 'in', at: new Date(mon(9)) });
  assert.deepEqual(step({ in: false }, mon(10, 15)), { act: 'in', at: new Date(mon(10, 15)) }, 'VS Code started late: in now, not backdated to 09:00');
  assert.equal(step({ in: false }, mon(18)), null, 'not at or after 18:00');
  assert.equal(step({ in: false }, new Date(2026, 9, 11, 10).getTime()), null, 'not on Sunday');
  assert.equal(step({ in: false, firstIn: mon(9) }, mon(14)), null, 'punched out after being in today: punching back in is yours');
  assert.equal(step({ in: false, firstIn: new Date(2026, 9, 9, 9).getTime() }, mon(9, 1)).act, 'in', "Friday's punch-in doesn't count for Monday");
  assert.equal(step({ in: false }, mon(9), { ...rules, punchIn: 'off' }), null, 'punch-in off');
  assert.equal(step({ in: true, since: mon(9) }, mon(18), { ...rules, punchOut: 'off' }), null, 'punch-out off');
  assert.equal(step({ in: true, since: new Date(2026, 9, 9, 9).getTime() }, mon(9), { ...rules, punchOut: 'off' }), null, 'off: not even the missed punch-out');
  // Out at 18:00, timed at 18:00 even if noticed later the same evening.
  assert.equal(step({ in: true, since: mon(9) }, mon(17, 59)), null);
  assert.deepEqual(step({ in: true, since: mon(9) }, mon(18, 0)), { act: 'out', at: new Date(mon(18)) });
  assert.deepEqual(step({ in: true, since: mon(9) }, mon(19, 30)), { act: 'out', at: new Date(mon(18)) });
  assert.equal(step({ in: true, since: mon(19) }, mon(20)), null, 'punched in by hand after 18:00: not punched out');
  assert.deepEqual(step({ in: true, since: new Date(2026, 9, 9, 9).getTime() }, mon(9, 30)), { act: 'missed-out', since: new Date(2026, 9, 9, 9).getTime() }, 'still in from Friday');
  assert.deepEqual(step({ in: true }, mon(9, 30)), { act: 'missed-out', since: null }, 'in, but Zoho shows no start: asked, not guessed');
  // Custom hours.
  assert.equal(step({ in: false }, mon(8, 30), { ...rules, in: '08:30', out: '17:30' }).act, 'in');
  assert.deepEqual(step({ in: true, since: mon(8, 30) }, mon(17, 30), { ...rules, in: '08:30', out: '17:30' }), { act: 'out', at: new Date(mon(17, 30)) });
  assert.equal(atTime(mon(12), '18:00'), mon(18));
});

test('ask mode: punch-in is asked from 3 hours before the in time, punch-out from the out time; each once a day', () => {
  const rules = { punchIn: 'ask', punchOut: 'ask', in: '09:00', out: '18:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] };
  const mon = (h, m = 0) => new Date(2026, 9, 12, h, m).getTime();
  const step = (state, now) => attendanceStep({ state, now, rules });
  assert.equal(step({ in: false }, mon(5, 59)), null, 'too early: a late night, not a morning');
  assert.deepEqual(step({ in: false }, mon(6)), { act: 'ask-in' });
  assert.deepEqual(step({ in: false }, mon(14)), { act: 'ask-in' }, 'opening VS Code in the afternoon asks too');
  assert.equal(step({ in: false, askedIn: '2026-10-12' }, mon(10)), null, 'asked today already');
  assert.deepEqual(step({ in: false, askedIn: '2026-10-09' }, mon(10)), { act: 'ask-in' }, "Friday's answer is Friday's");
  assert.equal(step({ in: false, firstIn: mon(9) }, mon(14)), null, 'been in today: not asked again');
  assert.equal(step({ in: false }, mon(18)), null, 'not after the out time');
  assert.equal(step({ in: false }, new Date(2026, 9, 11, 10).getTime()), null, 'not on Sunday');
  assert.equal(step({ in: true, since: mon(9) }, mon(17, 59)), null);
  assert.deepEqual(step({ in: true, since: mon(9) }, mon(18, 30)), { act: 'ask-out' });
  assert.equal(step({ in: true, since: mon(9), askedOut: '2026-10-12' }, mon(19)), null, 'asked today already');
  assert.equal(attendanceStep({ state: { in: false }, now: mon(9), rules: { in: '09:00', out: '18:00' } }).act, 'ask-in', 'asking is the default');
});

test('workedToday: today\'s stretches, the open one up to now', () => {
  const mon = (h, m = 0) => new Date(2026, 9, 12, h, m).getTime();
  assert.equal(workedToday([{ in: mon(9), out: mon(13) }, { in: mon(14), out: null }], mon(16)), 6 * 3600e3);
  assert.equal(workedToday([{ in: new Date(2026, 9, 9, 9).getTime(), out: null }], mon(16)), 0, 'an entry from Friday is not today');
  assert.equal(workedToday(undefined, mon(16)), 0);
});

// A stand-in for fetch: records each request; answers from a function of (url, init).
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    calls.push({ method: init.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body, auth: init.headers?.Authorization });
    const [status, json] = answer(u, body, calls.at(-1));
    return new Response(typeof json === 'string' ? json : JSON.stringify(json), { status });
  };
  return Object.assign(f, { calls });
}
const store = () => { let t = null; return { load: async () => t, save: async (v) => { t = v; }, get: () => t }; };

test('connect: the one-time code for a refresh token, at the chosen data centre; clear reasons when it fails', async () => {
  const s = store();
  const f = fakeFetch((u, b) => (b.code === 'good' ? [200, { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }] : [400, { error: 'invalid_code' }]));
  const z = createZoho({ region: 'in', ...s, fetch: f });
  await assert.rejects(z.connect({ clientId: 'id', clientSecret: 'sec', code: 'stale' }), /code was wrong or expired/);
  await z.connect({ clientId: ' id ', clientSecret: 'sec', code: 'good' });
  assert.deepEqual(f.calls.at(-1), { method: 'POST', path: '/oauth/v2/token', query: {}, body: { code: 'good', client_id: 'id', client_secret: 'sec', grant_type: 'authorization_code' }, auth: undefined });
  assert.deepEqual(s.get(), { clientId: 'id', clientSecret: 'sec', refresh: 'r1', access: 'a1', expires: s.get().expires });
  assert.equal(SCOPE, 'ZOHOPEOPLE.attendance.ALL');
  assert.equal(REGIONS.in.people, 'https://people.zoho.in');
});

test('status and punch: authorised calls to Zoho People; the access token refreshes when it expires or is refused', async () => {
  const s = store();
  await s.save({ clientId: 'id', clientSecret: 'sec', refresh: 'r1', access: 'old', expires: Date.now() - 1 });
  let refreshes = 0, refuseNext = false;
  const f = fakeFetch((u, b, call) => {
    if (u.pathname === '/oauth/v2/token') return [200, { access_token: `a${++refreshes}`, expires_in: 3600 }];
    if (refuseNext) { refuseNext = false; return [401, { message: 'Invalid OAuth token' }]; }
    if (u.pathname.endsWith('/getAttendanceEntries')) return [200, { allowedToCheckIn: true, entries: [] }];
    return [200, { response: { status: 0, message: 'Data added successfully' } }];
  });
  const z = createZoho({ region: 'in', ...s, fetch: f });
  assert.equal((await z.status()).in, false);
  assert.equal(refreshes, 1, 'the expired token was refreshed first');
  assert.equal(f.calls.at(-1).auth, 'Zoho-oauthtoken a1');
  assert.equal(f.calls.at(-1).path, '/people/api/attendance/getAttendanceEntries');
  assert.deepEqual(f.calls.at(-1).query, { date: new Date().toLocaleDateString('en-CA'), dateFormat: 'yyyy-MM-dd' }, 'today, by date');
  await z.status('sam@example.com');
  assert.equal(f.calls.at(-1).query.emailId, 'sam@example.com', 'for this employee');
  await z.punch('in', new Date(2026, 9, 12, 9, 30, 0), 'sam@example.com');
  assert.deepEqual(f.calls.at(-1).body, { dateFormat: 'dd/MM/yyyy HH:mm:ss', checkIn: '12/10/2026 09:30:00', emailId: 'sam@example.com' });
  assert.equal(refreshes, 1, 'a fresh token is reused');
  refuseNext = true;
  await z.punch('out', new Date(2026, 9, 12, 18, 0, 0), 'sam@example.com');
  assert.equal(refreshes, 2, 'refused once: refreshed and retried');
  assert.deepEqual(f.calls.at(-1).body, { dateFormat: 'dd/MM/yyyy HH:mm:ss', checkOut: '12/10/2026 18:00:00', emailId: 'sam@example.com' });
});

test('errors read as sentences; a revoked refresh token says to connect again; not connected says so', async () => {
  const z0 = createZoho({ region: 'in', load: async () => null, save: async () => {}, fetch: fakeFetch(() => [200, {}]) });
  await assert.rejects(z0.status(), (e) => e.notConnected && /not connected/.test(e.message));
  const s = store();
  await s.save({ clientId: 'id', clientSecret: 'sec', refresh: 'r1', access: 'a', expires: Date.now() + 3600e3 });
  const f = fakeFetch((u) => (u.pathname === '/oauth/v2/token' ? [400, { error: 'invalid_code' }] : [200, { response: { status: 1, errors: { emailId: ['Employee not found'] } } }]));
  const z = createZoho({ region: 'in', ...s, fetch: f });
  await assert.rejects(z.punch('in', new Date(), 'x@example.com'), /Zoho People: Employee not found/);
  // Zoho's usual failure: a generic "Error occurred", the reason inside "errors". The reason is what's shown,
  // and the raw reply rides along for the log.
  const g = fakeFetch((u) => (u.pathname === '/oauth/v2/token' ? [400, {}] : [200, { response: { message: 'Error occurred', status: 1, errors: { code: 7005, message: 'Please specify a valid date' } } }]));
  await assert.rejects(createZoho({ region: 'in', ...s, fetch: g }).status('x@example.com'),
    (e) => e.message === 'Zoho People: Please specify a valid date' && /"code":7005/.test(e.body));
  await s.save({ ...s.get(), expires: 0 });
  await assert.rejects(z.status(), (e) => e.notConnected && /Connect Zoho People/.test(e.message));
});
