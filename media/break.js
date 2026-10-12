// The break screen: the mascot leads a short stretch routine (or a 20-20-20 eye break). Plain JS, no deps.
import { mascotBody, mascot, icon } from './icons.mjs';

const vsc = acquireVsCodeApi();
const info = JSON.parse(decodeURIComponent(document.body.dataset.info || '%7B%7D'));
const $ = (s) => document.querySelector(s);

// pose: CSS class on the figure (see break.css); mood: the mascot's face for that step.
const STEPS = {
  reach: { title: 'Reach up', say: 'Stretch both arms over your head. Breathe in deeply.', pose: 'reach', secs: 12 },
  left: { title: 'Lean left', say: 'Arms up, lean slowly to the left. Feel your side stretch.', pose: 'lean-left', secs: 12 },
  right: { title: 'Lean right', say: 'Now to the right. Keep breathing.', pose: 'lean-right', secs: 12 },
  shrug: { title: 'Shoulder rolls', say: 'Roll your shoulders up and back, slowly, five times.', pose: 'shrug', secs: 12 },
  neck: { title: 'Neck tilts', say: 'Tilt your head to one side, then the other. Gently.', pose: 'neck', secs: 12, mood: 'look' },
  wrists: { title: 'Wrist circles', say: 'Arms out, circle your wrists one way, then the other.', pose: 'wrists', secs: 12 },
  twist: { title: 'Seated twist', say: 'Sit tall and twist gently to each side.', pose: 'twist', secs: 12 },
  eyes: { title: 'Look far away', say: 'Look at something about 20 feet away for 20 seconds. Blink a few times.', pose: 'eyes', secs: 20, mood: 'look' },
  breathe: { title: 'Breathe', say: 'In for four… and out for four. Shoulders down.', pose: 'breathe', secs: 16, mood: 'sleepy' },
};
const routine = info.kind === 'eyes'
  ? ['eyes']
  : ['reach', 'left', 'right', ...['shrug', 'neck', 'wrists', 'twist'].sort(() => Math.random() - 0.5).slice(0, 2), 'breathe'];

const label = info.kind === 'eyes' ? 'Eye break' : info.pomodoro ? 'Focus session done' : 'Stretch break';
const sub = [
  info.focused ? `${info.focused} minutes of focus` : '',
  info.today ? `${info.today} break${info.today === 1 ? '' : 's'} today` : '',
].filter(Boolean).join(' · ');

document.body.innerHTML = `<main class="brk">
  <header class="brk-head"><span class="brk-tag">${icon('stretch', { size: 14 })}${label}</span>${sub ? `<span class="muted">${sub}</span>` : ''}</header>
  <div class="stage"><div class="figure" id="figure"></div></div>
  <h1 id="title"></h1>
  <p id="say" class="muted"></p>
  <div class="segments" aria-hidden="true">${routine.map(() => '<span><i></i></span>').join('')}</div>
  <div class="count" id="count" aria-live="polite"></div>
  <div class="brk-actions">
    <button class="btn" data-a="skip">Skip this one</button>
    <button class="btn" data-a="snooze">Snooze 10 min</button>
    <button class="btn primary" data-a="done">I'm done</button>
  </div>
</main>`;

let n = -1, left = 0, mood = null;
function step(i) {
  n = i;
  if (n >= routine.length) return finish();
  const s = STEPS[routine[n]];
  const fig = $('#figure');
  if ((s.mood ?? 'happy') !== mood) {
    mood = s.mood ?? 'happy';
    fig.innerHTML = mascotBody(mood);
  }
  fig.className = `figure pose-${s.pose}`;
  $('#title').textContent = s.title;
  $('#say').textContent = s.say;
  document.querySelectorAll('.segments span').forEach((el, k) => {
    el.className = k < n ? 'done' : k === n ? 'now' : '';
    el.firstChild.style.transitionDuration = k === n ? `${s.secs}s` : '0s';
  });
  left = s.secs;
  $('#count').textContent = `${left}s`;
}
const tick = setInterval(() => {
  if (n < 0 || n >= routine.length) return;
  left -= 1;
  $('#count').textContent = `${Math.max(0, left)}s`;
  if (left <= 0) step(n + 1);
}, 1000);

function finish() {
  clearInterval(tick);
  document.body.innerHTML = `<main class="brk done-screen">
    <div class="confetti" aria-hidden="true">${Array.from({ length: 36 }, (_, k) => `<i style="--x:${(k * 37) % 100}vw;--d:${(k % 7) * 0.15}s;--r:${(k * 53) % 360}deg"></i>`).join('')}</div>
    ${mascot(150, 'party')}
    <h1>Nice. Back to it.</h1>
    <p class="muted">${info.kind === 'eyes' ? 'Your eyes thank you.' : 'Shoulders down, water nearby, and on you go.'}</p>
    <div class="brk-actions">
      <button class="btn" data-a="close">Close</button>
      <button class="btn primary" data-a="focus">${icon('eye', { size: 14 })}Start a focus session</button>
    </div>
    <p class="muted small">Closing in <span id="bye">8</span>s</p>
  </main>`;
  let bye = 8;
  const t = setInterval(() => {
    bye -= 1;
    const el = $('#bye');
    if (el) el.textContent = String(bye);
    if (bye <= 0) {
      clearInterval(t);
      vsc.postMessage({ type: 'done', completed: true });
    }
  }, 1000);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (a === 'skip') step(n + 1);
  if (a === 'snooze') vsc.postMessage({ type: 'snooze', minutes: 10 });
  if (a === 'done') vsc.postMessage({ type: 'done', completed: n > 0 }); // counts once you've done at least one move
  if (a === 'close') vsc.postMessage({ type: 'done', completed: true });
  if (a === 'focus') vsc.postMessage({ type: 'done', completed: true, focus: true });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') vsc.postMessage({ type: 'snooze', minutes: 10 });
  if (e.key === 'ArrowRight') step(n + 1);
});

step(0);
