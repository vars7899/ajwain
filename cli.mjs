#!/usr/bin/env node
// ajwain: Ajwain from the terminal, and the backend of the pm-tickets Claude skill.
// Output is laid out for people (tables, colour in a terminal); --raw prints the JSON instead, for scripts and jq.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  createClient, setApp, appFromApi, parseDuration, fmtDuration, branchName, startBranch, issueUrl, ticketQuality, issueTarget, mimeOf, fmtSize,
  TEMPLATES, MAX_ATTACHMENT, TYPES, PRIORITIES,
} from './pm.mjs';

const HELP = `ajwain: Ajwain CLI

  ajwain login [username] [--server URL]   (password prompt, or AJWAIN_PASSWORD; --server once, to say where the API is)
  ajwain logout | me | workspaces | projects
  ajwain statuses <PROJECT>            status names for a project key, e.g. ESG
  ajwain mine [--all]                  my open tickets (in the project chosen in VS Code; --all for every project)
  ajwain scope                         the workspace and project chosen in VS Code
  ajwain show <KEY>                    one ticket, e.g. ESG-12 (with health score, subtasks, attachments)
  ajwain summary <KEY> [--fresh]       AI summary of the ticket and its discussion
  ajwain comments <KEY>
  ajwain similar <PROJECT> <text|->    open tickets like this one (check before creating)
  ajwain template <TYPE>               description skeleton for a type
  ajwain quality <KEY>                 ticket health: score and checks with hints
  ajwain quality [fields]              ...of a draft, e.g. --title T --type BUG --estimate 2h --desc -
  ajwain draft <PROJECT> <text|->      AI: notes, thread or email -> ticket draft (prints it)
  ajwain draft <PROJECT> <text|-> --create [--type --priority --estimate]   ...and create it
  ajwain create <PROJECT> <title> [fields] [--no-assign]
  ajwain update <KEY> [fields]
  ajwain status <KEY> <status>         by name ("In review") or category (DONE)
  ajwain log <KEY> <duration> [note]   e.g. ajwain log ESG-12 1h30m "API wiring"
  ajwain comment <KEY> <text|->
  ajwain attach <KEY> <file...>        upload screenshots, logs… (20 MB each)
  ajwain attachments <KEY>             files with download links
  ajwain branch <KEY>                  print the branch name
  ajwain start <KEY> [--worktree]      branch (or sibling worktree) + assign me + In Progress
  ajwain standup [--fresh]             my standup as text (AI, or my queue when the AI is unavailable)

output: readable by default; --raw prints JSON (for scripts, jq and the Claude skill). NO_COLOR=1 turns colour off.
fields: --title --type ${TYPES.join('|')} --priority ${PRIORITIES.join('|')}
        --estimate 2h --due YYYY-MM-DD --parent KEY --status NAME --desc TEXT (--desc - reads stdin)
env:    AJWAIN_API=<url> the server's API address (default: the one from login --server, or VS Code's ajwain.apiUrl)
        AJWAIN_APP=<url> the web app, for ticket links (default: guessed from the API address, api -> app)
        AJWAIN_WORKSPACE=<id> to pick a workspace (default: your first)
        AJWAIN_BRANCH_TEMPLATE, e.g. "{key}-{slug}" (default "{type}/{key}-{slug}")`;

const DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ajwain');
const FILE = path.join(DIR, 'tokens.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return {}; } };
// The server: AJWAIN_API, or server.json, which `ajwain login --server` writes and the VS Code extension keeps in
// step with its ajwain.apiUrl setting.
const SERVER = readJson('server.json');
const apiBase = () => process.env.AJWAIN_API || SERVER.api || '';
const linkApp = () => setApp(process.env.AJWAIN_APP || SERVER.app || appFromApi(apiBase()));
linkApp();
const api = createClient({
  base: apiBase,
  load: () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } },
  save: (t) => {
    if (!t) return fs.rmSync(FILE, { force: true });
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(t), { mode: 0o600 });
  },
});

const git = (cwd, ...args) =>
  new Promise((res, rej) => execFile('git', args, { cwd }, (e, out, err) => (e ? rej(new Error(err.trim() || e.message)) : res(out.trim()))));
const oneOf = (v, allowed) => {
  if (!allowed.includes(v.toUpperCase())) throw new Error(`"${v}" must be one of ${allowed.join(', ')}`);
  return v.toUpperCase();
};
const text = (v) => (v === '-' ? fs.readFileSync(0, 'utf8') : v);
const TEMPLATE = process.env.AJWAIN_BRANCH_TEMPLATE;
// The workspace and project chosen in the VS Code extension (it writes scope.json whenever they change).
const SCOPE = readJson('scope.json');
const workspace = async () => process.env.AJWAIN_WORKSPACE || SCOPE.workspace || (await api.workspaces())[0]?.id;
const rows = (d) => (Array.isArray(d) ? d : d?.results ?? []); // pm.mjs's list(), not exported
const same = (a, b) => String(a ?? '') === String(b ?? '');
const userName = (u) => (u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.username : '');
// The app's AI: 400 = nothing to work with, 429 = busy.
const ai = (p) => p.catch((e) => {
  if (e.status === 429) e.message = 'The AI assistant is busy, try again in a minute';
  throw e;
});
const brief = (i) => ({
  key: i.key, title: i.title, type: i.issue_type, priority: i.priority, status: i.status_detail?.name,
  estimate: fmtDuration(i.estimate_minutes), logged: fmtDuration(i.logged_minutes), due: i.due_date, url: issueUrl(i.key) || null,
});

async function ask(question, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = rl.question(question);
  if (hidden) rl._writeToOutput = () => {}; // mute echo after the prompt is printed
  const a = await answer;
  rl.close();
  if (hidden) process.stderr.write('\n');
  return a;
}

async function fields(o, project) {
  const f = {};
  if (o.title) f.title = o.title;
  if (o.type) f.issue_type = oneOf(o.type, TYPES);
  if (o.priority) f.priority = oneOf(o.priority, PRIORITIES);
  if (o.estimate) f.estimate_minutes = parseDuration(o.estimate);
  if (o.desc !== undefined) f.description = text(o.desc);
  if (o.due !== undefined) f.due_date = o.due || null;
  if (o.parent) f.parent = (await api.issue(o.parent)).id;
  if (o.status) f.status = (await api.findStatus(project, o.status)).id;
  return f;
}

const commands = {
  async login([username], o) {
    if (o.server) {
      if (!/^https?:\/\/[^\s/]+/.test(o.server)) throw new Error('--server takes an address starting with https://');
      Object.assign(SERVER, { api: o.server.trim().replace(/\/+$/, ''), app: undefined });
      SERVER.app = process.env.AJWAIN_APP || appFromApi(SERVER.api);
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(path.join(DIR, 'server.json'), JSON.stringify(SERVER));
      linkApp();
    }
    username ||= await ask('Username: ');
    const me = await api.login(username, process.env.AJWAIN_PASSWORD || (await ask('Password: ', true)));
    return { signed_in: me.username ?? username };
  },
  logout: async () => (await api.logout(), { signed_out: true }),
  me: () => api.me(),
  workspaces: () => api.workspaces(),
  projects: async () => (await api.projects(await workspace())).map((p) => ({ key: p.key, name: p.name, id: p.id })),
  statuses: async ([project]) => (await api.statuses((await api.projectByKey(project)).id)).map((s) => ({ name: s.name, category: s.category })),
  mine: async (_, o) => (await api.myIssues(await workspace(), (await api.me()).id))
    .filter((i) => o.all || !SCOPE.project || String(i.project?.id ?? i.project) === String(SCOPE.project)).map(brief),
  async scope() {
    const p = SCOPE.project && (await api.projects().catch(() => [])).find((p) => same(p.id, SCOPE.project));
    return { workspace: SCOPE.workspace ?? null, project: SCOPE.project ?? null, ...(p && { key: p.key, name: p.name }) };
  },
  show: async ([key]) => {
    const i = await api.issue(key);
    return {
      ...brief(i), score: ticketQuality(i).score, branch: branchName(i, TEMPLATE), description: i.description,
      ...(i.children?.length && { children: i.children.map((c) => ({ key: c.key, title: c.title, status: c.status_detail?.name })) }),
      ...(i.attachments?.length && { attachments: i.attachments.map((a) => a.name) }),
    };
  },
  async summary([key], o) {
    const i = await api.issue(key);
    const s = await ai(api.summary(i.id, o.fresh));
    return { key: i.key, text: s?.text ?? '', generated_at: s?.generated_at ?? null };
  },
  async comments([key]) {
    const cs = await api.comments((await api.issue(key)).id);
    const members = new Map();
    if (cs.some((c) => !c.author_detail && typeof c.author !== 'object'))
      for (const m of rows(await api.req('/api/members/').catch(() => []))) {
        const u = m.user && typeof m.user === 'object' ? m.user : m;
        members.set(String(u.id), u);
      }
    const author = (c) => userName(c.author_detail ?? (typeof c.author === 'object' ? c.author : members.get(String(c.author)))) || String(c.author ?? '');
    return cs.map((c) => ({ author: author(c), body: c.body, created_at: c.created_at }));
  },
  async similar([project, ...q]) {
    if (!project || !q.length) throw new Error('usage: ajwain similar <PROJECT> <text|->');
    const found = await api.similar((await api.projectByKey(project)).id, text(q.join(' ')));
    // /api/issues/similar/ returns the status name and category on each match (like the app shows them).
    return found.filter((i) => (i.category ?? i.status_detail?.category) !== 'DONE')
      .map((i) => ({ key: i.key, title: i.title, status: i.status_detail?.name ?? i.status }));
  },
  template: async ([type]) => TEMPLATES[oneOf(type || 'TASK', TYPES)],
  // A saved ticket by key, or a draft from the field flags.
  async quality([key], o) {
    if (!key) return ticketQuality(await fields(o));
    const i = await api.issue(key);
    return { key: i.key, ...ticketQuality(i) };
  },
  async draft([project, ...notes], o) {
    if (!project || !notes.length) throw new Error('usage: ajwain draft <PROJECT> <text|-> [--create]');
    const p = await api.projectByKey(project);
    const d = await ai(api.draft(p.id, text(notes.join(' '))));
    const draft = { title: d.title, description: d.description ?? '', issue_type: d.issue_type ?? 'TASK', priority: d.priority ?? 'MEDIUM', tags: d.tags ?? [] };
    if (!o.create) return draft;
    // Draft tags may be names or ids; keep the ones that exist in the workspace.
    let tags = [];
    if (draft.tags.length) {
      const all = rows(await api.req(`/api/tags/?workspace=${p.workspace?.id ?? p.workspace ?? (await workspace())}`).catch(() => []));
      const t = (x) => all.find((a) => same(a.id, x?.id ?? x) || String(a.title ?? a.name).toLowerCase() === String(x?.title ?? x?.name ?? x).toLowerCase());
      tags = draft.tags.map((x) => t(x)?.id).filter((id) => id != null);
    }
    const { title, tags: _, ...rest } = draft;
    return commands.create([project, title], o, { ...rest, ...(tags.length && { tags }) });
  },
  // extra: fields from a draft, under the flags.
  async create([project, title], o, extra = {}) {
    if (!project || !title) throw new Error('usage: ajwain create <PROJECT> <title> [fields]');
    const p = await api.projectByKey(project);
    const [first] = await api.statuses(p.id);
    const body = { project: p.id, title, issue_type: 'TASK', priority: 'MEDIUM', ...(first && { status: first.id }), ...extra, ...(await fields(o, p.id)) };
    if (!o['no-assign']) body.assignee = (await api.me()).id;
    return brief(await api.create(body));
  },
  async update([key], o) {
    const i = await api.issue(key);
    return brief({ ...i, ...(await api.update(i.id, await fields(o, i.project))) });
  },
  status: ([key, status], o) => commands.update([key], { ...o, status }),
  async log([key, duration, ...note]) {
    const i = await api.issue(key);
    await api.logWork(i.id, parseDuration(duration), note.join(' '));
    return { logged: fmtDuration(parseDuration(duration)), on: key };
  },
  async comment([key, body]) {
    const i = await api.issue(key);
    await api.comment(i.id, text(body));
    return { commented: key };
  },
  async attach([key, ...files]) {
    if (!key || !files.length) throw new Error('usage: ajwain attach <KEY> <file...>');
    for (const f of files) if (fs.statSync(f).size > MAX_ATTACHMENT) throw new Error(`${f} is larger than 20 MB`); // check all before uploading any
    const i = await api.issue(key);
    const out = [];
    for (const f of files) {
      const bytes = fs.readFileSync(f), name = path.basename(f);
      const a = await api.attach(issueTarget(i), { name, bytes, type: mimeOf(name) });
      out.push({ id: a?.id, name: a?.name ?? name, size: fmtSize(bytes.length) });
    }
    return out;
  },
  async attachments([key]) {
    const list = (await api.issue(key)).attachments ?? [];
    return Promise.all(list.map(async (a) => ({
      id: a.id, name: a.name, size: a.size != null ? fmtSize(a.size) : null,
      url: (await api.attachmentUrl(a.id).catch(() => null))?.url ?? null,
    })));
  },
  async standup(_, o) {
    const [me, ws] = await Promise.all([api.me(), workspace()]);
    if (me.ai_enabled !== false) {
      try {
        const s = await api.aiStandup(me.id, ws, o.fresh);
        if (s?.text) return s.text;
      } catch (e) {
        if (e.status === 401 || !e.status) throw e;
        if (e.status === 429) console.error('The AI assistant is busy, try again in a minute. Your queue meanwhile:\n');
      }
    }
    const mine = await api.myIssues(ws, me.id);
    const lines = (xs) => (xs.length ? xs.map((i) => `- ${i.key} ${i.title}${i.status_detail?.name ? ` (${i.status_detail.name})` : ''}`) : ['- nothing']);
    const doing = (i) => i.status_detail?.category === 'IN_PROGRESS';
    return ['In progress', ...lines(mine.filter(doing)), '', 'Up next', ...lines(mine.filter((i) => !doing(i)))].join('\n');
  },
  branch: async ([key]) => branchName(await api.issue(key), TEMPLATE),
  async start([key], o) {
    const i = await api.issue(key);
    // The server first: a workspace may refuse to start a ticket without an estimate, and that's better known before a branch exists.
    await api.startIssue(i, (await api.me()).id).catch((e) => {
      throw e.errors?.estimate_minutes ? new Error(`${e.message} Set one, then start again: ajwain update ${key} --estimate 2h`) : e;
    });
    const r = await startBranch(git, process.cwd(), i, !!o.worktree, TEMPLATE);
    return { ...r, key, status: 'started' };
  },
};

// ---------- readable output ----------
// Colour only on a terminal, and never with NO_COLOR. Widths are measured without the colour codes.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1'), dim = paint('2'), red = paint('31'), green = paint('32'), yellow = paint('33'), cyan = paint('36'), orange = paint('38;5;208');
const WIDTH = Math.max(60, process.stdout.columns || 100);
const cut = (s, w) => (s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s);
const ok = (s) => `${green('✓')} ${s}`;
const today = () => new Date().toLocaleDateString('en-CA');
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const late = (d) => !!d && String(d).slice(0, 10) < today();
const soon = (d) => !!d && String(d).slice(0, 10) <= new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA');
const dueText = (d) => (late(d) ? red(`${day(d)}, overdue`) : soon(d) ? yellow(day(d)) : day(d));
const ARROW = { HIGHEST: '⇈', HIGH: '↑', MEDIUM: '=', LOW: '↓', LOWEST: '⇊' };
const prio = (p) => (p ? `${ARROW[p] ?? ''} ${p[0]}${p.slice(1).toLowerCase()}` : '');
const prioColor = (s, p) => (p === 'HIGHEST' ? red(s) : p === 'HIGH' ? orange(s) : s);
const typeName = (t) => (t ? t[0] + t.slice(1).toLowerCase() : '');
const overEstimate = (i) => { try { return !!i.logged && parseDuration(i.logged) > parseDuration(i.estimate); } catch { return false; } };
const time = (i) => (i.estimate ? `${i.logged || '0m'}/${i.estimate}` : i.logged || '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  for (const [u, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]])
    if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v === 1 ? '' : 's'} ago`; }
  return 'just now';
};
// A table: plain cells cut to fit, then coloured. The last column takes what's left of the terminal.
function table(items, cols) {
  if (!items.length) return '';
  const cells = items.map((it) => cols.map((c) => String(c.get(it) ?? '')));
  const w = cols.map((c, k) => Math.max(c.head.length, ...cells.map((r) => r[k].length)));
  w[w.length - 1] = Math.max(12, Math.min(w.at(-1), WIDTH - w.slice(0, -1).reduce((a, x) => a + x + 2, 0)));
  const line = (r, it) => r.map((v, k) => {
    const t = cut(v, w[k]), shown = it && cols[k].color ? cols[k].color(t, it) : t;
    return k === r.length - 1 ? shown : shown + ' '.repeat(w[k] - t.length);
  }).join('  ');
  return [dim(line(cols.map((c) => c.head.toUpperCase()))), ...cells.map((r, n) => line(r, items[n]))].join('\n');
}
const COL = {
  key: { head: 'key', get: (i) => i.key, color: (s) => bold(s) },
  type: { head: 'type', get: (i) => typeName(i.type) },
  status: { head: 'status', get: (i) => i.status, color: (s) => cyan(s) },
  priority: { head: 'priority', get: (i) => prio(i.priority), color: (s, i) => prioColor(s, i.priority) },
  time: { head: 'time', get: time, color: (s, i) => (overEstimate(i) ? red(s) : s) },
  due: { head: 'due', get: (i) => day(i.due), color: (s, i) => (late(i.due) ? red(s) : soon(i.due) ? yellow(s) : s) },
  title: { head: 'title', get: (i) => i.title },
};
// Markdown, lightly dressed and indented: headings bold, checklists as boxes.
const inline = (l) => l.replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t)).replace(/`([^`]+)`/g, (_, t) => cyan(t));
const markdown = (md) => String(md ?? '').trim().split('\n').map((l) => {
  if (!l.trim()) return '';
  const h = l.match(/^#{1,6}\s+(.*)/);
  if (h) return `  ${bold(h[1])}`;
  return `  ${inline(l.replace(/^(\s*)[-*] \[ \]/, '$1☐').replace(/^(\s*)[-*] \[[xX]\]/, `$1${green('☑')}`))}`;
}).join('\n');
const field = (label, value) => (value ? `${dim(label.padEnd(9))}${value}` : '');
const lines = (...xs) => xs.filter((x) => x !== '' && x != null && x !== false && x !== 0).join('\n');
const ticketLine = (i) => `${bold(i.key)}  ${i.title}`;
const facts = (i) => [typeName(i.type), prioColor(prio(i.priority).trim(), i.priority), i.status && cyan(i.status),
  i.estimate && `${i.logged || '0m'} of ${i.estimate}`, i.due && `due ${dueText(i.due)}`].filter(Boolean).join(dim(' · '));
const rule = (n = 40) => dim('─'.repeat(Math.min(WIDTH, n)));
const score = (n) => (n >= 80 ? green : n >= 50 ? yellow : red)(`${n}%`);

// Anything without its own layout: an object as label/value lines, a list of objects as a table.
function plain(out) {
  if (out == null) return '';
  if (Array.isArray(out)) {
    if (!out.length) return dim('Nothing.');
    if (typeof out[0] !== 'object') return out.join('\n');
    const keys = Object.keys(out[0]).filter((k) => out.every((x) => x[k] == null || typeof x[k] !== 'object'));
    return table(out, keys.map((k) => ({ head: k, get: (x) => x[k] ?? '' })));
  }
  if (typeof out !== 'object') return String(out);
  return Object.entries(out).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => field(k, String(v))).join('\n');
}

const PRETTY = {
  login: (r) => ok(`Signed in as ${bold(r.signed_in)}`),
  logout: () => ok('Signed out'),
  me: (u) => lines(`${bold(`${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.username)} ${dim(`(${u.username})`)}`, field('email', u.email), field('AI', u.ai_enabled === false ? 'off' : 'on')),
  workspaces: (ws) => table(ws, [{ head: 'name', get: (w) => w.name, color: (s) => bold(s) }, { head: 'id', get: (w) => w.id, color: (s) => dim(s) }]),
  projects: (ps) => table(ps, [{ head: 'key', get: (p) => p.key, color: (s) => bold(s) }, { head: 'name', get: (p) => p.name }, { head: 'id', get: (p) => p.id, color: (s) => dim(s) }]),
  statuses: (ss) => table(ss, [{ head: 'status', get: (s) => s.name, color: (s) => cyan(s) }, { head: 'category', get: (s) => s.category, color: (s) => dim(s) }]),
  scope: (s) => (s.project ? `${bold(s.key ?? s.project)}${s.name ? `  ${s.name}` : ''}` : `All projects${s.workspace ? '' : dim(' (nothing chosen in VS Code yet)')}`),
  mine: (xs, { o }) => {
    const scoped = !o.all && SCOPE.project;
    if (!xs.length) return dim(scoped ? 'Nothing open is assigned to you in this project. --all looks in every project.' : 'Nothing open is assigned to you.');
    return `${table(xs, [COL.key, COL.type, COL.status, COL.priority, COL.time, COL.due, COL.title])}\n\n${dim(`${plural(xs.length, 'open ticket')}${scoped ? ' in the project chosen in VS Code · --all for every project' : ''}`)}`;
  },
  show: (i) => lines(
    ticketLine(i), rule(i.key.length + 2 + i.title.length), facts(i),
    field('health', score(i.score)), field('branch', i.branch), field('link', i.url && dim(i.url)),
    i.description?.trim() ? `\n${markdown(i.description)}` : `\n${dim('  No description.')}`,
    i.children?.length && `\n${bold('Subtasks')}\n${i.children.map((c) => `  ${/done|closed/i.test(c.status ?? '') ? green('✓') : dim('·')} ${bold(c.key)}  ${c.title}  ${dim(c.status ?? '')}`).join('\n')}`,
    i.attachments?.length && `\n${bold('Attachments')}\n${i.attachments.map((a) => `  ${a}`).join('\n')}`,
  ),
  create: (i) => lines(ok(`Created ${ticketLine(i)}`), `  ${facts(i)}`, i.url && `  ${dim(i.url)}`),
  update: (i) => lines(ok(`Updated ${ticketLine(i)}`), `  ${facts(i)}`),
  status: (i) => ok(`${bold(i.key)} is now ${cyan(i.status)}`),
  draft: (d, ctx) => (ctx.o.create ? PRETTY.create(d) : lines(
    bold(d.title), `${typeName(d.issue_type)}${dim(' · ')}${prioColor(prio(d.priority).trim(), d.priority)}${d.tags?.length ? dim(` · tags: ${d.tags.map((t) => t?.title ?? t?.name ?? t).join(', ')}`) : ''}`,
    `\n${markdown(d.description)}`, `\n${dim('A draft: nothing was created. Add --create to create it.')}`,
  )),
  log: (r) => ok(`Logged ${bold(r.logged)} on ${bold(r.on)}`),
  comment: (r) => ok(`Commented on ${bold(r.commented)}`),
  attach: (xs, { args }) => lines(ok(`Attached ${plural(xs.length, 'file')} to ${bold(args[0])}`), ...xs.map((a) => `  ${a.name}  ${dim(a.size)}`)),
  attachments: (xs) => (xs.length ? xs.map((a) => lines(`${bold(a.name)}  ${dim(a.size ?? '')}`, a.url && `  ${dim(a.url)}`)).join('\n') : dim('No attachments.')),
  comments: (cs) => (cs.length ? cs.map((c) => `${bold(c.author)}  ${dim(ago(c.created_at))}\n${markdown(c.body)}`).join(`\n${rule()}\n`) : dim('No comments yet.')),
  similar: (xs) => (xs.length ? `${table(xs, [COL.key, COL.status, COL.title])}\n\n${dim('Open tickets like this. Comment on one of them instead of filing a duplicate?')}` : dim('No open tickets like that.')),
  summary: (s) => lines(bold(s.key), '', markdown(s.text), s.generated_at && `\n${dim(`Written ${ago(s.generated_at)} by the server's AI. --fresh rewrites it.`)}`),
  quality: (q) => {
    const n = Math.round(q.score / 10), tone = q.score >= 80 ? green : q.score >= 50 ? yellow : red;
    return lines(`${q.key ? `${bold(q.key)}  ` : ''}${dim('health')} ${tone('█'.repeat(n))}${dim('░'.repeat(10 - n))} ${score(q.score)}`,
      ...q.checks.map((c) => (c.ok ? `  ${green('✓')} ${c.label}` : `  ${c.warn ? red('!') : yellow('✗')} ${c.label}${dim(` · ${c.hint}`)}`)));
  },
  start: (r) => lines(ok(`Started ${bold(r.key)}: assigned to you, in progress`), field('branch', r.branch), field('folder', r.path)),
};

const str = { type: 'string' };
const { values: o, positionals: [cmd, ...args] } = parseArgs({
  allowPositionals: true,
  options: {
    title: str, type: str, priority: str, estimate: str, desc: str, due: str, parent: str, status: str,
    worktree: { type: 'boolean' }, all: { type: 'boolean' }, 'no-assign': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    fresh: { type: 'boolean' }, create: { type: 'boolean' }, server: str, raw: { type: 'boolean' },
  },
});

// Attendance is deliberately not here: punching in or out of Zoho People is for a person, in VS Code. Nothing
// that drives this CLI (scripts, Claude) can punch.
if (/punch|attend|zoho|check-?in|check-?out|clock-?(in|out)/i.test(cmd ?? '')) {
  console.error(`ajwain ${cmd}: attendance (Zoho People) is not available from the command line, by design. Punch from the Ajwain status bar or the Workday box in VS Code.`);
  process.exit(2);
}
if (!cmd || o.help || !commands[cmd]) {
  console.log(HELP);
  process.exit(cmd && !o.help ? 1 : 0);
}
try {
  const out = await commands[cmd](args, o);
  console.log(typeof out === 'string' ? out : o.raw ? JSON.stringify(out, null, 2) : (PRETTY[cmd] ?? plain)(out, { args, o }));
} catch (e) {
  const hint = e.noServer ? ': run `ajwain login --server https://your-server`, or sign in once from VS Code' : e.status === 401 ? ' (run: ajwain login)' : '';
  console.error(`ajwain ${cmd}: ${e.message}${hint}`);
  process.exit(1);
}
