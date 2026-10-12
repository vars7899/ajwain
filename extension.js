// Ajwain for VS Code. Plain CommonJS, no build step; the API client is the shared ESM pm.mjs.
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const crypto = require('crypto');

const REMINDER_ACTIONS = {
  today: { label: 'Open Today', detail: 'Log time from your commits, ticket untracked work, plan what is next', message: 'Wrap up: log time and ticket any untracked work' },
  create: { label: 'Create ticket', detail: 'Open the new-ticket form', message: 'Anything you did that has no ticket yet?' },
  logTime: { label: 'Log time', detail: 'Log time on a ticket', message: 'Log your time' },
  board: { label: 'Open board', detail: 'Open the board', message: 'Check the board' },
  shutdown: { label: 'Wind down', detail: "Log today's time, pick tomorrow's first ticket, note where you left off", message: 'Time to wind down' },
  wrapped: { label: 'See my week', detail: 'Your week, wrapped: shipped, logged, streaks, badges', message: 'Your week, wrapped' },
  standup: { label: 'Write standup', detail: "Yesterday's commits by ticket and today's plan, ready to paste", message: 'Standup: yesterday, today, blockers' },
  message: { label: '', detail: 'Just show the message', message: 'Reminder' },
};

// Zoho People attendance is switched off for now: Zoho refuses API access to our roles ("your role is not allowed
// to access api's"). Off, there's no status bar timer, Workday box, pop-up, command or call to Zoho. To bring it
// back: true here, and the commands and settings in dev/attendance.contributes.json back into package.json.
const ATTENDANCE = false;
let pm, Z, zoho, zohoOn = false, punchBar, icons, api, me, server, ctx, log, currentKey, panel, side, pendingOpen, timerBar, focusBar, breakPanel, treeView, projects = [], myIssues = [];
const changed = new vscode.EventEmitter(); // sidebar tree + status bar
// Both webviews, the board tab and the sidebar's Home view, hear about refreshes, the timer, the scope and the journal.
const post = (m) => { for (const w of [panel?.webview, side?.webview]) try { w?.postMessage(m)?.then?.(undefined, () => {}); } catch { /* disposed */ } };
const refresh = () => { changed.fire(); post({ type: 'refresh' }); };
const cfg = () => vscode.workspace.getConfiguration('ajwain');
// The server: its API address (asked for at the first sign-in) and the web app's, for links to tickets.
const cleanUrl = (u) => String(u ?? '').trim().replace(/\/+$/, '');
const apiUrl = () => cleanUrl(cfg().get('apiUrl'));
const appUrl = () => cleanUrl(cfg().get('appUrl')) || pm.appFromApi(apiUrl());
async function askServer() {
  const u = await input("Your project management server's API address", {
    value: apiUrl(), placeHolder: 'https://pm-api.example.com', validateInput: (v) => (/^https?:\/\/[^\s/]+/.test(v.trim()) ? null : 'An address starting with https://'),
  });
  if (!u) return false;
  await cfg().update('apiUrl', cleanUrl(u), vscode.ConfigurationTarget.Global);
  return true;
}
function webUrl(key) {
  const url = pm.issueUrl(key);
  if (!url) throw new Error("Set ajwain.appUrl (the web app's address) to open tickets in the browser");
  return vscode.Uri.parse(url);
}
const same = (a, b) => String(a ?? '') === String(b ?? '');
// The scope (PM workspace + project) lives in settings, the single source of truth: the board, the sidebar,
// pickers, every VS Code window and the CLI all follow it, and changing it anywhere updates them all.
const scopeProject = () => cfg().get('project') || null; // null = all projects
async function setScope({ workspace, project }) {
  const G = vscode.ConfigurationTarget.Global;
  if (workspace !== undefined) await cfg().update('workspace', String(workspace), G);
  if (project !== undefined) await cfg().update('project', project ? String(project) : '', G);
}
const projectName = (id) => projects.find((p) => same(p.id, id))?.name;

// ---------- journal: what you did through Ajwain (drives streaks, badges and the weekly wrap-up) ----------
const journal = () => ctx.globalState.get('ajwain.journal') ?? [];
async function record(type, data = {}) {
  const j = [...journal(), { t: Date.now(), type, ...data }].slice(-5000);
  await ctx.globalState.update('ajwain.journal', j);
  // Badges stay unlocked once earned, even after old journal entries roll off.
  const unlocked = ctx.globalState.get('ajwain.unlocked') ?? {};
  const fresh = pm.badges(j).filter((b) => b.unlockedAt && !unlocked[b.id]);
  if (fresh.length) {
    await ctx.globalState.update('ajwain.unlocked', { ...unlocked, ...Object.fromEntries(fresh.map((b) => [b.id, b.unlockedAt])) });
    for (const b of fresh) celebrate('badge', `Badge unlocked: ${b.name}`, b.hint, b.icon);
  }
  post({ type: 'journal' });
}
const EMOJI = { ship: '🚀', finish: '🎉', badge: '🏆', streak: '🔥', log: '⏱️' };
function celebrate(kind, title, detail = '', icon) {
  if (!cfg().get('fun.celebrations')) return;
  if (panel?.visible) panel.webview.postMessage({ type: 'celebrate', kind, title, detail, icon });
  else vscode.window.showInformationMessage(`${EMOJI[kind] ?? '✨'} ${title}${detail ? ` · ${detail}` : ''}`);
}
async function logWork(issue, minutes, note = '') {
  await api.logWork(issue.id, minutes, note);
  await record('log', { key: issue.key, minutes });
}

const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }; // fail fast instead of waiting on a credential prompt
const run = (bin, args, opts = {}) =>
  new Promise((res, rej) => execFile(bin, args, { maxBuffer: 16 << 20, env, ...opts }, (e, out, err) => (e ? rej(new Error((err || e.message).trim())) : res(out.trim()))));
const git = (cwd, ...args) => run('git', args, { cwd });
// A CLI on PATH or in the usual install dirs (VS Code's PATH can miss snap and ~/.local/bin).
function findBin(name, setting) {
  if (setting && cfg().get(setting)) return cfg().get(setting);
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/snap/bin', '/usr/local/bin', '/opt/homebrew/bin'];
  return dirs.map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) ?? null;
}
const branchOf = (i) => pm.branchName(i, cfg().get('branchTemplate'));
async function repoRoot() {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) throw new Error('Open a git repository first');
  return git(f.uri.fsPath, 'rev-parse', '--show-toplevel');
}
// The main checkout, even when this window is a worktree: worktrees are created next to it.
const mainRoot = async (root) => path.dirname(await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
const defaultBranch = async (root) => (await git(root, 'rev-parse', '--abbrev-ref', 'origin/HEAD').catch(() => 'origin/main')).replace(/^origin\//, '');
const cmdUri = (c, ...a) => `command:${c}?${encodeURIComponent(JSON.stringify(a))}`;
const cap = (s) => (s ? s[0] + s.slice(1).toLowerCase() : '');

const pick = (items, placeHolder) => vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, ignoreFocusOut: true });
const input = (prompt, opts = {}) => vscode.window.showInputBox({ prompt, ignoreFocusOut: true, ...opts });
const validDuration = (v) => { try { pm.parseDuration(v); } catch (e) { return e.message; } };
const docUri = (key) => vscode.Uri.parse(`ajwain:/${key}.md`);
const statusName = (i) => i.status_detail?.name ?? 'No status';
const timeText = (i) => i.estimate_minutes ? `${pm.fmtDuration(i.logged_minutes) || '0m'} / ${pm.fmtDuration(i.estimate_minutes)}` : pm.fmtDuration(i.logged_minutes);

// Branches without a key in their name can be linked to a ticket by hand (after a commit, or from Today).
// ponytail: keyed by branch name only; per-repo keys if two repos ever reuse a branch name.
const links = () => ctx.globalState.get('ajwain.branchLinks') ?? {};
// A key written in the commit message wins over the branch's, e.g. a quick fix for another ticket on this branch.
const keyFor = (branch, subject) => pm.ticketKey(subject) ?? pm.ticketKey(branch) ?? links()[branch] ?? null;
const linkBranch = (branch, key) => ctx.globalState.update('ajwain.branchLinks', { ...links(), [branch]: key });

async function activate(context) {
  ctx = context;
  // Persisted under VS Code's logs folder: board requests (with response shapes, no content) and errors.
  log = vscode.window.createOutputChannel('Ajwain', { log: true });
  context.subscriptions.push(log);
  pm = await import(pathToFileURL(path.join(__dirname, 'pm.mjs')).href);
  Z = await import(pathToFileURL(path.join(__dirname, 'zoho.mjs')).href);
  zoho = Z.createZoho({
    region: () => cfg().get('zoho.region') || 'in',
    load: async () => JSON.parse((await context.secrets.get('ajwain.zoho')) || 'null'),
    save: (t) => (t ? context.secrets.store('ajwain.zoho', JSON.stringify(t)) : context.secrets.delete('ajwain.zoho')),
  });
  await carryOver();
  icons = await import(pathToFileURL(path.join(__dirname, 'media', 'icons.mjs')).href);
  api = pm.createClient({
    load: async () => JSON.parse((await context.secrets.get('ajwain.tokens')) || 'null'),
    save: (t) => (t ? context.secrets.store('ajwain.tokens', JSON.stringify(t)) : context.secrets.delete('ajwain.tokens')),
    base: apiUrl,
  });
  pm.setApp(appUrl());

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bar.command = 'ajwain.currentActions';
  bar.tooltip = 'Ticket for the current branch';
  const updateBar = (branch) => {
    currentKey = branch && keyFor(branch);
    bar.text = `$(tasklist) ${currentKey}`;
    currentKey && me ? bar.show() : bar.hide();
  };

  timerBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  timerBar.command = 'ajwain.timerStop';
  const tick = setInterval(renderTimer, 20000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) }, timerBar);
  renderTimer();

  context.subscriptions.push(
    bar,
    ...codeProviders(),
    (treeView = vscode.window.createTreeView('ajwain.issues', { treeDataProvider: treeProvider, showCollapseAll: true })),
    vscode.window.registerWebviewViewProvider('ajwain.home', { resolveWebviewView: resolveSide }, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerFileSystemProvider('ajwain', docsProvider),
  );

  const cmd = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...a) => {
    try { await fn(...a); } catch (e) { log.error(`${name}: ${e.stack ?? e.message}${e.body ? `\n  reply: ${e.body}` : ''}`); vscode.window.showErrorMessage(`Ajwain: ${e.message}${e.noServer ? '. Run “Ajwain: Sign in” to choose one.' : ''}`); }
  }));
  // Commands that act on a ticket: get it from the tree item, a key, or a picker.
  const issueCmd = (name, fn) => cmd(name, async (arg) => {
    const i = await resolveIssue(arg);
    if (i && (await fn(i)) !== false) refresh();
  });

  cmd('ajwain.signIn', async () => {
    if (!apiUrl() && !(await askServer())) return;
    const username = await input('Username for your project management account');
    const password = username && (await input('Password', { password: true }));
    if (!password) return;
    me = await api.login(username, password);
    server = apiUrl();
    await signedIn();
  });
  cmd('ajwain.setServer', askServer);
  cmd('ajwain.signOut', async () => { await api.logout(); me = null; await signedIn(); });
  cmd('ajwain.refresh', refresh);
  cmd('ajwain.pickWorkspace', async () => {
    const cur = await workspaceId();
    const w = await pick((await api.workspaces()).map((w) => ({ label: w.name, description: same(w.id, cur) ? 'current' : '', w })), 'Workspace');
    if (w) await setScope({ workspace: w.w.id, project: '' });
  });
  cmd('ajwain.pickProject', async () => {
    const all = await api.myIssues(await workspaceId(), me.id).catch(() => []);
    const n = (id) => all.filter((i) => same(i.project?.id ?? i.project, id)).length;
    const cur = scopeProject();
    const p = await pick([
      { label: 'All projects', description: cur ? '' : 'current', detail: `${all.length} open issues of yours`, id: '' },
      ...projects.map((x) => ({ label: `${x.key} · ${x.name}`, description: same(x.id, cur) ? 'current' : '', detail: `${n(x.id)} open issues of yours`, id: x.id })),
    ], 'Show which project? (the board, sidebar, Today and My work all follow this)');
    if (p) await setScope({ project: p.id });
  });
  cmd('ajwain.openIssue', async () => {
    const k = await input('Ticket key', { placeHolder: 'ESG-12' });
    if (k) await vscode.window.showTextDocument(docUri(k.trim().toUpperCase()));
  });
  cmd('ajwain.create', createIssue);
  const board = (intent) => async () => {
    if (!me) await vscode.commands.executeCommand('ajwain.signIn');
    if (me) openBoard(intent);
  };
  cmd('ajwain.openBoard', (arg) => board(typeof arg === 'string' ? arg : arg?.key)());
  cmd('ajwain.today', board({ view: 'today' }));
  cmd('ajwain.standup', board({ view: 'today', standup: true }));
  cmd('ajwain.timerStop', () => stopTimer());
  cmd('ajwain.ticketFromCode', ticketFromCode);
  cmd('ajwain.addReminder', addReminder);
  cmd('ajwain.configureReminders', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`));

  issueCmd('ajwain.breakdown', (i) => { openBoard({ key: i.key, plan: true }); return false; });
  issueCmd('ajwain.edit', async (i) => { await vscode.window.showTextDocument(docUri(i.key), { preview: false }); return false; });
  issueCmd('ajwain.setStatus', async (i) => {
    const st = await api.statuses(i.project);
    const s = await pick(st.map((s) => ({ label: s.name, description: s.id === i.status ? 'current' : '', s })), `Move ${i.key} to…`);
    if (!s) return false;
    await api.update(i.id, { status: s.s.id });
    vscode.window.setStatusBarMessage(`${i.key} → ${s.label}`, 4000);
  });
  issueCmd('ajwain.setField', async (i) => {
    const f = await pick(['Priority', 'Estimate', 'Due date', 'Start date', 'Type'], `Edit ${i.key}`);
    let v;
    if (f === 'Priority') v = (v = await pick(pm.PRIORITIES, `Priority (now ${i.priority})`)) && { priority: v };
    if (f === 'Type') v = (v = await pick(pm.TYPES, `Type (now ${i.issue_type})`)) && { issue_type: v };
    if (f === 'Estimate') v = (v = await input('Estimate (2h, 1h30m, 1d)', { value: pm.fmtDuration(i.estimate_minutes), validateInput: validDuration })) && { estimate_minutes: pm.parseDuration(v) };
    if (f === 'Due date' || f === 'Start date') {
      const field = f === 'Due date' ? 'due_date' : 'start_date';
      v = await input(`${f} (YYYY-MM-DD, empty to clear)`, { value: i[field] ?? '', validateInput: (s) => (!s || /^\d{4}-\d{2}-\d{2}$/.test(s) ? null : 'Use YYYY-MM-DD') });
      v = v !== undefined && { [field]: v || null };
    }
    if (!v) return false;
    await api.update(i.id, v);
  });
  issueCmd('ajwain.logTime', (i) => logTime(i));
  issueCmd('ajwain.comment', async (i) => {
    const body = await input(`Comment on ${i.key}`);
    if (!body) return false;
    await api.comment(i.id, body);
  });
  issueCmd('ajwain.assignMe', (i) => api.update(i.id, { assignee: me.id }));
  issueCmd('ajwain.copyBranch', async (i) => {
    await vscode.env.clipboard.writeText(branchOf(i));
    vscode.window.setStatusBarMessage(`Copied ${branchOf(i)}`, 4000);
    return false;
  });
  issueCmd('ajwain.openInBrowser', (i) => { vscode.env.openExternal(webUrl(i.key)); return false; });
  issueCmd('ajwain.startWork', (i) => startWork(i));
  issueCmd('ajwain.timerToggle', (i) => (timerState()?.key === i.key ? stopTimer() : startTimer(i)));
  issueCmd('ajwain.implementWithClaude', (i) => implementWithClaude(i));
  issueCmd('ajwain.openPR', (i) => openPR(i));
  issueCmd('ajwain.finish', (i) => finish(i));
  cmd('ajwain.currentActions', async () => currentKey && issueActions(await api.issue(currentKey)));

  // Git: status bar shows the current branch's ticket; new commits trigger the after-commit reminder.
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (gitExt) {
    const g = (await gitExt.activate()).getAPI(1);
    const upd = () => updateBar(g.repositories[0]?.state.HEAD?.name);
    // Pre-fill the commit message box with "OG-12: " on a ticket's branch (it's cleared after each commit).
    const prefix = (r) => {
      const key = r.state.HEAD?.name && keyFor(r.state.HEAD.name);
      if (key && me && cfg().get('commitPrefix') && !r.inputBox.value.trim()) r.inputBox.value = `${key}: `;
    };
    const hook = (r) => { prefix(r); context.subscriptions.push(r.state.onDidChange(() => { upd(); prefix(r); }), watchCommits(r)); };
    g.repositories.forEach(hook);
    context.subscriptions.push(g.onDidOpenRepository((r) => { hook(r); upd(); }));
    changed.event(upd);
  }

  // Activity (typing, moving around files) drives focus sessions and break suggestions.
  focusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  focusBar.command = 'ajwain.focus';
  punchBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  punchBar.command = 'ajwain.punch';
  const punchTicker = setInterval(() => { if (zohoOn && attState().in) renderPunchBarOnly(); }, 1000); // the timer counts while you're in
  // Back at VS Code (opening it, or returning to it): the attendance pop-up, if one is due, comes straight away.
  context.subscriptions.push({ dispose: () => clearInterval(punchTicker) }, vscode.window.onDidChangeWindowState((w) => w.focused && attendanceTick()));
  let lastDoc = 0;
  context.subscriptions.push(
    focusBar,
    punchBar,
    vscode.window.onDidChangeTextEditorSelection(touch),
    vscode.window.onDidChangeActiveTextEditor(touch),
    vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.scheme === 'file' && Date.now() - lastDoc > 5000) { lastDoc = Date.now(); touch(); } }),
  );
  cmd('ajwain.takeBreak', () => showBreak({ kind: 'stretch', manual: true }));
  if (ATTENDANCE) {
    cmd('ajwain.zohoConnect', connectZoho);
    cmd('ajwain.zohoDisconnect', async () => { await zoho.disconnect(); zohoOn = false; renderPunch(); vscode.window.setStatusBarMessage('Disconnected from Zoho People', 4000); });
    cmd('ajwain.punch', punchMenu);
  }
  cmd('ajwain.eyeBreak', () => showBreak({ kind: 'eyes', manual: true }));
  cmd('ajwain.focus', toggleFocus);
  cmd('ajwain.windDown', board({ view: 'today', shutdown: true }));
  cmd('ajwain.wrapped', board({ view: 'today', wrapped: true }));
  cmd('ajwain.luckyDip', board({ view: 'today', lucky: true }));
  cmd('ajwain.attachFiles', attachFiles);

  // Scope changes (from any window or the settings UI) re-scope everything here.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (e.affectsConfiguration('ajwain.attendance') || e.affectsConfiguration('ajwain.zoho')) renderPunch();
    if (e.affectsConfiguration('ajwain.apiUrl') || e.affectsConfiguration('ajwain.appUrl')) {
      pm.setApp(appUrl());
      writeCliScope();
      // Another server: the login was for the old one.
      if (me && server !== apiUrl()) { await api.logout(); me = null; issueCache.clear(); await signedIn(); }
    }
    const ws = e.affectsConfiguration('ajwain.workspace'), pr = e.affectsConfiguration('ajwain.project');
    if (!ws && !pr) return;
    issueCache.clear();
    if (ws) await loadProjectKeys();
    writeCliScope();
    changed.fire();
    post(ws ? { type: 'reinit' } : { type: 'scope', project: scopeProject() });
  }));
  await migrateScope();

  try { me = await api.me(); } catch { me = null; }
  server = apiUrl();
  await signedIn();
  zohoOn = ATTENDANCE && !!(await context.secrets.get('ajwain.zoho')); // off: a stored Zoho sign-in is kept, and not used
  renderPunch();
  startScheduler();
  watchForChanges(context);
}

// Tree items and the panel tab load icons by URL, so write each icon once per theme into extension storage.
const CATEGORY_COLORS = { TODO: '#8B5CF6', IN_PROGRESS: '#F59E0B', DONE: '#10B981', NONE: '#8E8E98' };
const iconFiles = {};
function iconPath(name, accent) {
  const id = `${name}${accent ? accent.slice(1) : ''}`;
  if (iconFiles[id]) return iconFiles[id];
  const dir = path.join(ctx.globalStorageUri.fsPath, 'icons');
  fs.mkdirSync(dir, { recursive: true });
  const file = (theme, ink) => {
    const f = path.join(dir, `${id}-${theme}.svg`);
    fs.writeFileSync(f, icons.svgFile(name, ink, accent));
    return vscode.Uri.file(f);
  };
  return (iconFiles[id] = { light: file('light', '#2B2B2B'), dark: file('dark', '#E8E4DC') });
}

async function signedIn() {
  await vscode.commands.executeCommand('setContext', 'ajwain.signedIn', !!me);
  if (me) loadProjectKeys();
  refresh();
}

// Moving in from another copy of Ajwain (one installed under a different extension id keeps its own storage):
// if <global storage>/import.json exists, its {state, settings} are applied once, where nothing is set yet,
// and the file is removed. Logins can't be carried: you sign in again.
async function carryOver() {
  const file = path.join(ctx.globalStorageUri.fsPath, 'import.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  for (const [k, v] of Object.entries(data.state ?? {})) if (k.startsWith('ajwain.') && ctx.globalState.get(k) === undefined) await ctx.globalState.update(k, v);
  for (const [k, v] of Object.entries(data.settings ?? {})) if (cfg().inspect(k)?.globalValue === undefined) await cfg().update(k, v, vscode.ConfigurationTarget.Global);
  fs.rmSync(file, { force: true });
  log.info(`import.json: carried over ${Object.keys(data.state ?? {}).length} stored values and ${Object.keys(data.settings ?? {}).length} settings`);
}

// Before 0.7 the workspace and the board's project were kept per window; carry them into the settings once.
async function migrateScope() {
  const G = vscode.ConfigurationTarget.Global;
  const legacyWs = ctx.globalState.get('ajwain.workspace'), legacyProject = ctx.globalState.get('ajwain.board')?.project;
  if (legacyWs && !cfg().get('workspace')) await cfg().update('workspace', String(legacyWs), G);
  if (legacyProject && cfg().inspect('project')?.globalValue === undefined) await cfg().update('project', String(legacyProject), G);
  await ctx.globalState.update('ajwain.workspace', undefined);
  writeCliScope();
}

// The CLI (and the Claude skill through it) reads the same scope.
function writeCliScope() {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ajwain');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'scope.json'), JSON.stringify({ workspace: cfg().get('workspace') || null, project: scopeProject() }));
    if (apiUrl()) fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ api: apiUrl(), app: appUrl() }));
  } catch (e) {
    log.error(`scope.json: ${e.message}`);
  }
}

// What a response looked like, without its content: "37/120 results; keys: id,key,title,…".
function shape(d) {
  const rows = Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : null;
  if (!rows) return d && typeof d === 'object' ? `object; keys: ${Object.keys(d).slice(0, 25).join(',')}` : typeof d;
  const keys = rows[0] && typeof rows[0] === 'object' ? `; keys: ${Object.keys(rows[0]).slice(0, 30).join(',')}` : '';
  return `${rows.length}${d?.count != null ? `/${d.count}` : ''} results${keys}`;
}

let firstWorkspace;
async function workspaceId() {
  return cfg().get('workspace') || (firstWorkspace ??= (await api.workspaces())[0]?.id);
}

async function resolveIssue(arg) {
  if (arg?.id && arg?.key) return arg;
  if (typeof arg === 'string') return api.issue(arg);
  const items = myIssues.map((i) => ({ label: i.key, description: i.title, detail: statusName(i), i }));
  const cur = items.findIndex((x) => x.label === currentKey);
  if (cur > 0) items.unshift(...items.splice(cur, 1));
  const p = await pick([...items, { label: '$(search) Enter a key…', manual: true }], 'Ticket');
  if (!p) return;
  if (!p.manual) return p.i;
  const k = await input('Ticket key', { placeHolder: 'ESG-12' });
  return k && api.issue(k.trim().toUpperCase());
}

async function logTime(i, suggested) {
  const d = await input(`Log time on ${i.key} (${timeText(i) || 'nothing logged'})`, {
    placeHolder: '1h30m', value: suggested ? pm.fmtDuration(suggested) : '', validateInput: validDuration,
  });
  if (!d) return false;
  const note = await input('Note (optional)');
  if (note === undefined) return false;
  await logWork(i, pm.parseDuration(d), note);
  vscode.window.setStatusBarMessage(`Logged ${d} on ${i.key}`, 4000);
}

// Everything you can do to one ticket, as a quick pick (the status bar's ticket, the sidebar's "more" button).
async function issueActions(i) {
  const a = await pick([
    { label: '$(edit) Edit title & description', c: 'ajwain.edit' },
    { label: '$(arrow-swap) Change status', description: statusName(i), c: 'ajwain.setStatus' },
    { label: '$(watch) Log time', description: timeText(i), c: 'ajwain.logTime' },
    { label: timerState()?.key === i.key ? '$(debug-stop) Stop the timer' : '$(watch) Start a timer', c: 'ajwain.timerToggle' },
    { label: '$(sparkle) Implement with Claude', c: 'ajwain.implementWithClaude' },
    { label: '$(git-pull-request) Open pull request', c: 'ajwain.openPR' },
    { label: '$(pass) Finish', c: 'ajwain.finish' },
    { label: '$(list-tree) Break down into subtasks', c: 'ajwain.breakdown' },
    { label: '$(settings) Edit field', c: 'ajwain.setField' },
    { label: '$(comment) Add comment', c: 'ajwain.comment' },
    { label: '$(link-external) Open in browser', c: 'ajwain.openInBrowser' },
  ], `${i.key} ${i.title}`);
  if (a) vscode.commands.executeCommand(a.c, i);
}

// Tree: my open issues grouped by status. Elements are {group, issues} or raw issue objects,
// so context-menu commands receive the issue itself.
const treeProvider = {
  onDidChangeTreeData: changed.event,
  async getChildren(el) {
    if (el) return el.issues;
    if (!me) return [];
    try {
      const pid = scopeProject();
      myIssues = (await api.myIssues(await workspaceId(), me.id)).filter((i) => !pid || same(i.project?.id ?? i.project, pid));
      treeView.description = pid ? projectName(pid) ?? '' : 'All projects';
    } catch (e) {
      log.error(`sidebar: ${e.message}`);
      vscode.window.showErrorMessage(`Ajwain: ${e.message}`);
      return [];
    }
    const groups = new Map();
    for (const i of myIssues) groups.set(statusName(i), [...(groups.get(statusName(i)) ?? []), i]);
    return [...groups].map(([group, issues]) => ({ group, issues }));
  },
  getTreeItem(el) {
    if (el.group) {
      const t = new vscode.TreeItem(el.group, vscode.TreeItemCollapsibleState.Expanded);
      const cat = el.issues[0]?.status_detail?.category ?? 'NONE';
      t.iconPath = iconPath(`s_${cat.toLowerCase()}`, CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.NONE);
      t.description = String(el.issues.length);
      return t;
    }
    const t = new vscode.TreeItem(`${el.key}  ${el.title}`);
    t.contextValue = 'issue';
    t.iconPath = iconPath(`t_${(el.issue_type || 'TASK').toLowerCase()}`);
    t.description = [el.priority?.toLowerCase(), timeText(el), el.due_date && `due ${el.due_date}`].filter(Boolean).join(' · ');
    t.tooltip = new vscode.MarkdownString(
      `**${el.key}** ${el.title}\n\n${statusName(el)} · ${el.issue_type} · ${el.priority}` +
      `${timeText(el) ? `\n\nTime: ${timeText(el)}` : ''}${el.description ? `\n\n---\n\n${el.description}` : ''}`,
    );
    t.command = { command: 'ajwain.openBoard', title: 'Open', arguments: [el.key] };
    return t;
  },
};

// ajwain:/ESG-12.md is the ticket as an editable file: "# Title" then the description. Saving patches the ticket.
const docs = new Map();
const docText = (i) => `# ${i.title}\n\n${i.description ?? ''}`;
const keyOf = (uri) => path.posix.basename(uri.path, '.md');
async function loadDoc(uri) {
  const issue = await api.issue(keyOf(uri)).catch((e) => { throw e.status === 404 ? vscode.FileSystemError.FileNotFound(uri) : e; });
  const d = { issue, bytes: Buffer.from(docText(issue)), mtime: Date.now() };
  docs.set(keyOf(uri), d);
  return d;
}
const docsProvider = {
  onDidChangeFile: new vscode.EventEmitter().event,
  watch: () => new vscode.Disposable(() => {}),
  async stat(uri) {
    const d = docs.get(keyOf(uri)) ?? (await loadDoc(uri));
    return { type: vscode.FileType.File, ctime: 0, mtime: d.mtime, size: d.bytes.length };
  },
  readFile: async (uri) => (await loadDoc(uri)).bytes,
  async writeFile(uri, content) {
    const d = docs.get(keyOf(uri)) ?? (await loadDoc(uri));
    const text = Buffer.from(content).toString('utf8');
    const m = text.match(/^# (.*)\r?\n?([\s\S]*)$/);
    const changes = m ? { title: m[1].trim(), description: m[2].replace(/^(\r?\n)+/, '') } : { description: text };
    d.issue = { ...d.issue, ...changes, ...(await api.update(d.issue.id, changes)) };
    d.bytes = Buffer.from(content);
    d.mtime = Date.now();
    refresh();
  },
  readDirectory: () => [],
  createDirectory: () => { throw vscode.FileSystemError.NoPermissions(); },
  delete: () => { throw vscode.FileSystemError.NoPermissions(); },
  rename: () => { throw vscode.FileSystemError.NoPermissions(); },
};

// Defaults to the project in scope, so tickets are created where you're looking.
async function pickProject() {
  const cur = scopeProject();
  const items = (await api.projects(await workspaceId())).map((p) => ({ label: p.key, description: p.name + (same(p.id, cur) ? ' · current' : ''), p }));
  items.sort((a, b) => same(b.p.id, cur) - same(a.p.id, cur));
  return (await pick(items, 'Project'))?.p;
}

async function createIssue() {
  const p = await pickProject();
  if (!p) return;
  const issue_type = await pick(['TASK', 'BUG', 'STORY', 'EPIC', 'SUBTASK'], 'Type');
  const parent = issue_type === 'SUBTASK' ? await resolveIssue() : null;
  const title = issue_type && (await input('Title'));
  const priority = title && (await pick(['MEDIUM', 'HIGH', 'HIGHEST', 'LOW', 'LOWEST'], 'Priority'));
  const est = priority && (await input('Estimate (optional: 2h, 1h30m, 1d)', { validateInput: (v) => v && validDuration(v) }));
  if (est === undefined) return;
  const [first] = await api.statuses(p.id);
  const issue = await api.create({
    project: p.id, title, issue_type, priority, assignee: me.id,
    ...(first && { status: first.id }),
    ...(parent && { parent: parent.id }),
    ...(est && { estimate_minutes: pm.parseDuration(est) }),
  });
  refresh();
  // Open it straight away so the description can be written and saved.
  await vscode.window.showTextDocument(docUri(issue.key), { preview: false });
  vscode.window.showInformationMessage(`Created ${issue.key}. Write the description and save (Ctrl+S) to update the ticket.`);
}

// mode: 'branch' | 'worktree' | 'ask' (default from the ajwain.startWorkIn setting).
async function startWork(i, mode = cfg().get('startWorkIn')) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a git repository first');
  if (mode !== 'branch' && mode !== 'worktree') {
    const p = await pick([
      { label: '$(git-branch) Branch here', detail: branchOf(i), mode: 'branch' },
      { label: '$(split-horizontal) New worktree in a new window', detail: 'Separate checkout, so you can work on tickets in parallel', mode: 'worktree' },
    ], `Start ${i.key}`);
    if (!p) return false;
    mode = p.mode;
  }
  const root = await git(folder.uri.fsPath, 'rev-parse', '--show-toplevel');
  const from = mode === 'worktree' ? await mainRoot(root) : root;
  // The server first: if it refuses, better to hear it before a branch exists.
  if (!(await startTicket(i))) return false;
  const { path: dir, branch } = await pm.startBranch(git, from, i, mode === 'worktree', cfg().get('branchTemplate'));
  await record('start', { key: i.key });
  if (cfg().get('timer.autoStart')) await startTimer(i);
  refresh();
  if (mode === 'worktree') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: true });
  else vscode.window.setStatusBarMessage(`$(git-branch) On ${branch} · ${i.key} is in progress`, 6000);
}

// Assign to me and move to In Progress. Some workspaces refuse to start a ticket that has no estimate:
// ask for one, set it, and carry on. Returns null if the user backs out.
async function startTicket(i) {
  try {
    return await api.startIssue(i, me.id);
  } catch (e) {
    if (!e.errors?.estimate_minutes) throw e;
    const d = await input(`${i.key} needs an estimate before it can start`, { placeHolder: '3h, 1d, 45m', validateInput: validDuration });
    if (!d) return null;
    await api.update(i.id, { estimate_minutes: pm.parseDuration(d) });
    return api.startIssue(i, me.id);
  }
}

// ---------- after-commit reminder ----------
const seenCommits = new Set();
function watchCommits(repo) {
  let last = { name: repo.state.HEAD?.name, commit: repo.state.HEAD?.commit };
  return repo.state.onDidChange(() => {
    const h = repo.state.HEAD;
    if (!h?.commit || h.commit === last.commit) return;
    const sameBranch = !!h.name && h.name === last.name; // a checkout/switch is not a commit
    last = { name: h.name, commit: h.commit };
    if (sameBranch && me && cfg().get('reminders.afterCommit')) afterCommit(repo.rootUri.fsPath, h.name).catch(() => {});
  });
}

async function afterCommit(root, branch, relinked = false) {
  const [hash, time, email, subject] = (await git(root, 'log', '-1', '--format=%H%x09%ct%x09%ae%x09%s')).split('\t');
  if (seenCommits.has(hash)) return;
  seenCommits.add(hash);
  // Only fresh commits by me: pulls, resets and rebases also move HEAD.
  const mine = await git(root, 'config', 'user.email').catch(() => email);
  if (email !== mine || (!relinked && Date.now() / 1000 - Number(time) > 180)) return;
  lateNight();
  const ignored = ctx.globalState.get('ajwain.ignoredBranches') ?? [];
  const key = keyFor(branch, subject);

  if (!key) {
    if (ignored.includes(branch)) return;
    const c = await vscode.window.showInformationMessage(`Your commit "${subject}" on ${branch} isn't linked to a ticket.`, 'Create ticket', 'Link to ticket…', "Don't ask for this branch");
    if (c === "Don't ask for this branch") return ctx.globalState.update('ajwain.ignoredBranches', [...ignored, branch]);
    let issue;
    if (c === 'Link to ticket…') issue = await resolveIssue();
    if (c === 'Create ticket') issue = await createFromCommit(subject);
    if (!issue) return;
    await linkBranch(branch, issue.key);
    refresh();
    seenCommits.delete(hash); // now linked: ask again, this time with the log-time prompt
    return afterCommit(root, branch, true);
  }

  // Suggest the time since my previous commit, when it looks like one continuous session.
  const prev = (await git(root, 'log', '-2', '--fixed-strings', `--author=${mine}`, '--format=%ct').catch(() => '')).split('\n')[1];
  const gap = prev ? (Number(time) - Number(prev)) / 60 : Infinity;
  const suggested = gap <= 120 ? Math.max(15, Math.round(gap / 15) * 15) : null;
  const logLabel = suggested ? `Log ${pm.fmtDuration(suggested)}` : 'Log time…';
  const c = await vscode.window.showInformationMessage(`${key} · committed "${subject}"`, logLabel, 'Update status…', 'Add as comment');
  if (!c) return;
  const issue = await api.issue(key);
  if (c === logLabel && suggested) {
    await logWork(issue, suggested, subject);
    vscode.window.setStatusBarMessage(`Logged ${pm.fmtDuration(suggested)} on ${key}`, 4000);
  }
  if (c === 'Log time…') await logTime(issue);
  if (c === 'Update status…') await vscode.commands.executeCommand('ajwain.setStatus', issue);
  if (c === 'Add as comment') await api.comment(issue.id, `Commit \`${hash.slice(0, 8)}\` on \`${branch}\`: ${subject}`);
  refresh();
}

// A gentle nudge for commits after 10pm, once a night.
function lateNight() {
  const h = new Date().getHours();
  const night = new Date(Date.now() - 6 * 3600e3).toLocaleDateString('en-CA'); // a night belongs to the day it started
  if (!cfg().get('fun.lateNight') || (h >= 5 && h < 22) || ctx.globalState.get('ajwain.lateNudge') === night) return;
  ctx.globalState.update('ajwain.lateNudge', night);
  vscode.window.showInformationMessage("🌙 It's late. The cone kid is yawning: maybe wrap up and pick this up tomorrow?", 'Wind down').then((c) => c && openBoard({ view: 'today', shutdown: true }));
}

async function createFromCommit(subject) {
  const p = await pickProject();
  if (!p) return;
  const title = await input('Ticket title', { value: subject.replace(/^\w+(\(.*?\))?!?:\s*/, '') });
  if (!title) return;
  const st = await api.findStatus(p.id, 'IN_PROGRESS').catch(() => null);
  const issue = await api.create({ project: p.id, title, issue_type: 'TASK', priority: 'MEDIUM', assignee: me.id, ...(st && { status: st.id }) });
  vscode.window.showInformationMessage(`Created ${issue.key}`, 'Open').then((c) => c && openBoard(issue.key));
  return issue;
}

// ---------- scheduled reminders ----------
function startScheduler() {
  const tick = () => {
    breakTick();
    attendanceTick();
    if (!me) return;
    const fired = ctx.globalState.get('ajwain.reminders.fired') ?? {};
    const now = new Date();
    (cfg().get('reminders.schedule') ?? []).forEach((r, n) => {
      const id = `${n}:${r.time}:${r.action}`;
      if (!pm.isDue(r, now, fired[id])) return;
      fired[id] = now.toLocaleDateString('en-CA'); // shared across windows, so only one window shows it
      ctx.globalState.update('ajwain.reminders.fired', fired);
      remind(r);
    });
  };
  setTimeout(tick, 5000);
  const t = setInterval(tick, 30000);
  ctx.subscriptions.push({ dispose: () => clearInterval(t) });
}

async function remind(r) {
  const a = REMINDER_ACTIONS[r.action] ?? REMINDER_ACTIONS.message;
  const c = await vscode.window.showInformationMessage(`⏰ ${r.message || a.message}`, ...[a.label, 'Snooze 15m'].filter(Boolean));
  if (c === 'Snooze 15m') return setTimeout(() => remind(r), 15 * 60e3);
  if (!c) return;
  if (r.action === 'today') openBoard({ view: 'today' });
  if (r.action === 'board') openBoard({});
  if (r.action === 'create') openBoard({ create: true });
  if (r.action === 'logTime') vscode.commands.executeCommand('ajwain.logTime');
  if (r.action === 'standup') openBoard({ view: 'today', standup: true });
  if (r.action === 'shutdown') openBoard({ view: 'today', shutdown: true });
  if (r.action === 'wrapped') openBoard({ view: 'today', wrapped: true });
}

async function addReminder() {
  const time = await input('Remind me at (24-hour HH:MM)', { placeHolder: '16:00', validateInput: (v) => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(v) ? null : 'Use HH:MM, e.g. 16:00') });
  if (!time) return;
  const action = await pick(Object.entries(REMINDER_ACTIONS).map(([id, a]) => ({ label: a.label || 'Message only', detail: a.detail, id })), 'What should the reminder open?');
  if (!action) return;
  const week = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const days = await vscode.window.showQuickPick(week.map((d, n) => ({ label: d, picked: n < 5 })), { canPickMany: true, placeHolder: 'On which days?', ignoreFocusOut: true });
  if (!days?.length) return;
  const message = await input('Message', { value: REMINDER_ACTIONS[action.id].message });
  if (message === undefined) return;
  const list = [...(cfg().get('reminders.schedule') ?? []), { time, action: action.id, message, days: days.map((d) => d.label) }];
  await cfg().update('reminders.schedule', list, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Reminder set for ${time} on ${days.map((d) => d.label).join(', ')}.`, 'Edit reminders').then((c) => c && vscode.commands.executeCommand('ajwain.configureReminders'));
}

// ---------- my commits across the open repos (Today: since midnight; standup: the previous workday) ----------
async function myCommits(since = 'midnight', until) {
  const roots = new Set();
  for (const f of vscode.workspace.workspaceFolders ?? []) roots.add(await git(f.uri.fsPath, 'rev-parse', '--show-toplevel').catch(() => null));
  roots.delete(null);
  const out = new Map();
  for (const root of roots) {
    const email = await git(root, 'config', 'user.email').catch(() => '');
    const log = await git(root, 'log', '--all', `--since=${since}`, ...(until ? [`--until=${until}`] : []), ...(email ? ['--fixed-strings', `--author=${email}`] : []), '--format=%H%x09%ct%x09%s').catch(() => '');
    const rows = log ? log.split('\n').map((l) => l.split('\t')) : [];
    if (!rows.length) continue;
    const branches = (await git(root, 'name-rev', '--name-only', '--refs=refs/heads/*', ...rows.map((r) => r[0])).catch(() => '')).split('\n');
    rows.forEach(([hash, time, subject], n) => {
      const branch = (branches[n] ?? '').replace(/[~^].*$/, '');
      const b = branch === 'undefined' ? '' : branch;
      out.set(hash, { hash, time: Number(time), subject, branch: b, key: keyFor(b, subject), repo: path.basename(root) });
    });
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

// ---------- breakdown drafting with Claude Code (headless, read-only tools) ----------
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    approach: { type: 'string' },
    subtasks: {
      type: 'array', minItems: 1, maxItems: 10,
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, description: { type: 'string' }, estimate_minutes: { type: 'integer' } },
        required: ['title', 'description', 'estimate_minutes'],
      },
    },
  },
  required: ['approach', 'subtasks'],
};

function draftBreakdown(issue, guidance) {
  const child = issue.issue_type === 'EPIC' ? 'story' : 'subtask';
  const existing = (issue.children ?? []).map((c) => `- ${c.key} ${c.title}`).join('\n');
  const prompt = [
    `You are helping a developer plan ticket ${issue.key} before they start coding. First read the relevant code in the current repository (read-only), so the plan names real files, functions and endpoints.`,
    '',
    `Ticket ${issue.key} [${issue.issue_type}, priority ${issue.priority}]: ${issue.title}`,
    'Description:',
    issue.description?.trim() || '(none)',
    existing ? `\nExisting ${child}s, do not duplicate them:\n${existing}` : null,
    guidance ? `\nGuidance from the developer: ${guidance}` : null,
    '',
    'Return:',
    '- approach: a short markdown plan for the whole ticket: the approach, the files or areas touched, risks or open questions, and how to test it.',
    `- subtasks: 2-8 ${child}s in the order they should be done; each independently reviewable and at most about a day of work.`,
    '  - title: imperative and specific, under 70 characters.',
    '  - description: markdown with "## What" (the concrete change, naming files) and "## Acceptance criteria" (a "- [ ]" checklist).',
    '  - estimate_minutes: realistic, a multiple of 15.',
  ].filter((l) => l != null).join('\n');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const bin = findBin('claude', 'claude.path') ?? 'claude';
  const model = cfg().get('claude.model');
  const args = ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(PLAN_SCHEMA), '--allowedTools', 'Read,Grep,Glob', ...(model ? ['--model', model] : [])];

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Claude is reading the code and drafting a breakdown of ${issue.key}…`, cancellable: true },
    (_, token) => new Promise((resolve, reject) => {
      const p = execFile(bin, args, { cwd, maxBuffer: 32 << 20, timeout: 10 * 60e3 }, (e, out, err) => {
        if (token.isCancellationRequested) return reject(new Error('Cancelled'));
        if (e?.code === 'ENOENT') return reject(new Error('Claude Code CLI not found. Install it, or set "ajwain.claude.path" in settings.'));
        let d;
        try { d = JSON.parse(out); } catch { return reject(new Error((err || e?.message || 'Claude returned nothing').trim().slice(0, 400))); }
        if (d.is_error || !d.structured_output) return reject(new Error(String(d.result || 'Claude could not draft a plan').slice(0, 400)));
        resolve(d.structured_output);
      });
      p.stdin?.end(); // -p reads stdin when it is a pipe; close it so the prompt argument is used alone
      token.onCancellationRequested(() => p.kill());
    }),
  );
}

// ---------- board webview ----------
// The board calls back here for API requests, so the token never leaves the extension host.
const boardApi = {
  async init() {
    const intent = pendingOpen;
    pendingOpen = null;
    const workspace = await workspaceId();
    return {
      me, workspace, project: scopeProject(), saved: (ctx.globalState.get('ajwain.boardState') ?? {})[workspace] ?? {},
      intent, startWorkIn: cfg().get('startWorkIn'), timer: timerState() ?? null,
    };
  },
  // View, filters and sort, remembered per workspace (sprint and tag ids don't carry across workspaces).
  save: async (state) => ctx.globalState.update('ajwain.boardState', { ...ctx.globalState.get('ajwain.boardState'), [await workspaceId()]: state }),
  setScope: (scope) => setScope(scope),
  async req(path, opts) {
    if (!String(path).startsWith('/')) throw new Error('Bad path');
    const t = Date.now(), what = `${opts?.method ?? 'GET'} ${path}`;
    try {
      const d = await api.req(path, opts);
      log.info(`${what} → ${shape(d)} (${Date.now() - t}ms)`);
      // The board logs time and creates tickets straight through the API: keep the journal in step.
      if (opts?.method === 'POST' && path === '/api/worklogs/') record('log', { minutes: opts.body?.minutes });
      if (opts?.method === 'POST' && path === '/api/issues/') record('ticket', { key: d?.key, score: pm.ticketQuality(opts.body ?? {}).score });
      return d;
    } catch (e) {
      log.error(`${what} → ${e.status ?? ''} ${e.message}`);
      throw e;
    }
  },
  log: (msg) => log.error(`[board] ${msg}`),
  workspaces: async () => ({ list: await api.workspaces(), current: await workspaceId() }),
  // The board changed something (created, moved, logged): the tree and the sidebar catch up. Not the board: it knows.
  changed: () => { changed.fire(); try { side?.webview.postMessage({ type: 'refresh' }); } catch { /* disposed */ } },
  signIn: () => vscode.commands.executeCommand('ajwain.signIn'),
  startWork: async (issue, mode) => { await startWork(issue, mode ?? undefined); },
  copy: async (text) => { await vscode.env.clipboard.writeText(text); vscode.window.setStatusBarMessage(`Copied ${text}`, 3000); },
  openExternal: (url) => {
    if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) links can be opened');
    return vscode.env.openExternal(vscode.Uri.parse(url));
  },
  openWeb: (key) => vscode.env.openExternal(webUrl(key)),
  openDoc: async (key) => { await vscode.window.showTextDocument(docUri(key), { preview: false, viewColumn: vscode.ViewColumn.Beside }); },
  todayCommits: () => myCommits(),
  commits: (since, until) => myCommits(since, until),
  copyBranch: (issue) => boardApi.copy(branchOf(issue)),
  timerToggle: async (issue) => { await (timerState()?.key === issue.key ? stopTimer() : startTimer(issue)); return timerState() ?? null; },
  implementWithClaude: (issue) => implementWithClaude(issue),
  openPR: (issue) => openPR(issue),
  finish: (issue) => finish(issue),
  linkBranch: async (branch, key) => {
    key ??= (await resolveIssue())?.key;
    if (key) { await linkBranch(branch, key); changed.fire(); }
    return key ?? null;
  },
  draftBreakdown: (issue, guidance) => draftBreakdown(issue, guidance),
  record: (e) => record(e.type, e),
  journal: () => ({ events: journal(), unlocked: ctx.globalState.get('ajwain.unlocked') ?? {} }),
  tomorrow: () => ctx.globalState.get('ajwain.tomorrow') ?? null,
  // Attendance, for the Workday box: the state, and a punch when you click its button.
  attendance: () => attView(),
  punchByHand: (dir) => (ATTENDANCE && (dir === 'in' || dir === 'out') ? punchByHand(dir) : null),
  connectZoho: () => ATTENDANCE && vscode.commands.executeCommand('ajwain.zohoConnect'),
  setTomorrow: (t) => ctx.globalState.update('ajwain.tomorrow', t ? { ...t, date: new Date().toLocaleDateString('en-CA') } : undefined),
  attachmentUrl: (id, download) => api.attachmentUrl(id, download),
  pickAndAttach: (issue) => pickAndAttach(issue),
  attachBytes: (issue, files) => uploadFiles(issue, files.map((f) => ({ name: f.name, type: f.type, bytes: Buffer.from(f.data, 'base64') }))),
  saveImage: (dataUrl, name) => saveImage(dataUrl, name),
  takeBreak: (kind) => showBreak({ kind: kind || 'stretch', manual: true }),
  focus: () => toggleFocus(),
  focusState: () => focusSession ?? null,
  addReminder: () => vscode.commands.executeCommand('ajwain.addReminder'),
  configureReminders: () => vscode.commands.executeCommand('ajwain.configureReminders'),
};

// ---------- attendance: Zoho People punch in and out ----------
// A workday from ajwain.attendance.in (09:00) to ajwain.attendance.out (18:00). How you're punched in and out is
// yours to choose (ajwain.attendance.punchIn / punchOut): asked in a pop-up, automatically at the time, or only by
// hand. An automatic punch-in after 09:00 is at the real time, never backdated. Zoho stays the source of truth:
// every punch is checked against it first (a punch on the Zoho app or a biometric device is respected) and
// confirmed after. State shared by all windows: { in, since, firstIn, entries, missedAsked, askedIn, askedOut }.
//
// Only two things ever punch: the schedule, and you, by clicking in a pop-up, choosing it in the punch menu or
// clicking the button in Ajwain's sidebar or Today. There is no command, CLI verb or API that punches without a
// person choosing it.
const attState = () => ctx.globalState.get('ajwain.attendance') ?? {};
const setAttState = (s) => ctx.globalState.update('ajwain.attendance', { ...attState(), ...s });
const hm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const rules = () => ({ punchIn: cfg().get('attendance.punchIn'), punchOut: cfg().get('attendance.punchOut'), in: cfg().get('attendance.in'), out: cfg().get('attendance.out'), days: cfg().get('attendance.days') });
const MODES = {
  punchIn: { ask: () => 'ask me when VS Code opens', auto: (r) => `automatically at ${r.in}`, off: () => 'only when I punch in' },
  punchOut: { auto: (r) => `automatically at ${r.out}`, ask: (r) => `ask me at ${r.out}`, off: () => 'only when I punch out' },
};
const plan = (r) => `Punch-in: ${MODES.punchIn[r.punchIn]?.(r)} · punch-out: ${MODES.punchOut[r.punchOut]?.(r)}`;
const SYNC_EVERY = 15 * 60e3;
let lastSync = 0, retryAt = 0, warned = '';

// What the board and the sidebar show (they count the timer up themselves).
const attView = () => (!ATTENDANCE ? null : zohoOn ? { connected: true, ...attState(), rules: rules() } : { connected: false }); // null: no Workday box
function renderPunch() {
  post({ type: 'attendance', attendance: attView() });
  if (!zohoOn) return punchBar.hide();
  const s = attState(), worked = Z.workedToday(s.entries, Date.now());
  punchBar.text = s.in ? `$(pass-filled) In ${hms(worked)}` : `$(circle-large-outline) Out${worked ? ` · ${hms(worked).slice(0, -3)} today` : ''}`;
  const r = rules();
  punchBar.tooltip = `Zoho People: ${s.in ? `punched in since ${s.since ? hm(s.since) : '?'}` : 'punched out'} · ${hms(worked)} today.\n`
    + `${plan(r)}. Click for options.`;
  punchBar.show();
}
function renderPunchBarOnly() {
  const s = attState();
  punchBar.text = `$(pass-filled) In ${hms(Z.workedToday(s.entries, Date.now()))}`;
}
async function syncAttendance() {
  const z = await zoho.status(cfg().get('zoho.email'));
  lastSync = Date.now();
  // Today's first punch-in: from Zoho's firstIn or today's entries, whichever says so (never an earlier day's).
  const today = new Date(Date.now()).toDateString(), isToday = (t) => t && new Date(t).toDateString() === today;
  const firstIn = [z.firstIn, ...z.entries.map((e) => e.in)].filter(isToday).sort((a, b) => a - b)[0] ?? null;
  await setAttState({ in: z.in, since: z.since, firstIn, entries: z.entries });
  renderPunch();
  return z;
}
// One punch, checked against Zoho before and after.
async function punch(dir, at = new Date(Date.now())) {
  const email = cfg().get('zoho.email');
  if (!email) throw new Error('No Zoho People email set: run "Ajwain: Connect Zoho People"');
  const before = await syncAttendance();
  if (before.in === (dir === 'in')) return { already: true, status: before };
  if (dir === 'out' && before.since && at.getTime() <= before.since) at = new Date(Math.max(Date.now(), before.since + 60e3)); // never before the punch-in
  const r = await zoho.punch(dir, at, email);
  log.info(`zoho punch ${dir} at ${Z.zohoTime(at)} → ${typeof r === 'object' && r ? `keys: ${Object.keys(r).join(',')}` : String(r).slice(0, 80)}`);
  const now = await syncAttendance();
  if (now.in !== (dir === 'in')) throw new Error(`Zoho People didn't record the punch-${dir}. Check your attendance in Zoho People.`);
  await record('punch', { dir, at: at.getTime() });
  return { status: now, at };
}
// A punch you asked for: from the punch menu, or the button in Ajwain's sidebar or Today.
async function punchByHand(dir) {
  const r = await punch(dir);
  vscode.window.setStatusBarMessage(r.already ? `Zoho People: you were already punched ${dir}` : `$(pass-filled) Punched ${dir} at ${hm(r.at)} · Zoho People`, 6000);
  return attView();
}
// Every scheduler tick (30s), and when the window gets focus: keep in step with Zoho now and then, and follow the
// schedule. One at a time; questions are left on screen without holding up the next tick.
let ticking = false;
const askFailed = (e) => vscode.window.showWarningMessage(`Zoho People: ${e.message}`);
async function attendanceTick() {
  const now = Date.now();
  if (!zohoOn || ticking || now < retryAt) return; // after a failure, Zoho is left alone for 5 minutes
  ticking = true;
  try {
    if (now - lastSync > SYNC_EVERY) await syncAttendance();
    const step = Z.attendanceStep({ state: attState(), now, rules: rules() });
    if (!step) return;
    if (step.act === 'missed-out') return void askMissedOut(step.since).catch(askFailed);
    if (step.act === 'ask-in' || step.act === 'ask-out') return void (vscode.window.state.focused && askPunch(step.act.slice(4)).catch(askFailed)); // only while you're here to answer
    // One window at a time: the others see the lock (or the new state) and stand back.
    if (now - (ctx.globalState.get('ajwain.punchLock') ?? 0) < 60e3) return;
    await ctx.globalState.update('ajwain.punchLock', now);
    try {
      const r = await punch(step.act, step.at);
      if (!r.already) vscode.window.setStatusBarMessage(`$(pass-filled) Punched ${step.act} at ${hm(step.at)} · Zoho People`, 10000);
    } finally {
      await ctx.globalState.update('ajwain.punchLock', 0);
    }
    warned = '';
  } catch (e) {
    retryAt = now + 5 * 60e3; // back off: Zoho locks callers out for minutes after a burst
    log.error(`attendance: ${e.message}${e.body ? ` · Zoho replied: ${e.body}` : ''}`);
    if (e.notConnected) { zohoOn = false; renderPunch(); }
    if (warned !== e.message) { warned = e.message; vscode.window.showWarningMessage(`Ajwain: ${e.message}`); }
  } finally {
    ticking = false;
  }
}
// The pop-up, once a day: punch-in when VS Code opens (or you come back to it), punch-out from the out time.
// Modal, so it isn't lost among notifications. Nothing is punched unless you click.
async function askPunch(dir) {
  const now = Date.now(), r = rules();
  await setAttState({ [dir === 'in' ? 'askedIn' : 'askedOut']: new Date(now).toLocaleDateString('en-CA') }); // first, so other windows don't ask too
  const h = new Date(now).getHours(), name = me?.first_name || me?.username;
  const [msg, detail, yes, no] = dir === 'in'
    ? [`${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}${name ? `, ${name}` : ''}. Punch in to Zoho People?`,
      `It's ${hm(now)}.${r.punchOut === 'auto' ? ` You'll be punched out at ${r.out}.` : ''}`, 'Punch in', 'Not today']
    : [`Your day ends at ${r.out}. Punch out of Zoho People?`,
      `It's ${hm(now)}. You've worked ${hms(Z.workedToday(attState().entries, now)).slice(0, -3)} today.`, 'Punch out', 'Not yet'];
  const c = await vscode.window.showInformationMessage(msg, { modal: true, detail }, { title: yes }, { title: no, isCloseAffordance: true });
  if (c?.title === yes) await punchByHand(dir);
}
// Still in from an earlier day (VS Code wasn't running at the out time): yours to settle. Asked once.
async function askMissedOut(since) {
  const asked = since ?? new Date(Date.now()).toDateString(); // unknown start: asked once a day
  if (attState().missedAsked === asked) return;
  await setAttState({ missedAsked: asked });
  const day = since && new Date(since).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const outAt = since && Z.atTime(since, rules().out);
  const choice = await vscode.window.showWarningMessage(
    since ? `You're still punched in to Zoho People since ${day}, ${hm(since)}: VS Code wasn't running at ${rules().out}.`
      : "You're punched in to Zoho People from an earlier day, and Ajwain can't see when.",
    ...(since && outAt > since ? [`Punch out at ${rules().out} ${day}`] : []), 'Punch out now', 'Leave it',
  );
  if (!choice || choice === 'Leave it') return;
  const r = await punch('out', choice === 'Punch out now' ? new Date(Date.now()) : new Date(outAt));
  vscode.window.setStatusBarMessage(`$(pass-filled) Punched out at ${hm(r.at ?? Date.now())} · Zoho People`, 6000);
}
// The status bar's menu. Every punch here is a person picking it: a command run by a script or another
// extension only opens the menu.
async function punchMenu() {
  if (!zohoOn) {
    const c = await vscode.window.showInformationMessage('Punch in and out of Zoho People from VS Code: in at 09:00, out at 18:00.', 'Connect Zoho People');
    return c && connectZoho();
  }
  const s = attState(), r = rules();
  const a = await pick([
    s.in ? { label: '$(debug-stop) Punch out now', a: 'out' } : { label: '$(play) Punch in now', a: 'in' },
    { label: `$(sign-in) Punch-in: ${MODES.punchIn[r.punchIn]?.(r)}`, description: 'change', a: 'punchIn' },
    { label: `$(sign-out) Punch-out: ${MODES.punchOut[r.punchOut]?.(r)}`, description: 'change', a: 'punchOut' },
    { label: '$(refresh) Check with Zoho People', a: 'sync' },
    { label: '$(link-external) Open Zoho People', a: 'web' },
    { label: '$(settings) Attendance settings', a: 'settings' },
    { label: '$(debug-disconnect) Disconnect Zoho People', a: 'disconnect' },
  ], `Zoho People: ${s.in ? `punched in since ${s.since ? hm(s.since) : '?'}` : 'punched out'} · ${hms(Z.workedToday(s.entries, Date.now()))} today`);
  if (!a) return;
  if (a.a === 'in' || a.a === 'out') return punchByHand(a.a);
  if (a.a === 'punchIn' || a.a === 'punchOut') {
    const m = await pick(Object.entries(MODES[a.a]).map(([k, f]) => ({ label: f(r).replace(/^./, (c) => c.toUpperCase()), description: k === r[a.a] ? 'current' : '', k })),
      a.a === 'punchIn' ? 'Punch in to Zoho People:' : 'Punch out of Zoho People:');
    return m && cfg().update(`attendance.${a.a}`, m.k, vscode.ConfigurationTarget.Global).then(renderPunch);
  }
  if (a.a === 'sync') { const z = await syncAttendance(); return vscode.window.setStatusBarMessage(`Zoho People: punched ${z.in ? 'in' : 'out'}`, 4000); }
  if (a.a === 'web') return vscode.env.openExternal(vscode.Uri.parse(`${zoho.hosts().people}/`));
  if (a.a === 'settings') return vscode.commands.executeCommand('workbench.action.openSettings', 'ajwain.attendance');
  return vscode.commands.executeCommand('ajwain.zohoDisconnect');
}
// Zoho's Self Client: no admin needed. You create it in the API console, and Ajwain trades its one-time code
// for a refresh token, kept in VS Code's secret storage.
async function connectZoho() {
  const G = vscode.ConfigurationTarget.Global;
  const cur = cfg().get('zoho.region') || 'in';
  const dc = await pick(Object.entries(Z.REGIONS).map(([k, r]) => ({ label: r.label, description: k === cur ? 'current' : '', k })).sort((a, b) => (b.k === cur) - (a.k === cur)),
    "Your Zoho data centre (the address you open Zoho People at, e.g. people.zoho.in)");
  if (!dc) return;
  await cfg().update('zoho.region', dc.k, G);
  const steps = [
    `1. In the Zoho API Console (${Z.REGIONS[dc.k].console}), choose Self Client and create it.`,
    '2. On the Client Secret tab, copy the Client ID and the Client Secret.',
    `3. On the Generate Code tab, enter the scope ${Z.SCOPE}, choose 10 minutes, add any description, and create. Copy the code.`,
    'Ajwain asks for the three next. The code works only once and only for a few minutes.',
  ].join('\n');
  const go = await vscode.window.showInformationMessage('Connect Zoho People', { modal: true, detail: steps }, 'Open the API Console', 'I have them');
  if (!go) return;
  if (go === 'Open the API Console') await vscode.env.openExternal(vscode.Uri.parse(Z.REGIONS[dc.k].console));
  const needed = (v) => (v.trim() ? null : 'Required');
  const clientId = await input('Client ID (Zoho API Console → Self Client → Client Secret tab)', { validateInput: needed });
  const clientSecret = clientId && (await input('Client Secret', { password: true, validateInput: needed }));
  const code = clientSecret && (await input(`The code from the Generate Code tab (scope ${Z.SCOPE})`, { password: true, validateInput: needed }));
  if (!code) return;
  const email = await input('Your email in Zoho People', {
    value: cfg().get('zoho.email') || me?.email || '', validateInput: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) ? null : 'An email address'),
  });
  if (!email) return;
  await zoho.connect({ clientId, clientSecret, code });
  await cfg().update('zoho.email', email.trim(), G);
  zohoOn = true;
  const z = await syncAttendance();
  vscode.window.showInformationMessage(`Connected to Zoho People. You're punched ${z.in ? `in${z.since ? ` since ${hm(z.since)}` : ''}` : 'out'}. `
    + `${plan(rules())}; click the timer in the status bar to change it.`);
}

// ---------- timer: one running stopwatch, shared by all windows ----------
const timerState = () => ctx.globalState.get('ajwain.timer');
const boardTimer = () => post({ type: 'timer', timer: timerState() ?? null });
function renderTimer() {
  const t = timerState();
  if (!t) return timerBar.hide();
  const min = Math.floor((Date.now() - t.start) / 60000);
  timerBar.text = `$(watch) ${t.key} ${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
  timerBar.tooltip = `Timing ${t.key} ${t.title} since ${new Date(t.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Click to stop and log it.`;
  timerBar.show();
}

async function startTimer(i) {
  const t = timerState();
  if (t?.key === i.key) return;
  if (t && !(await stopTimer(`Switching to ${i.key}`))) return; // the user kept the old one running
  await ctx.globalState.update('ajwain.timer', { key: i.key, id: i.id, title: i.title, start: Date.now() });
  renderTimer();
  boardTimer();
}

// Stops and logs (or discards) the running timer. Esc keeps it running and returns false.
async function stopTimer(reason) {
  const t = timerState();
  if (!t) return true;
  const min = Math.max(5, Math.round((Date.now() - t.start) / 300000) * 5);
  const c = await pick([
    { label: `$(check) Log ${pm.fmtDuration(min)} on ${t.key}`, a: 'log' },
    { label: '$(edit) Log a different amount…', a: 'edit' },
    { label: '$(trash) Discard this time', a: 'discard' },
  ], `${reason ? `${reason}. ` : ''}Stop the timer on ${t.key}? (Esc keeps it running)`);
  if (!c) return false;
  let minutes = min;
  if (c.a === 'edit') {
    const d = await input(`Time to log on ${t.key}`, { value: pm.fmtDuration(min), validateInput: validDuration });
    if (!d) return false;
    minutes = pm.parseDuration(d);
  }
  if (c.a !== 'discard') {
    // The note is what was committed meanwhile, when there is anything.
    const root = await repoRoot().catch(() => null);
    // My commits since the timer started (not the second it started in, and not other people's).
    const email = root ? await git(root, 'config', 'user.email').catch(() => '') : '';
    const done = root ? await git(root, 'log', `--since=${new Date(t.start + 1000).toISOString()}`, ...(email ? ['--fixed-strings', `--author=${email}`] : []), '--format=%s').catch(() => '') : '';
    await logWork({ id: t.id, key: t.key }, minutes, done.split('\n').filter(Boolean).reverse().join('; ').slice(0, 300));
    vscode.window.setStatusBarMessage(`Logged ${pm.fmtDuration(minutes)} on ${t.key}`, 4000);
  }
  await ctx.globalState.update('ajwain.timer', undefined);
  renderTimer();
  boardTimer();
  refresh();
  return true;
}

// ---------- in the editor: ticket keys are links with a hover card; TODOs become tickets ----------
let projectKeys = new Set();
const loadProjectKeys = async () => {
  projects = await api.projects(await workspaceId()).catch(() => []);
  projectKeys = new Set(projects.map((p) => p.key));
};
const issueCache = new Map();
async function cachedIssue(key) {
  const c = issueCache.get(key);
  if (c && Date.now() - c.at < 60e3) return c.issue;
  const issue = await api.issue(key);
  issueCache.set(key, { at: Date.now(), issue });
  return issue;
}
const TODO_RX = /\b(TODO|FIXME|HACK|XXX)\b(?!\()[:\s-]*(.*)$/;
const mdEscape = (s) => String(s).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

function codeProviders() {
  const files = { scheme: 'file' };
  return [
    vscode.languages.registerDocumentLinkProvider(files, {
      provideDocumentLinks(doc) {
        if (!me || !projectKeys.size || doc.lineCount > 20000) return [];
        const out = [];
        for (const m of doc.getText().matchAll(/\b([A-Z][A-Z0-9]+)-\d+\b/g)) {
          if (!projectKeys.has(m[1])) continue; // only real project keys, so "UTF-8" stays plain text
          const link = new vscode.DocumentLink(new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length)), vscode.Uri.parse(cmdUri('ajwain.openBoard', m[0])));
          link.tooltip = `Open ${m[0]} in Ajwain`;
          out.push(link);
        }
        return out;
      },
    }),
    vscode.languages.registerHoverProvider(files, {
      async provideHover(doc, pos) {
        const r = doc.getWordRangeAtPosition(pos, /[A-Z][A-Z0-9]+-\d+/);
        const key = r && doc.getText(r);
        if (!key || !me || !projectKeys.has(key.split('-')[0])) return;
        const i = await cachedIssue(key).catch(() => null);
        if (!i) return;
        const md = new vscode.MarkdownString(
          `**${i.key}** ${mdEscape(i.title)}\n\n${mdEscape(statusName(i))} · ${cap(i.issue_type)} · ${cap(i.priority)}${timeText(i) ? ` · ${timeText(i)}` : ''}\n\n` +
          `[Open](${cmdUri('ajwain.openBoard', key)}) · [Start work](${cmdUri('ajwain.startWork', key)}) · [Implement with Claude](${cmdUri('ajwain.implementWithClaude', key)})`,
        );
        md.isTrusted = { enabledCommands: ['ajwain.openBoard', 'ajwain.startWork', 'ajwain.implementWithClaude'] };
        return new vscode.Hover(md, r);
      },
    }),
    vscode.languages.registerCodeActionsProvider(files, {
      provideCodeActions(doc, range) {
        const m = me && doc.lineAt(range.start.line).text.match(TODO_RX);
        if (!m) return [];
        const a = new vscode.CodeAction(`Create a ticket for this ${m[1]}`, vscode.CodeActionKind.QuickFix);
        a.command = { command: 'ajwain.ticketFromCode', title: a.title, arguments: [doc.uri, range.start.line] };
        return [a];
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  ];
}

// From a TODO line (code action) or the editor selection (context menu): the ticket links back to the
// code, and a TODO gets tagged as TODO(OG-12).
async function ticketFromCode(uri, line) {
  const ed = vscode.window.activeTextEditor;
  const doc = uri instanceof vscode.Uri ? await vscode.workspace.openTextDocument(uri) : ed?.document;
  if (!doc) throw new Error('Open a file first');
  const fromSelection = typeof line !== 'number' && ed && !ed.selection.isEmpty;
  const at = typeof line === 'number' ? line : ed?.selection.start.line ?? 0;
  const todo = doc.lineAt(at).text.match(TODO_RX);
  const range = fromSelection ? ed.selection : new vscode.Range(Math.max(0, at - 3), 0, Math.min(doc.lineCount - 1, at + 3), 10000);
  const snippet = doc.getText(range).split('\n').slice(0, 40).join('\n').trimEnd();
  const strip = (t) => t.replace(/^\s*(\/\/+|#+|\/?\*+|--|<!--)\s*/, '').replace(/\s*(\*\/|-->)\s*$/, '').trim();
  const guess = todo ? strip(todo[2]) : strip(snippet.split('\n').find((l) => l.trim()) ?? '');
  const p = await pickProject();
  if (!p) return;
  const title = await input('Ticket title', { value: guess.slice(0, 100) });
  if (!title) return;
  const where = `${vscode.workspace.asRelativePath(doc.uri)}:${at + 1}`;
  const branch = await git(path.dirname(doc.uri.fsPath), 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '');
  const [first] = await api.statuses(p.id);
  const issue = await api.create({
    project: p.id, title, issue_type: todo?.[1] === 'FIXME' ? 'BUG' : 'TASK', priority: 'MEDIUM', assignee: me.id, ...(first && { status: first.id }),
    description: `## Context\n\`${where}\`${branch ? ` (on \`${branch}\`)` : ''}\n\n\`\`\`${doc.languageId}\n${snippet}\n\`\`\`\n\n## Acceptance criteria\n- [ ] `,
  });
  if (todo) {
    const e = new vscode.WorkspaceEdit();
    e.insert(doc.uri, new vscode.Position(at, todo.index + todo[1].length), `(${issue.key})`);
    await vscode.workspace.applyEdit(e);
  }
  refresh();
  const c = await vscode.window.showInformationMessage(`Created ${issue.key}: ${title}`, 'Open', 'Start work');
  if (c === 'Open') openBoard(issue.key);
  if (c === 'Start work') await startWork(issue);
}

// ---------- ship: push, open the pull request, move the ticket to review ----------
async function reviewStatus(i) {
  const st = await api.statuses(i.project);
  const want = cfg().get('reviewStatus');
  if (want) return st.find((s) => s.name.toLowerCase() === want.toLowerCase()) ?? null;
  return st.find((s) => /review/i.test(s.name)) ?? st.find((s) => /test|qa/i.test(s.name)) ?? null;
}

async function openPR(i) {
  const root = await repoRoot();
  const branch = await git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  const base = await defaultBranch(root);
  if (branch === base || branch === 'HEAD') throw new Error(`You're on ${branch}. Start work on ${i.key} first, so it has its own branch.`);
  if (keyFor(branch) !== i.key) {
    const go = await vscode.window.showWarningMessage(`You're on ${branch}, which isn't ${i.key}'s branch.`, 'Open PR from it anyway');
    if (!go) return false;
  }
  if (await git(root, 'status', '--porcelain')) {
    const go = await vscode.window.showWarningMessage("You have uncommitted changes. They won't be in the pull request.", 'Open PR anyway');
    if (!go) return false;
  }
  if (timerState()?.key === i.key) await stopTimer('Opening the pull request');
  const commits = (await git(root, 'log', `origin/${base}..HEAD`, '--format=%s (%h)').catch(() => '')).split('\n').filter(Boolean);
  if (!commits.length) throw new Error(`${branch} has no commits that aren't on ${base} yet.`);
  const full = await api.issue(i.key);
  const title = `${i.key}: ${i.title}`.slice(0, 150);
  const body = pm.prBody(full, commits);
  const remote = pm.parseRemote(await git(root, 'remote', 'get-url', 'origin'));
  let url = null, created = false;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pull request for ${i.key}` }, async (p) => {
    p.report({ message: `pushing ${branch}…` });
    await git(root, 'push', '-u', 'origin', branch);
    const aws = remote.kind === 'codecommit' && findBin('aws');
    const gh = remote.kind === 'github' && findBin('gh');
    if (aws) {
      p.report({ message: 'creating it in CodeCommit…' });
      remote.region ??= (await run(aws, ['configure', 'get', 'region']).catch(() => '')) || 'us-east-1';
      const out = await run(aws, ['codecommit', 'create-pull-request', '--title', title, '--description', body.slice(0, 10000),
        '--targets', `repositoryName=${remote.repo},sourceReference=${branch},destinationReference=${base}`, '--region', remote.region, '--output', 'json']);
      url = pm.codecommitPrUrl(remote, JSON.parse(out).pullRequest.pullRequestId);
      created = true;
    } else if (gh) {
      p.report({ message: 'creating it on GitHub…' });
      url = (await run(gh, ['pr', 'create', '--title', title, '--body', body, '--base', base, '--head', branch], { cwd: root })).split('\n').pop();
      created = true;
    } else url = pm.newPrUrl(remote, branch, base, title, body);
  });
  if (!created) {
    await vscode.env.clipboard.writeText(body);
    if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
  }
  const st = await reviewStatus(i);
  if (st && st.id !== i.status) await api.update(i.id, { status: st.id });
  if (created) await api.comment(i.id, `Pull request: ${url}`);
  await record('pr', { key: i.key });
  celebrate('ship', `${i.key} shipped for review`, created ? 'Pull request opened' : 'Branch pushed');
  refresh();
  const moved = st ? ` ${i.key} is now ${st.name}.` : '';
  if (!created) return void vscode.window.showInformationMessage(`Pushed ${branch}. Finish the pull request in the browser; its description is on your clipboard.${moved}`);
  const c = await vscode.window.showInformationMessage(`Opened a pull request for ${i.key}.${moved}`, 'Open PR', 'Copy link');
  if (c === 'Open PR') vscode.env.openExternal(vscode.Uri.parse(url));
  if (c === 'Copy link') vscode.env.clipboard.writeText(url);
}

// ---------- done: final status, log the timer, tidy up the branch or worktree ----------
async function finish(i) {
  if (timerState()?.key === i.key) await stopTimer(`Finishing ${i.key}`);
  const st = await api.statuses(i.project);
  const ordered = [...st.filter((s) => s.category === 'DONE'), ...st.filter((s) => s.category !== 'DONE')];
  const s = await pick(ordered.map((x) => ({ label: x.name, description: x.id === i.status ? 'current' : x.category === 'DONE' ? 'done' : '', s: x })), `Finish ${i.key}: move it to…`);
  if (!s) return false;
  if (s.s.id !== i.status) await api.update(i.id, { status: s.s.id });
  const done = s.s.category === 'DONE';
  refresh();
  const root = await repoRoot().catch(() => null);
  const branch = root && (await git(root, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => ''));
  if (!branch || keyFor(branch) !== i.key) {
    if (done) await record('finish', { key: i.key, issue_type: i.issue_type }), celebrate('finish', `${i.key} done`, i.title);
    return void vscode.window.setStatusBarMessage(`${i.key} → ${s.label}`, 5000);
  }
  const main = await mainRoot(root);
  const inWorktree = path.resolve(main) !== path.resolve(root);
  const base = await defaultBranch(root);
  const c = await pick([
    inWorktree
      ? { label: '$(trash) Remove this worktree and close the window', detail: `${root} · the branch is deleted too once it's merged`, a: 'worktree' }
      : { label: `$(git-branch) Switch back to ${base}`, detail: `pulls ${base}, and deletes ${branch} once it's merged`, a: 'switch' },
    { label: '$(circle-slash) Leave the branch as it is', a: 'keep' },
  ], `${i.key} → ${s.label}. Clean up?`);
  const tidy = !!c && c.a !== 'keep';
  const dirty = tidy && !!(await git(root, 'status', '--porcelain'));
  if (done) await record('finish', { key: i.key, issue_type: i.issue_type, cleanup: tidy && !dirty });
  if (done) celebrate('finish', `${i.key} done`, i.title);
  if (!tidy) return;
  if (dirty) throw new Error(`${branch} has uncommitted changes. Commit or stash them first.`);
  if (c.a === 'switch') {
    await git(root, 'checkout', base);
    await git(root, 'pull', '--ff-only').catch(() => {});
  } else await git(main, 'worktree', 'remove', root);
  // -d refuses unmerged work, so nothing is lost; a pushed branch also stays on the remote.
  const deleted = await git(main, 'branch', '-d', branch).then(() => true, () => false);
  vscode.window.showInformationMessage(`${i.key} finished. ${deleted ? `Deleted ${branch}.` : `Kept ${branch}: it isn't merged yet.`}`);
  if (c.a === 'worktree') await vscode.commands.executeCommand('workbench.action.closeWindow');
}

// ---------- build: Claude Code in the ticket's own checkout, with the ticket as its brief ----------
async function implementWithClaude(i) {
  const bin = findBin('claude', 'claude.path');
  if (!bin) throw new Error('Claude Code CLI not found. Install it, or set "ajwain.claude.path" in settings.');
  const root = await repoRoot();
  const main = await mainRoot(root);
  const wt = `${main}-${i.key}`;
  let cwd;
  if (keyFor(await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')) === i.key) cwd = root;
  else if (fs.existsSync(wt)) cwd = wt;
  else {
    const c = await pick([
      { label: '$(split-horizontal) In a new worktree', detail: `${wt}: works in parallel, your checkout stays as it is`, worktree: true },
      { label: '$(git-branch) In this checkout', detail: `switches to ${branchOf(i)}`, worktree: false },
    ], `Where should Claude work on ${i.key}?`);
    if (!c) return false;
    cwd = (await pm.startBranch(git, c.worktree ? main : root, i, c.worktree, cfg().get('branchTemplate'))).path;
    await api.startIssue(i, me.id);
    if (cfg().get('timer.autoStart')) await startTimer(i);
  }
  const full = await api.issue(i.key);
  const kids = full.children ?? [];
  const prompt = [
    `Implement ticket ${i.key}: ${i.title}`,
    '',
    full.description?.trim() || '(No description yet: ask me what is needed before changing code.)',
    kids.length ? `\nSubtasks:\n${kids.map((k) => `- ${k.key} ${k.title}`).join('\n')}` : null,
    '',
    `Work on the current branch. Commit in small steps, each message starting "${i.key}: ".`,
    'Meet the acceptance criteria above. When you are done, summarise what changed and how to test it.',
  ].filter((l) => l != null).join('\n');
  const term = vscode.window.createTerminal({ name: `Claude · ${i.key}`, cwd, shellPath: bin, shellArgs: [prompt], iconPath: iconPath('logo') });
  term.show();
  refresh();
}

// ---------- attachments ----------
async function uploadFiles(issue, files) {
  const done = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Attaching to ${issue.key}` }, async (p) => {
    for (const f of files) {
      p.report({ message: `${f.name} (${pm.fmtSize(f.bytes.length)})` });
      done.push(await api.attach(pm.issueTarget(issue), f));
    }
  });
  refresh();
  return done;
}
async function pickAndAttach(issue, uris) {
  uris ??= await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: `Attach to ${issue.key}` });
  if (!uris?.length) return [];
  const files = uris.map((u) => ({ name: path.basename(u.fsPath), bytes: fs.readFileSync(u.fsPath) }));
  const big = files.find((f) => f.bytes.length > pm.MAX_ATTACHMENT);
  if (big) throw new Error(`${big.name} is larger than 20 MB, the app's limit.`);
  const done = await uploadFiles(issue, files);
  vscode.window.setStatusBarMessage(`Attached ${done.length} file${done.length === 1 ? '' : 's'} to ${issue.key}`, 5000);
  return done;
}
// Explorer / editor tab: "Attach to ticket…" for the clicked file(s).
async function attachFiles(uri, uris) {
  const targets = uris?.length ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
  if (!targets.length) throw new Error('Pick a file to attach first');
  const issue = await resolveIssue();
  if (issue) await pickAndAttach(issue, targets);
}
async function saveImage(dataUrl, name) {
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), name)), filters: { Images: ['png'] } });
  if (!target) return false;
  fs.writeFileSync(target.fsPath, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
  vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`, 'Open').then((c) => c && vscode.env.openExternal(target));
  return true;
}

// ---------- breaks: suggested from real activity, not a wall clock ----------
const IDLE = 5 * 60e3;
let lastActive = 0, focusStart = 0, focusSession = null;
function touch() {
  const now = Date.now();
  if (now - lastActive > IDLE) {
    // Back after a pause: the pause was a break (or the day's start). Bank the focus session that ended.
    if (focusStart && lastActive - focusStart >= 15 * 60e3) record('focus', { minutes: Math.round((lastActive - focusStart) / 60000) });
    focusStart = now;
  }
  lastActive = now;
}
// "auto": activity-based breaks, unless another stretch extension is installed (then it does the job).
function breaksMode() {
  const m = cfg().get('breaks.mode') || 'auto';
  if (m !== 'auto') return m;
  return vscode.extensions.getExtension?.('jingjing2222.jj-stretch') ? 'off' : 'activity';
}
function breakTick() {
  const now = Date.now();
  if (focusSession) {
    const left = Math.max(0, focusSession.end - now);
    focusBar.text = `$(target) Focus ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
    focusBar.tooltip = 'Focus session: click to end it early';
    focusBar.show();
    if (!left) {
      focusSession = null;
      focusBar.hide();
      record('focus', { minutes: cfg().get('breaks.focusMinutes') || 25 });
      showBreak({ kind: 'stretch', focused: cfg().get('breaks.focusMinutes') || 25, pomodoro: true });
    }
    return;
  }
  if (breaksMode() !== 'activity' || breakPanel || !focusStart || now - lastActive > IDLE) return;
  const focused = now - focusStart;
  if (focused < (cfg().get('breaks.every') || 50) * 60e3) return;
  if (now - (ctx.globalState.get('ajwain.breakAt') ?? 0) < 10 * 60e3) return; // another window just suggested one
  ctx.globalState.update('ajwain.breakAt', now);
  showBreak({ kind: 'stretch', focused: Math.round(focused / 60000) });
}
async function toggleFocus() {
  if (focusSession) {
    focusSession = null;
    focusBar.hide();
    return vscode.window.setStatusBarMessage('Focus session ended', 3000);
  }
  const min = cfg().get('breaks.focusMinutes') || 25;
  focusSession = { start: Date.now(), end: Date.now() + min * 60e3 };
  breakTick();
  vscode.window.setStatusBarMessage(`$(target) ${min} minutes of focus. A stretch break follows.`, 4000);
}

// The break screen: a full tab with the mascot leading a short routine (media/break.js).
function showBreak(info) {
  if (breakPanel) return breakPanel.reveal();
  breakPanel = vscode.window.createWebviewPanel('ajwain.break', info.kind === 'eyes' ? 'Eye break' : 'Stretch break', vscode.ViewColumn.Active, {
    enableScripts: true, localResourceRoots: [ctx.extensionUri],
  });
  breakPanel.iconPath = iconPath('stretch');
  const web = breakPanel.webview;
  const src = (f) => web.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', f));
  const nonce = crypto.randomBytes(16).toString('base64');
  const today = journal().filter((e) => e.type === 'break' && new Date(e.t).toDateString() === new Date().toDateString()).length;
  web.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource} 'unsafe-inline'; script-src ${web.cspSource} 'nonce-${nonce}'; img-src ${web.cspSource} data:;">
<link rel="stylesheet" href="${src('board.css')}"><link rel="stylesheet" href="${src('break.css')}"></head>
<body data-info="${encodeURIComponent(JSON.stringify({ ...info, today }))}"><script type="module" nonce="${nonce}" src="${src('break.js')}"></script></body></html>`;
  web.onDidReceiveMessage(async (m) => {
    if (m.type === 'done') {
      if (m.completed) await record('break', { kind: info.kind });
      focusStart = Date.now(); // a fresh session starts after the break
      breakPanel?.dispose();
      if (m.focus) toggleFocus();
    }
    if (m.type === 'snooze') {
      focusStart = Date.now() - ((cfg().get('breaks.every') || 50) - (m.minutes || 10)) * 60e3;
      breakPanel?.dispose();
    }
  });
  breakPanel.onDidDispose(() => (breakPanel = null));
}

// intent: a ticket key, or { key?, plan?, view?, create?, standup?, shutdown?, wrapped?, lucky? }.
function openBoard(intent) {
  if (typeof intent === 'string') intent = { key: intent };
  if (panel) {
    panel.reveal();
    if (intent) panel.webview.postMessage({ type: 'intent', intent });
    return;
  }
  pendingOpen = intent;
  panel = vscode.window.createWebviewPanel('ajwain.board', 'Ajwain', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [ctx.extensionUri],
  });
  panel.iconPath = iconPath('logo');
  page(panel.webview, 'board.js', ['board.css']);
  serve(panel.webview, boardApi);
  panel.onDidChangeViewState(() => panel?.visible && wake());
  panel.onDidDispose(() => (panel = null));
}

// A webview page: our stylesheets and one module script, under a strict CSP.
function page(web, script, styles) {
  const src = (f) => web.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', f));
  const nonce = crypto.randomBytes(16).toString('base64');
  web.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource} 'unsafe-inline'; script-src ${web.cspSource} 'nonce-${nonce}'; img-src ${web.cspSource} https: data: blob:; media-src https: blob:;">
${styles.map((f) => `<link rel="stylesheet" href="${src(f)}">`).join('')}</head>
<body><script type="module" nonce="${nonce}" src="${src(script)}"></script></body></html>`;
}
// The webviews call the host as {id, method, args} and get {id, result} or {id, error} back.
function serve(web, methods) {
  return web.onDidReceiveMessage(async ({ id, method, args }) => {
    const reply = (m) => { try { web.postMessage(m)?.then?.(undefined, () => {}); } catch { /* disposed */ } };
    try {
      if (!Object.hasOwn(methods, method)) throw new Error(`No host method "${method}"`);
      reply({ id, result: (await methods[method](...args)) ?? null });
    } catch (e) {
      reply({ id, error: e.message });
    }
  });
}

// "Wake": you came back (to VS Code, to the board's tab, to the sidebar), or it's been a while and you're looking.
// The webviews reload quietly if what they show is stale, so changes made on the web app show up by themselves.
const WAKE_EVERY = 2 * 60e3;
const wake = () => post({ type: 'wake' });
function watchForChanges(context) {
  const timer = setInterval(() => { if (me && vscode.window.state.focused && (panel?.visible || side?.visible)) wake(); }, WAKE_EVERY);
  context.subscriptions.push({ dispose: () => clearInterval(timer) }, vscode.window.onDidChangeWindowState((s) => s.focused && me && wake()));
}

// ---------- the sidebar's Home view ----------
// The board's host API, plus opening the board, the New issue form and a ticket's action menu.
const sideApi = {
  ...boardApi,
  init: async () => ({ me, workspace: me ? await workspaceId() : null, project: scopeProject(), timer: timerState() ?? null }),
  openBoard: (intent) => openBoard(intent ?? undefined),
  create: () => vscode.commands.executeCommand('ajwain.create'),
  actions: async ({ key }) => issueActions(await api.issue(key)),
};
delete sideApi.save; // the board's remembered state is the board's
function resolveSide(view) {
  side = view;
  view.webview.options = { enableScripts: true, localResourceRoots: [ctx.extensionUri] };
  page(view.webview, 'side.js', ['board.css', 'side.css']);
  serve(view.webview, sideApi);
  view.onDidChangeVisibility?.(() => view.visible && wake());
  view.onDidDispose(() => { if (side === view) side = null; });
}

module.exports = { activate, deactivate() {} };
