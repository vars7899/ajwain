// A stand-in for the `vscode` module, enough to run the real extension.js under Node.
//   const vs = createVscode(); install(vs); const ext = require('../extension.js'); await ext.activate(vs.context(...));
// Prompts (quick picks, input boxes, messages with buttons) take answers from vs.answers, in order:
//   a string picks the item whose label equals it, else contains it (or is the input box's value); undefined cancels;
//   a function gets (items or options) and returns the answer. A prompt with no answer queued is cancelled and recorded in
//   vs.unanswered. Everything the extension shows or does is recorded on vs (messages, terminals, executed, ...).
const fs = require('fs');
const path = require('path');
const Module = require('module');

class Disposable {
  constructor(fn = () => {}) { this.dispose = fn; }
  static from(...ds) { return new Disposable(() => ds.forEach((d) => d?.dispose?.())); }
}
const disposable = () => new Disposable();

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (fn) => (this.listeners.add(fn), new Disposable(() => this.listeners.delete(fn)));
  }
  fire(e) { return Promise.all([...this.listeners].map((fn) => fn(e))); }
  dispose() { this.listeners.clear(); }
}

class Uri {
  constructor(scheme, p, query = '', fragment = '', raw) { Object.assign(this, { scheme, path: p, query, fragment, raw }); }
  get fsPath() { return this.path; }
  static file(p) { return new Uri('file', path.resolve(p)); }
  static parse(s) {
    const u = new URL(s);
    return new Uri(u.protocol.slice(0, -1), decodeURIComponent(u.pathname), u.search.slice(1), u.hash.slice(1), s);
  }
  static joinPath(base, ...parts) { return new Uri(base.scheme, path.posix.join(base.path, ...parts)); }
  with(c) { return new Uri(c.scheme ?? this.scheme, c.path ?? this.path, c.query ?? this.query, c.fragment ?? this.fragment); }
  toString() { return this.raw ?? `${this.scheme}://${this.path}`; }
}

class Position {
  constructor(line, character) { Object.assign(this, { line, character }); }
}
class Range {
  constructor(a, b, c, d) {
    [this.start, this.end] = a instanceof Position ? [a, b] : [new Position(a, b), new Position(c, d)];
  }
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}
class WorkspaceEdit {
  constructor() { this.edits = []; }
  insert(uri, position, text) { this.edits.push({ uri, range: new Range(position, position), text }); }
  replace(uri, range, text) { this.edits.push({ uri, range, text }); }
  delete(uri, range) { this.edits.push({ uri, range, text: '' }); }
}
class TreeItem { constructor(label, collapsibleState = 0) { Object.assign(this, { label, collapsibleState }); } }
class ThemeIcon { constructor(id) { this.id = id; } }
class MarkdownString { constructor(value = '') { this.value = value; } appendMarkdown(s) { this.value += s; return this; } }
class Hover { constructor(contents, range) { Object.assign(this, { contents, range }); } }
class DocumentLink { constructor(range, target) { Object.assign(this, { range, target }); } }
class CodeAction { constructor(title, kind) { Object.assign(this, { title, kind }); } }
class FileSystemError extends Error {
  static FileNotFound(u) { return Object.assign(new FileSystemError(`FileNotFound: ${u}`), { code: 'FileNotFound' }); }
  static NoPermissions(u) { return Object.assign(new FileSystemError(`NoPermissions: ${u ?? ''}`), { code: 'NoPermissions' }); }
}

// A TextDocument over a string.
function makeDocument(uri, text, languageId = 'plaintext') {
  const lines = text.split('\n');
  const offsetAt = (p) => lines.slice(0, p.line).reduce((a, l) => a + l.length + 1, 0) + Math.min(p.character, lines[p.line]?.length ?? 0);
  const positionAt = (o) => {
    let line = 0;
    while (line < lines.length - 1 && o > lines[line].length) o -= lines[line++].length + 1;
    return new Position(line, o);
  };
  return {
    uri, fileName: uri.fsPath, languageId, lineCount: lines.length, isDirty: false,
    lineAt: (n) => ({ lineNumber: typeof n === 'number' ? n : n.line, text: lines[typeof n === 'number' ? n : n.line] }),
    getText: (r) => (r ? text.slice(offsetAt(r.start), offsetAt(r.end)) : text),
    positionAt, offsetAt,
    getWordRangeAtPosition(pos, rx = /\w+/) {
      for (const m of lines[pos.line].matchAll(new RegExp(rx.source, 'g')))
        if (m.index <= pos.character && pos.character <= m.index + m[0].length) return new Range(pos.line, m.index, pos.line, m.index + m[0].length);
    },
  };
}

function createVscode({ settings = {} } = {}) {
  const pkg = require('../package.json');
  const defaults = Object.fromEntries(Object.entries(pkg.contributes.configuration.properties).map(([k, v]) => [k, v.default]));
  const vs = {
    answers: [], unanswered: [], messages: [], statusMessages: [], logs: [], terminals: [], executed: [], opened: [], edits: [],
    clipboard: '', panels: [], trees: {}, viewProviders: {}, providers: {}, statusBars: [], fileSystems: {}, documents: new Map(), settings: new Map(Object.entries(settings)),
  };
  const configChanged = new EventEmitter();
  const events = { selection: new EventEmitter(), editor: new EventEmitter(), document: new EventEmitter(), windowState: new EventEmitter() };

  function answer(kind, prompt, items, opts) {
    if (!vs.answers.length) return void vs.unanswered.push({ kind, prompt });
    const a = vs.answers.shift();
    if (typeof a === 'function') return a(items ?? opts);
    if (a === undefined || !items) return a;
    const label = (x) => (typeof x === 'string' ? x : x.label);
    const hit = (s) => items.find((x) => label(x) === s) ?? items.find((x) => label(x).includes(s));
    if (Array.isArray(a)) return a.map(hit);
    const found = hit(a);
    if (!found) throw new Error(`No "${a}" among: ${items.map(label).join(' | ')} (${kind}: ${prompt})`);
    return found;
  }
  const message = (level) => async (msg, ...items) => {
    if (items[0] && typeof items[0] === 'object' && !items[0].title) items.shift(); // options ({modal})
    vs.messages.push({ level, msg, items });
    return items.length ? answer('message', msg, items) : undefined;
  };

  const configuration = (section) => {
    const full = (k) => (section ? `${section}.${k}` : k);
    const value = (k) => (vs.settings.has(full(k)) ? vs.settings.get(full(k)) : defaults[full(k)]);
    return {
      get: (k, d) => value(k) ?? d,
      has: (k) => value(k) !== undefined,
      inspect: (k) => ({ key: full(k), defaultValue: defaults[full(k)], globalValue: vs.settings.get(full(k)) }),
      async update(k, v) {
        v === undefined ? vs.settings.delete(full(k)) : vs.settings.set(full(k), v);
        const key = full(k);
        await configChanged.fire({ affectsConfiguration: (s) => key === s || key.startsWith(`${s}.`) });
      },
    };
  };

  const statusBarItem = () => {
    const item = { text: '', tooltip: '', command: null, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
    vs.statusBars.push(item);
    return item;
  };

  function createWebviewPanel(viewType, title, column, options) {
    let receive, disposeFn;
    const outbox = [];
    const panel = {
      viewType, title, options, outbox, revealed: 0, iconPath: null, visible: true, active: true,
      webview: {
        html: '', cspSource: 'vscode-webview:', options,
        asWebviewUri: (u) => u,
        onDidReceiveMessage: (fn) => ((receive = fn), disposable()),
        postMessage: async (m) => (outbox.push(JSON.parse(JSON.stringify(m))), true),
      },
      reveal() { panel.revealed++; },
      onDidDispose: (fn) => ((disposeFn = fn), disposable()),
      // Visibility: the board tab (view state) and a sidebar view (visibility). show(false/true) plays it.
      onDidChangeViewState: (fn) => ((panel.viewStateFn = fn), disposable()),
      onDidChangeVisibility: (fn) => ((panel.visibilityFn = fn), disposable()),
      show(visible = true) { panel.visible = visible; panel.viewStateFn?.({ webviewPanel: panel }); panel.visibilityFn?.(); },
      dispose: () => disposeFn?.(),
      // The webview's side: send {id, method, args} JSON-serialized like VS Code does, return the reply.
      async call(method, ...args) {
        const id = `t${outbox.length}-${Math.random()}`;
        await receive(JSON.parse(JSON.stringify({ id, method, args })));
        const reply = outbox.find((m) => m.id === id);
        if (reply?.error) throw new Error(reply.error);
        return reply?.result;
      },
    };
    vs.panels.push(panel);
    return panel;
  }
  // Shows a webview view (as VS Code does when its sidebar section opens): a panel-like object, resolved by the provider.
  vs.resolveView = (id) => {
    const view = createWebviewPanel(id, id, null, {});
    vs.viewProviders[id].resolveWebviewView(view, {}, { isCancellationRequested: false });
    return view;
  };

  const api = {
    Disposable, EventEmitter, Uri, Position, Range, WorkspaceEdit, TreeItem, ThemeIcon, MarkdownString, Hover, DocumentLink, CodeAction, FileSystemError,
    CodeActionKind: { QuickFix: 'quickfix', Refactor: 'refactor' },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    window: {
      activeTextEditor: undefined,
      onDidChangeTextEditorSelection: events.selection.event,
      state: { focused: true },
      onDidChangeWindowState: events.windowState.event,
      onDidChangeActiveTerminal: () => disposable(),
      onDidStartTerminalShellExecution: () => disposable(),
      onDidChangeActiveTextEditor: events.editor.event,
      showOpenDialog: async (opts = {}) => answer('openDialog', opts.openLabel, null, opts),
      showSaveDialog: async (opts = {}) => answer('saveDialog', opts.saveLabel, null, opts),
      createOutputChannel: (name) => {
        const line = (level) => (...a) => vs.logs.push({ level, text: a.join(' ') });
        return { name, info: line('info'), warn: line('warn'), error: line('error'), debug: line('debug'), trace: line('trace'), appendLine: line('info'), append: line('info'), show() {}, dispose() {} };
      },
      createStatusBarItem: statusBarItem,
      createTreeView: (id, opts) => (vs.trees[id] = { id, ...opts, description: '', dispose() {}, reveal: async () => {} }),
      createWebviewPanel,
      registerWebviewViewProvider: (id, provider) => ((vs.viewProviders[id] = provider), disposable()),
      createTerminal: (opts) => {
        const t = { ...opts, shown: false, sent: [], show() { t.shown = true; }, sendText(s) { t.sent.push(s); }, dispose() {} };
        vs.terminals.push(t);
        return t;
      },
      showQuickPick: async (items, opts = {}) => answer('quickPick', opts.placeHolder ?? opts.title, await items),
      showInputBox: async (opts = {}) => {
        const value = answer('inputBox', opts.prompt, null, opts);
        const invalid = value !== undefined && (await opts.validateInput?.(value));
        if (invalid) throw new Error(`Input "${value}" for "${opts.prompt}" is invalid: ${invalid}`);
        return value;
      },
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      setStatusBarMessage: (text) => (vs.statusMessages.push(text), disposable()),
      withProgress: (opts, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable() }),
      showTextDocument: async (doc, opts) => (vs.opened.push({ doc, opts }), { document: doc }),
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: configuration,
      onDidChangeConfiguration: configChanged.event,
      onDidChangeTextDocument: events.document.event,
      registerFileSystemProvider: (scheme, provider) => ((vs.fileSystems[scheme] = provider), disposable()),
      openTextDocument: async (uri) => vs.documents.get(uri.toString()) ?? makeDocument(uri, fs.readFileSync(uri.fsPath, 'utf8')),
      asRelativePath: (u) => {
        const p = typeof u === 'string' ? u : u.fsPath, root = api.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return root && p.startsWith(root + path.sep) ? path.relative(root, p) : p;
      },
      applyEdit: async (e) => (vs.edits.push(e), true),
    },
    commands: {
      registry: new Map(),
      registerCommand: (name, fn) => (api.commands.registry.set(name, fn), new Disposable(() => api.commands.registry.delete(name))),
      executeCommand: async (name, ...args) => {
        vs.executed.push({ name, args });
        return api.commands.registry.get(name)?.(...args);
      },
    },
    env: {
      clipboard: { writeText: async (t) => { vs.clipboard = t; }, readText: async () => vs.clipboard },
      openExternal: async (uri) => (vs.executed.push({ name: 'openExternal', args: [uri.toString()] }), true),
    },
    languages: Object.fromEntries(['DocumentLinkProvider', 'HoverProvider', 'CodeActionsProvider'].map((k) => [`register${k}`, (selector, provider, meta) => ((vs.providers[k] = { selector, provider, meta }), disposable())])),
    extensions: { getExtension: () => undefined },
  };
  Object.assign(vs, {
    api, makeDocument, events,
    // The VS Code window losing or regaining focus.
    focusWindow: (focused) => { api.window.state.focused = focused; events.windowState.fire({ focused }); },
    // Point the workspace at folders on disk.
    setFolders: (...dirs) => { api.workspace.workspaceFolders = dirs.map((d, index) => ({ uri: Uri.file(d), name: path.basename(d), index })); },
    // An extension context with an in-memory secret store and global state.
    context({ root, storage }) {
      const secrets = new Map(), state = new Map();
      return {
        subscriptions: [], extensionPath: root, extensionUri: Uri.file(root), globalStorageUri: Uri.file(storage), state, extension: { id: 'ajwain.ajwain' },
        secrets: { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k), onDidChange: () => disposable() },
        globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => void (v === undefined ? state.delete(k) : state.set(k, v)), keys: () => [...state.keys()], setKeysForSync() {} },
      };
    },
  });
  return vs;
}

// require('vscode') returns this stub from now on.
function install(vs) {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vs.api : load.call(this, request, ...rest);
  };
  return () => { Module._load = load; };
}

module.exports = { createVscode, install, makeDocument };
