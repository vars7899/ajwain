// The Workday box: your Zoho People attendance at a glance, in the sidebar and on Today. Time worked today
// (counting while you're in), when you punched in, the day from the in time to the out time with your actual
// stretches on it, and one button to punch. The host sends the state ({type: 'attendance'}); the box counts.
import { workedToday, atTime } from '../zoho.mjs';
import { icon } from './icons.mjs';

const pad = (n) => String(n).padStart(2, '0');
export const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
const hm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m}m`; };
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export function workdayBox(a, now = Date.now(), { wide = false } = {}) {
  if (!a) return '';
  if (!a.connected) {
    return `<section class="workday off ${wide ? 'wide' : ''}"><span class="label">${icon('clock', { size: 13 })}Workday</span>
      <span class="muted small grow">Punch in and out of Zoho People: in at 09:00, out at 18:00.</span>
      <button class="btn small" data-act="att-connect">Connect Zoho People</button></section>`;
  }
  const r = a.rules ?? {}, inAt = atTime(now, r.in || '09:00'), outAt = atTime(now, r.out || '18:00');
  const worked = workedToday(a.entries, now);
  const x = (t) => Math.min(100, Math.max(0, ((t - inAt) / Math.max(1, outAt - inAt)) * 100));
  const stretches = (a.entries ?? []).filter((e) => e.in && sameDay(e.in, now))
    .map((e) => `<i style="left:${x(e.in).toFixed(2)}%;width:${Math.max(0.6, x(e.out ?? now) - x(e.in)).toFixed(2)}%" title="${hm(e.in)}–${e.out ? hm(e.out) : 'now'}"></i>`).join('');
  const where = a.in
    ? `in since ${a.since ? hm(a.since) : '?'} · ${now < outAt ? `${dur(outAt - now)} to ${r.out}` : `past ${r.out}`}`
    : worked ? 'worked today'
    : r.punchIn === 'auto' && now < inAt ? `punches in at ${r.in}` : 'not punched in today';
  return `<section class="workday ${a.in ? 'is-in' : 'is-out'} ${wide ? 'wide' : ''}" aria-label="Workday">
    <div class="wd-head"><span class="label">${icon('clock', { size: 13 })}Workday · Zoho People</span><span class="wd-state">${a.in ? 'In' : 'Out'}</span></div>
    <div class="wd-main"><b class="wd-timer" data-att-timer>${hms(worked)}</b><span class="muted small wd-where">${where}</span></div>
    <div class="wd-day"><span class="wd-t">${r.in}</span><div class="wd-bar" title="Your day, ${r.in}–${r.out}">${stretches}${now >= inAt && now <= outAt ? `<b class="wd-now" style="left:${x(now).toFixed(2)}%"></b>` : ''}</div><span class="wd-t">${r.out}</span></div>
    <button class="btn small ${a.in ? '' : 'primary'} wd-punch" data-act="att-punch" data-dir="${a.in ? 'out' : 'in'}">${icon(a.in ? 'stop' : 'clock', { size: 12 })}${a.in ? 'Punch out' : 'Punch in'}</button>
  </section>`;
}
// Called every second: the timer counts; every minute the whole box redraws (the bar and "to go" move on).
export function tickWorkday(a, root = document) {
  if (!a?.connected) return;
  const now = Date.now();
  if (new Date(now).getSeconds() === 0) {
    root.querySelectorAll('.workday').forEach((el) => { el.outerHTML = workdayBox(a, now, { wide: el.classList.contains('wide') }); });
    return;
  }
  if (a.in) root.querySelectorAll('[data-att-timer]').forEach((el) => { el.textContent = hms(workedToday(a.entries, now)); });
}
