# Working on Ajwain

There is no build step and there are no dependencies. The files you edit are the files that ship.

## Set up

You need Node 22 or newer, git, and Chrome or Chromium for the board tests.

```bash
npm test             # everything, about 40 seconds, no network
npm run dev          # the demo server, and the board in a browser
npm run package      # builds ajwain-<version>.vsix
```

To run your working copy, open this folder in VS Code and press F5: a second window opens with the extension loaded from these files. Or package it and install the `.vsix`.

## Where things are

| File | What it is |
| --- | --- |
| `extension.js` | The extension host: commands, the sidebar tree, git work (branches, worktrees, pull requests), timers, reminders, breaks. It holds your login; the webviews never see it. |
| `zoho.mjs` | Zoho People attendance: sign-in, status, punches, and the automatic rules as a pure function. Switched off for now: see `ATTENDANCE` in `extension.js`. |
| `pm.mjs` | The API client and every pure helper: durations, branch names, ticket health, streaks and badges, the lucky dip's weights. Shared by the extension, the webviews and the CLI. |
| `cli.mjs` | The `ajwain` command line. |
| `media/board.js`, `board.css` | The board tab: Today, Board, List, Sprints, My work, the ticket panel, the command palette, the slot machine. |
| `media/side.js`, `side.css` | The sidebar's Home view. |
| `media/break.js`, `break.css` | The stretch-break screen. |
| `media/icons.mjs` | Every icon and the mascot, as SVG drawn in code. |
| `media/sfx.mjs` | The slot machine's sounds, synthesized with WebAudio. |
| `skills/pm-tickets/` | The Claude Code skill. See [docs/SKILL.md](docs/SKILL.md). |
| `test/mock-api.mjs` | The demo server: an in-memory implementation of the API. See [docs/SERVER.md](docs/SERVER.md). |
| `dev/preview.html` | The board or the sidebar in a plain browser, with the demo server standing in for VS Code. |

## How the pieces talk

The board and the sidebar are webviews. They are plain JavaScript modules that build HTML strings and re-render on state changes; there is no framework.

A webview never calls the server itself. It asks the host:

```js
const issue = await host('req', '/api/issues/OG-12/');     // an API request, made by the host with your login
await host('startWork', issue);                            // or a host action
```

That goes out as `{id, method, args}` and comes back as `{id, result}` or `{id, error}`. The methods are `boardApi` and `sideApi` in `extension.js`. The host also pushes messages to both webviews when something changes elsewhere: `refresh`, `timer`, `scope`, `journal`, `intent`, `celebrate`.

Messages are JSON, so `undefined` arrives as `null`. Code that takes options from a webview has to accept `null`.

When you add a host method, add it to `dev/preview.html` too. That page plays the host for the browser tests, and it fails loudly on a method it doesn't know.

## The look

Flat and straight. These are the rules the stylesheets follow:

- No rounded corners, anywhere. No pills.
- Structure comes from hairline rules (`--rule`, `--rule-strong`), not boxes inside boxes.
- Orange (`--brand`) marks what is active, yours or running. Status colours come from the server.
- Small uppercase labels for structure; a monospace face for keys and numbers.
- Hatching for warnings (overdue, idle), not more colours.
- Surfaces come from the VS Code theme's variables, so light and dark themes both work. The slot machine is the one exception: it is always dark.

VS Code gives every webview a default stylesheet (it pads the body and rounds inline code). `board.css` resets what matters, and `dev/preview.html` includes a copy of those defaults so the browser shows what VS Code will.

## Tests

```bash
npm test
node --test test/ui-features.test.mjs       # one file
node --test --test-name-pattern="lucky" "test/*.test.mjs"
```

| File | What it covers |
| --- | --- |
| `pm.test.mjs` | The shared helpers, and the sound module against a stand-in audio engine. |
| `board.e2e.test.mjs`, `lead-board-features.test.mjs`, `ui-features.test.mjs` | The real board and sidebar in headless Chromium, driven with real key presses, with `dev/preview.html` as the host. |
| `host.e2e.test.mjs`, `lead-host-features.test.mjs` | The real `extension.js` against a stand-in `vscode` module (`vscode-stub.cjs`), with real git repositories in temporary folders. |
| `cli.e2e.test.mjs` | The CLI as a child process. |

All of them run against the demo server. Nothing reaches a real server:

- Temporary git repositories push to a local bare repository, and their `http.proxy` points nowhere, so a stray `git push` cannot leave the machine.
- `aws` and `claude` are replaced by small scripts that record how they were called.
- The board tests look for Playwright's Chromium, then a Chrome on your PATH. Set `CHROME=/path/to/chrome` to choose one. Without a browser they are skipped, not failed.

A change to what the user sees should come with a test that would have caught it being broken. Test through the stable hooks (`data-act`, `data-field`, `form[data-form]`), not through layout or class names that exist for styling.

## The preview page

`npm run dev`, then open `http://localhost:8765/dev/preview.html#view=board&project=OG`. It signs in as a sample user by itself. The part after `#` chooses what you see:

| Option | Effect |
| --- | --- |
| `view=today`, `board`, `list`, `sprints`, `mine` | The view. |
| `project=OG` | The project. Leave it out for all projects. |
| `open=OG-1730` | Open a ticket's panel. Add `plan` for its breakdown. |
| `standup` | Open the standup. |
| `since` | Pretend you last looked before a few tickets changed, to see the change flags. |
| `side` | The sidebar's Home view instead of the board. |
| `light` | A light theme. |

`window.__host` records what the page asked of the host (`calls`) and what went wrong (`errors`).

## Releasing

1. Bump `version` in `package.json`.
2. Add the changes to `CHANGELOG.md`, in words a user would recognise.
3. `npm test`, then `npm run package`.
4. Install the `.vsix` and reload VS Code to check it by hand: sign in, open the board, start a ticket.

Once the repository has a public address, add it as `repository` in `package.json`. Then `--allow-missing-repository` and `--no-rewrite-relative-links` can come out of the `package` script.
