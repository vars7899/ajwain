#!/usr/bin/env node
// A Claude Code PreToolUse hook: Claude never punches in or out of Zoho People. Attendance belongs to the
// person, who does it in VS Code (the status bar and the Workday box). This blocks the ways around that: Zoho's
// servers, the stored Zoho keys, the attendance settings, the CLI's attendance words, driving the desktop, and
// switching this guard off. Reading and searching code stays allowed: plain cat/grep/head pipelines and the Read
// tool. Contract: the tool call arrives as JSON on stdin; exit 2 blocks it and stderr tells Claude why.
// ponytail: pattern matching, not a sandbox. It backs up the skill's rule against slips; deliberate shell
// obfuscation could get past it.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const ZOHO = /\b(?:zoho\.(?:com\.au|com\.cn|com|in|eu|uk|jp|sa)|zohocloud\.ca|zohoapis\.[a-z.]+)\b/i;
const SECRETS = /secret-tool|kwallet|keyring|seahorse|org\.freedesktop\.secrets|\bsecurity\s+(?:find|dump)-|state\.vscdb/i;
const ATTEND = /\b(?:ajwain|cli\.mjs)\s+(?:punch|attend|zoho|check|clock)|ajwain\.(?:punch|zoho|attendance)|punchByHand|connectZoho|createZoho|people\/api\/attendance|Zoho-oauthtoken|ZOHOPEOPLE|\b(?:xdotool|ydotool|wtype)\b/i;
const SELF = /attendance-guard|\.claude\/settings|disableAllHooks|\bclaude\s+config\b/i;
const ATT_SETTING = /"ajwain\.(?:attendance|zoho)[^\n]*/g;
const KEEP = ['attendance-guard.mjs', 'Zoho People']; // in Claude's settings: the hook, and the auto-mode rule

// Read-only: every piece of the pipeline is a reading command, with nothing written or run on the side.
const READERS = /^(?:cat|head|tail|grep|egrep|fgrep|rg|wc|sort|uniq|cut|ls|find|stat|file|pwd|echo|cd|true)$/;
function readOnly(cmd) {
  if (/`|\$\(|<\(/.test(cmd)) return false; // these run commands even inside double quotes
  const c = cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, 'Q').replace(/\s2>\s*\/dev\/null|\s2>&1/g, ' ').replace(/&&|\|\|/g, ';');
  if (/[>&]|--pre\b|--compress-program|-exec|-ok|-delete|-fprint|-fls/.test(c)) return false;
  const parts = c.split(/[|;\n]/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((s) => READERS.test(s.split(/\s+/)[0]));
}

function edited(tool, i, before) {
  if (tool === 'Write') return String(i.content ?? '');
  if (tool === 'NotebookEdit') return before + String(i.new_source ?? '');
  const edits = tool === 'MultiEdit' ? i.edits ?? [] : [i];
  return edits.reduce((s, e) => (e.replace_all ? s.split(e.old_string).join(e.new_string) : s.replace(e.old_string, () => e.new_string)), before);
}
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

function verdict(tool, i) {
  if (tool === 'Bash') {
    const cmd = String(i.command ?? '');
    if (SECRETS.test(cmd)) return 'it reads where the Zoho keys are kept';
    if (readOnly(cmd)) return null;
    if (ATTEND.test(cmd) || ZOHO.test(cmd)) return 'it reaches for Zoho People attendance';
    if (SELF.test(cmd)) return "it changes this guard or Claude Code's settings from the shell";
    return null;
  }
  const path = String(i.file_path ?? i.notebook_path ?? '');
  if (tool === 'Read') return SECRETS.test(path) ? 'it reads where the Zoho keys are kept' : null;
  if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
    if (basename(path) === 'attendance-guard.mjs') return 'it changes this guard';
    if (SECRETS.test(path) || /\/extensions\/ajwain\./i.test(path)) return "it changes the installed Ajwain or VS Code's stored state";
    const before = read(path), after = edited(tool, i, before);
    if (/\/Code[^/]*\/User\/.*settings\.json$|\.vscode\/settings\.json$|\.code-workspace$/i.test(path)
      && String(before.match(ATT_SETTING)) !== String(after.match(ATT_SETTING))) return 'it changes the attendance settings';
    if (/\.claude\/settings(?:\.local)?\.json$|managed-settings\.json$/i.test(path)
      && (KEEP.some((k) => before.includes(k) && !after.includes(k)) || /"disableAllHooks"\s*:\s*true/.test(after))) return 'it switches this guard off';
    return null;
  }
  // WebFetch, MCP tools: anything pointed at Zoho or the attendance commands.
  const all = JSON.stringify(i);
  return ZOHO.test(all) || ATTEND.test(all) || SECRETS.test(all) ? 'it reaches for Zoho People attendance' : null;
}

let why;
try {
  const { tool_name: tool, tool_input: input } = JSON.parse(readFileSync(0, 'utf8'));
  why = verdict(tool, input ?? {});
} catch (e) {
  why = `the guard could not read the tool call (${e.message})`;
}
if (why) {
  process.stderr.write(`Blocked by Ajwain's attendance guard: ${why}. Claude never punches in or out of Zoho People, reads its keys or changes the attendance settings, even when asked; attendance is the person's own, in VS Code. For ordinary code work, read and search with the Read tool or a plain cat/grep/head pipeline.\n`);
  process.exit(2);
}
