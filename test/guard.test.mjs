// skills/pm-tickets/attendance-guard.mjs, the Claude Code hook that keeps Claude away from attendance: tool calls
// go in on stdin as Claude Code sends them; exit 2 means blocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../skills/pm-tickets/attendance-guard.mjs', import.meta.url));
const run = (tool_name, tool_input, raw) => spawnSync(process.execPath, [GUARD], { input: raw ?? JSON.stringify({ tool_name, tool_input }), encoding: 'utf8' });
const blocked = (tool, input) => { const r = run(tool, input); assert.equal(r.status, 2, `should block ${tool} ${JSON.stringify(input)}`); assert.match(r.stderr, /attendance guard/); };
const allowed = (tool, input) => { const r = run(tool, input); assert.equal(r.status, 0, `should allow ${tool} ${JSON.stringify(input)}: ${r.stderr}`); };

test('the shell: no punching, no Zoho, no keys, no settings, no desktop driving, no switching the guard off', () => {
  for (const command of [
    'ajwain punch in',
    'node cli.mjs clock-out',
    "curl -X POST 'https://people.zoho.in/people/api/attendance' -d checkIn=now",
    'node -e "fetch(\'https://accounts.zoho.com/oauth/v2/token\')"',
    'python3 x.py --host zohoapis.eu',
    'secret-tool lookup service ajwain',
    'cat ~/.config/Code/User/globalStorage/state.vscdb | strings',
    'security find-generic-password -s ajwain',
    `sed -i 's/"ajwain.attendance.in": "09:00"/"ajwain.attendance.in": "11:00"/' ~/.config/Code/User/settings.json`,
    'xdotool key ctrl+shift+p',
    'rm skills/pm-tickets/attendance-guard.mjs',
    "jq 'del(.hooks)' ~/.claude/settings.json > /tmp/s && mv /tmp/s ~/.claude/settings.json",
    'grep -n punchByHand extension.js > /tmp/found', // writes a file: not a plain read any more
    'find . -name "*.mjs" -exec grep -l createZoho {} +',
  ]) blocked('Bash', { command });
});

test('the shell: ordinary work goes through, including reading and searching the attendance code', () => {
  for (const command of [
    'npm test',
    'node --test test/zoho.test.mjs',
    'AJWAIN_ZOHO_PEOPLE=http://127.0.0.1:9 node --test test/lead-host-features.test.mjs',
    'grep -n "punchByHand\\|createZoho" extension.js | head -20',
    'cat docs/ATTENDANCE.md | grep -c people.zoho.in 2>/dev/null',
    'cd media && grep -rn ajwain.attendance . | wc -l',
    'ajwain mine --all',
    'npm run package && code --install-extension ajwain-0.12.0.vsix --force',
  ]) allowed('Bash', { command });
});

test('files: the keys, the installed extension and the guard are off limits; the attendance settings cannot change', () => {
  blocked('Read', { file_path: '/home/sam/.local/share/keyrings/login.keyring' });
  allowed('Read', { file_path: '/home/sam/ajwain/zoho.mjs' });
  blocked('Write', { file_path: '/home/sam/.claude/skills/pm-tickets/attendance-guard.mjs', content: '' });
  blocked('Edit', { file_path: '/home/sam/.vscode/extensions/ajwain.ajwain-0.12.0/extension.js', old_string: 'a', new_string: 'b' });
  allowed('Edit', { file_path: '/home/sam/ajwain/zoho.mjs', old_string: 'createZoho', new_string: 'createZoho' });

  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const vs = join(dir, 'Code', 'User', 'settings.json');
  mkdirSync(join(dir, 'Code', 'User'), { recursive: true });
  writeFileSync(vs, '{\n  "ajwain.attendance.punchIn": "off",\n  "editor.fontSize": 13\n}\n');
  blocked('Edit', { file_path: vs, old_string: '"ajwain.attendance.punchIn": "off"', new_string: '"ajwain.attendance.punchIn": "auto"' });
  blocked('Edit', { file_path: vs, old_string: '  "ajwain.attendance.punchIn": "off",\n', new_string: '' }); // removing it brings back the default
  blocked('Write', { file_path: vs, content: '{ "editor.fontSize": 14 }' });
  allowed('Edit', { file_path: vs, old_string: '"editor.fontSize": 13', new_string: '"editor.fontSize": 14' });

  const cs = join(dir, '.claude', 'settings.json');
  mkdirSync(join(dir, '.claude'));
  writeFileSync(cs, '{\n  "theme": "dark",\n  "hooks": { "PreToolUse": [{ "hooks": [{ "type": "command", "command": "node", "args": ["/x/attendance-guard.mjs"] }] }] }\n}\n');
  blocked('Write', { file_path: cs, content: '{ "theme": "dark" }' });
  blocked('Edit', { file_path: cs, old_string: '"theme": "dark",', new_string: '"theme": "dark", "disableAllHooks": true,' });
  allowed('Edit', { file_path: cs, old_string: '"theme": "dark"', new_string: '"theme": "light"' });
});

test('other tools pointed at Zoho or the attendance commands are blocked; a garbled call is blocked', () => {
  blocked('WebFetch', { url: 'https://people.zoho.in/people/api/attendance/getAttendanceEntries', prompt: 'x' });
  allowed('WebFetch', { url: 'https://example.com', prompt: 'x' });
  blocked('mcp__vscode__executeCommand', { command: 'ajwain.punch' });
  assert.equal(run(null, null, 'not json').status, 2);
});
