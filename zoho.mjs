// Zoho People attendance: punch in and out from VS Code. No deps.
//
// Sign-in is Zoho's "Self Client" flow, which anyone can set up for themselves in the API console without an
// admin: a client id and secret, plus a one-time code for the scope below, which we trade for a refresh token.
// The People API calls used (people.zoho.<dc>/people/api/...):
//   POST attendance                   dateFormat, checkIn | checkOut, emailId   -> record a punch
//   GET  attendance/getAttendanceEntries  date (yyyy-MM-dd), dateFormat, emailId -> that day's entries for the employee,
//        with firstIn, lastOut, allowedToCheckIn (true = currently out) and entries [{checkIn, checkOut}]
// Rate limit: 100 calls a minute. Ajwain makes a few an hour.
export const SCOPE = 'ZOHOPEOPLE.attendance.ALL';

// Zoho's data centres: where you sign in, and where Zoho People lives.
export const REGIONS = {
  in: { label: 'India (zoho.in)', accounts: 'https://accounts.zoho.in', people: 'https://people.zoho.in', console: 'https://api-console.zoho.in' },
  com: { label: 'United States (zoho.com)', accounts: 'https://accounts.zoho.com', people: 'https://people.zoho.com', console: 'https://api-console.zoho.com' },
  eu: { label: 'Europe (zoho.eu)', accounts: 'https://accounts.zoho.eu', people: 'https://people.zoho.eu', console: 'https://api-console.zoho.eu' },
  uk: { label: 'United Kingdom (zoho.uk)', accounts: 'https://accounts.zoho.uk', people: 'https://people.zoho.uk', console: 'https://api-console.zoho.uk' },
  'com.au': { label: 'Australia (zoho.com.au)', accounts: 'https://accounts.zoho.com.au', people: 'https://people.zoho.com.au', console: 'https://api-console.zoho.com.au' },
  jp: { label: 'Japan (zoho.jp)', accounts: 'https://accounts.zoho.jp', people: 'https://people.zoho.jp', console: 'https://api-console.zoho.jp' },
  ca: { label: 'Canada (zohocloud.ca)', accounts: 'https://accounts.zohocloud.ca', people: 'https://people.zohocloud.ca', console: 'https://api-console.zohocloud.ca' },
  sa: { label: 'Saudi Arabia (zoho.sa)', accounts: 'https://accounts.zoho.sa', people: 'https://people.zoho.sa', console: 'https://api-console.zoho.sa' },
  'com.cn': { label: 'China (zoho.com.cn)', accounts: 'https://accounts.zoho.com.cn', people: 'https://people.zoho.com.cn', console: 'https://api-console.zoho.com.cn' },
};
// Tests point these at a stand-in server.
const env = globalThis.process?.env ?? {};
const hosts = (region) => ({
  ...(REGIONS[region] ?? REGIONS.in),
  ...(env.AJWAIN_ZOHO_ACCOUNTS && { accounts: env.AJWAIN_ZOHO_ACCOUNTS }),
  ...(env.AJWAIN_ZOHO_PEOPLE && { people: env.AJWAIN_ZOHO_PEOPLE }),
});

const pad = (n) => String(n).padStart(2, '0');
// The punch time as Zoho wants it, in local time: dd/MM/yyyy HH:mm:ss.
export const zohoTime = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
export const ZOHO_FORMAT = 'dd/MM/yyyy HH:mm:ss';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Zoho writes times two ways, either with a 24-hour clock or AM/PM: "2026-10-12 09:00:00" (firstIn) and
// "12-Oct-2026 - 09:00 AM" (entries).
const hour = (h, ap) => (ap ? (+h % 12) + (/p/i.test(ap) ? 12 : 0) : +h);
export function parseZohoTime(s) {
  if (!s || typeof s !== 'string') return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], hour(m[4], m[7]), +m[5], +(m[6] ?? 0));
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s*-?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i);
  if (m) return new Date(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1], hour(m[4], m[7]), +m[5], +(m[6] ?? 0));
  return null;
}

// Today's attendance, from whatever shape getAttendanceEntries came back in (it may be wrapped).
// { in, since (ms, when the open entry began), firstIn, lastOut (ms), totalHrs, entries }
export function readStatus(json) {
  const find = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 4) return null;
    if ('allowedToCheckIn' in o || Array.isArray(o.entries)) return o;
    for (const v of Object.values(o)) { const f = find(v, depth + 1); if (f) return f; }
    return null;
  };
  const d = find(json);
  if (!d) throw new Error(`Zoho People sent an attendance reply Ajwain doesn't recognise (keys: ${Object.keys(json ?? {}).join(', ') || 'none'})`);
  const entries = (d.entries ?? []).map((e) => ({ in: parseZohoTime(e.checkIn)?.getTime() ?? null, out: parseZohoTime(e.checkOut)?.getTime() ?? null }));
  const open = entries.findLast((e) => e.in && !e.out);
  const isIn = d.allowedToCheckIn != null ? !(d.allowedToCheckIn === true || d.allowedToCheckIn === 'true') : !!open;
  return {
    in: isIn, since: isIn ? open?.in ?? parseZohoTime(d.firstIn)?.getTime() ?? null : null,
    firstIn: parseZohoTime(d.firstIn)?.getTime() ?? null, lastOut: parseZohoTime(d.lastOut)?.getTime() ?? null,
    totalHrs: d.totalHrs ?? null, entries,
  };
}

// A Zoho error, in words: they come back as {error}, {message}, {response: {message, errors}} or {errors: ...}.
// "message" is often only "Error occurred": the reason is in "errors" ({code, message}, {field: [..]}, or a list).
const texts = (o) => (typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(texts) : []);
function zohoError(json, status) {
  const r = json?.response ?? json;
  const msg = json?.error_description ?? (texts(json?.error).join(' ') || texts(r?.errors).join(' ') || r?.message);
  return msg ? String(msg) : status ? `Zoho answered ${status}` : '';
}
const failed = (json) => json?.error || json?.response?.status === 1 || json?.status === 1 || (json?.errors && Object.keys(json.errors).length);

// load(): {clientId, clientSecret, refresh, access?, expires?} | null; save(that | null). Both may be async.
export function createZoho({ region, load, save, fetch: f = globalThis.fetch }) {
  const H = () => hosts(typeof region === 'function' ? region() : region);
  const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== ''));
  async function token() {
    const t = await load();
    if (!t?.refresh) throw Object.assign(new Error('Zoho People is not connected'), { notConnected: true });
    if (t.access && t.expires > Date.now() + 60e3) return t.access;
    const r = await f(`${H().accounts}/oauth/v2/token`, { method: 'POST', body: form({ refresh_token: t.refresh, client_id: t.clientId, client_secret: t.clientSecret, grant_type: 'refresh_token' }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.access_token) {
      const e = new Error(`Zoho sign-in expired or was revoked: ${zohoError(j, r.status) || 'no access token'}. Run "Ajwain: Connect Zoho People" again.`);
      if (j?.error === 'invalid_code' || j?.error === 'invalid_client' || r.status === 400) e.notConnected = true;
      throw e;
    }
    await save({ ...t, access: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 });
    return j.access_token;
  }
  async function people(path, { method = 'GET', params } = {}, retried = false) {
    const url = `${H().people}/people/api/${path}`;
    const r = await f(method === 'GET' && params ? `${url}?${form(params)}` : url, {
      method, headers: { Authorization: `Zoho-oauthtoken ${await token()}` }, ...(method !== 'GET' && params && { body: form(params) }),
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (r.status === 401 && !retried) { // the access token went stale early: once more with a fresh one
      const t = await load();
      await save({ ...t, access: null, expires: 0 });
      return people(path, { method, params }, true);
    }
    if (!r.ok || failed(j) || /invalid (ticket|oauth)/i.test(text)) throw Object.assign(new Error(`Zoho People: ${zohoError(j, r.status) || text.slice(0, 200)}`), { status: r.status, body: text.slice(0, 500) });
    return j ?? text;
  }
  return {
    hosts: H,
    // The one-time code from the Self Client -> a refresh token, kept by save().
    async connect({ clientId, clientSecret, code }) {
      const r = await f(`${H().accounts}/oauth/v2/token`, { method: 'POST', body: form({ code: code.trim(), client_id: clientId.trim(), client_secret: clientSecret.trim(), grant_type: 'authorization_code' }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.refresh_token) {
        const why = j?.error === 'invalid_code' ? 'the code was wrong or expired (they last a few minutes): generate a new one'
          : j?.error === 'invalid_client' ? 'the client id or secret is wrong, or belongs to another data centre' : zohoError(j, r.status) || 'no refresh token in the reply';
        throw new Error(`Couldn't connect to Zoho: ${why}`);
      }
      await save({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), refresh: j.refresh_token, access: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 });
    },
    disconnect: () => save(null),
    status: async (email) => readStatus(await people('attendance/getAttendanceEntries', { params: { date: ymd(Date.now()), dateFormat: 'yyyy-MM-dd', emailId: email } })),
    // dir 'in' | 'out', at a Date (a punch-out can be back-dated to when you were last active).
    punch: (dir, at, email) => people('attendance', {
      method: 'POST', params: { dateFormat: ZOHO_FORMAT, [dir === 'in' ? 'checkIn' : 'checkOut']: zohoTime(at), emailId: email },
    }),
  };
}

// ---------- the schedule: a pure decision, so it can be tested without Zoho or a clock ----------
// rules: { punchIn: 'ask' | 'auto' | 'off', punchOut: 'auto' | 'ask' | 'off', in: '09:00', out: '18:00', days: ['mon'…] }
// state: { in, since (ms the open entry began), firstIn (ms, today's first punch-in), askedIn, askedOut (the day) }
// Returns null, { act: 'in' | 'out', at: Date }, { act: 'ask-in' | 'ask-out' } (a person decides), or
// { act: 'missed-out', since } (still in from an earlier day: that's yours to settle, Ajwain asks).
//   in:  on a workday before the out time, if you haven't punched in at all today. 'auto': from the in time, at the
//        real time (VS Code starting at 10:15 punches you in at 10:15). 'ask': from ASK_EARLY before the in time,
//        once a day.
//   out: at the out time, if you're in since before it. 'auto' punches at the out time; 'ask' asks, once a day.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA');
export const atTime = (ms, hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number), d = new Date(ms);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
};
export const ASK_EARLY = 3 * 3600e3; // with the in time at 09:00, VS Code opening from 06:00 asks
export function attendanceStep({ state, now, rules }) {
  const { punchIn = 'ask', punchOut = 'auto' } = rules, today = ymd(now);
  const inAt = atTime(now, rules.in || '09:00'), outAt = atTime(now, rules.out || '18:00');
  if (state.in) {
    if (punchOut === 'off') return null;
    if (!state.since || ymd(state.since) !== today) return { act: 'missed-out', since: state.since ?? null }; // in, from an earlier day (or since when, unknown)
    if (now < outAt || state.since >= outAt) return null;
    if (punchOut === 'auto') return { act: 'out', at: new Date(outAt) };
    return state.askedOut === today ? null : { act: 'ask-out' };
  }
  const workday = (rules.days ?? DAYS.slice(1, 6)).includes(DAYS[new Date(now).getDay()]);
  if (punchIn === 'off' || !workday || now >= outAt) return null;
  if (state.firstIn && ymd(state.firstIn) === today) return null; // you've been in today: punching back in is yours
  if (punchIn === 'auto') return now >= inAt ? { act: 'in', at: new Date(now) } : null;
  return now >= inAt - ASK_EARLY && state.askedIn !== today ? { act: 'ask-in' } : null;
}
// Time worked today, from today's entries (an open one counts up to now).
export const workedToday = (entries, now) => (entries ?? [])
  .filter((e) => e.in && ymd(e.in) === ymd(now))
  .reduce((a, e) => a + Math.max(0, (e.out ?? now) - e.in), 0);
