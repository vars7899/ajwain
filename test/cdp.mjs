// Tiny Chrome DevTools Protocol driver: headless Chrome over Node's global WebSocket, no deps.
//   const browser = await launch(); const page = await browser.page(url); await page.click('.card'); await browser.close();
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// $CHROME, else Playwright's headless shell, else chromium / google-chrome on PATH. null when none is installed.
export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pw = path.join(os.homedir(), '.cache', 'ms-playwright');
  const shells = fs.existsSync(pw) ? fs.readdirSync(pw).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of shells) {
    const f = path.join(pw, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(f)) return f;
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'])
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ chrome = findChrome(), timeout = 15000 } = {}) {
  if (!chrome) throw new Error('No Chrome found: set CHROME');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajwain-chrome-'));
  const proc = spawn(chrome, [
    '--headless', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--window-size=1300,900',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--mute-audio', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (const end = Date.now() + timeout; !fs.existsSync(portFile) || fs.readFileSync(portFile, 'utf8').split('\n').length < 2; await sleep(50))
    if (Date.now() > end || proc.exitCode != null) { proc.kill(); throw new Error(`Chrome did not start: ${stderr}`); }
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');

  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });
  let seq = 0;
  const calls = new Map(), sessions = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const c = calls.get(m.id);
      calls.delete(m.id);
      return m.error ? c?.reject(new Error(`${c.method}: ${m.error.message}`)) : c?.resolve(m.result);
    }
    sessions.get(m.sessionId)?.(m.method, m.params);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    calls.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => calls.has(id) && (calls.delete(id), reject(new Error(`${method}: CDP timeout`))), 30000).unref();
  });

  const browser = {
    async page(url) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const cmd = (method, params) => send(method, params, sessionId);
      const waiters = new Set();
      const page = {
        consoleErrors: [],
        cmd,
        async goto(u) {
          const loaded = new Promise((r) => waiters.add(r));
          await cmd('Page.navigate', { url: u });
          await loaded;
          return page;
        },
        // eval('document.title') or eval((a, b) => a + b, 1, 2). Args go through JSON.
        async eval(fn, ...args) {
          const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
          const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
          if (r.exceptionDetails) throw new Error(`In page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
          return r.result.value;
        },
        // A selector to appear, or a function (run in the page with `args`) to return something truthy, which is returned.
        async waitFor(what, { timeout = 8000, args = [] } = {}) {
          const check = typeof what === 'string' ? `!!document.querySelector(${JSON.stringify(what)})` : `(${what})(...${JSON.stringify(args)})`;
          for (const end = Date.now() + timeout; ; await sleep(40)) {
            const v = await page.eval(check).catch((e) => (Date.now() > end ? Promise.reject(e) : null));
            if (v) return v;
            if (Date.now() > end) throw new Error(`Timed out waiting for ${typeof what === 'string' ? what : what.toString().slice(0, 200)}`);
          }
        },
        async click(sel) {
          await page.waitFor(sel);
          await page.eval((s) => { const el = document.querySelector(s); el.scrollIntoView({ block: 'center' }); el.click(); }, sel);
        },
        // Sets the value like typing does, then fires input and change (both bubble).
        async fill(sel, text) {
          await page.waitFor(sel);
          await page.eval((s, v) => {
            const el = document.querySelector(s);
            el.focus();
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, sel, text);
        },
        async select(sel, value) {
          await page.waitFor(sel);
          await page.eval((s, v) => {
            const el = document.querySelector(s);
            if (![...el.options].some((o) => o.value === v)) throw new Error(`${s} has no option ${v}`);
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, sel, value);
        },
        text: (sel) => page.eval((s) => document.querySelector(s)?.textContent ?? null, sel),
        // Real key presses through Chrome's input pipeline (focus, default actions and all): press('k', { ctrl: true }).
        async press(key, { ctrl, shift, alt, meta } = {}) {
          const VK = { Enter: 13, Escape: 27, ' ': 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Tab: 9, Backspace: 8, '?': 191, '/': 191 };
          const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : { ' ': 'Space', '?': 'Slash', '/': 'Slash' }[key] ?? key;
          const text = key === 'Enter' ? '\r' : key.length === 1 && !ctrl && !meta ? key : undefined;
          const ev = { key, code, windowsVirtualKeyCode: VK[key] ?? key.toUpperCase().charCodeAt(0), modifiers: (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0) };
          await cmd('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, ...ev });
          await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
        },
        type: (text) => cmd('Input.insertText', { text }),
        async screenshot(file) {
          const { data } = await cmd('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(file, Buffer.from(data, 'base64'));
        },
        close: () => send('Target.closeTarget', { targetId }).catch(() => {}),
      };
      sessions.set(sessionId, (method, p) => {
        if (method === 'Page.loadEventFired') { waiters.forEach((r) => r()); waiters.clear(); }
        if (method === 'Runtime.exceptionThrown') page.consoleErrors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
        if (method === 'Runtime.consoleAPICalled' && p.type === 'error') page.consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(' '));
        if (method === 'Log.entryAdded' && p.entry.level === 'error') page.consoleErrors.push(`${p.entry.text} ${p.entry.url ?? ''}`.trim());
      });
      await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable'].map((m) => cmd(m)));
      return url ? page.goto(url) : page;
    },
    async close() {
      await send('Browser.close').catch(() => {});
      ws.close();
      if (proc.exitCode == null) await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
      proc.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
  return browser;
}
