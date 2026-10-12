# The `ajwain` command line

The same operations as the extension, from a terminal: read, create and update tickets, log time, start work on a branch, write a standup. It is what the [Claude Code skill](SKILL.md) uses, and it works on its own in scripts (with `--raw` for JSON).

## Set up

It needs Node 20 or newer and has no dependencies.

```bash
npm link                                            # in this repository: puts `ajwain` on your PATH
ajwain login --server https://pm-api.example.com    # asks for your username and password
```

`--server` is needed once. If the VS Code extension is signed in on the same machine, the CLI already knows the address and plain `ajwain login` is enough.

To try it against the demo server: `npm run dev`, then `ajwain login sam --server http://localhost:8765` with the password `secret`.

## Everyday use

```bash
ajwain mine                                  # my open tickets in the project chosen in VS Code
ajwain mine --all                            # ...in every project
ajwain show OG-12                            # one ticket: fields, health score, description, subtasks
ajwain create OG "Retry failed webhook deliveries" --type TASK --estimate 3h
ajwain update OG-12 --priority HIGH --due 2026-10-20
ajwain status OG-12 "In review"              # a status name, or a category: TODO, IN_PROGRESS, DONE
ajwain log OG-12 1h30m "retry scheduler"     # durations: 45m, 2h, 1h30m, 1.5h, 1d (8 hours)
ajwain comment OG-12 "Deployed to staging"
ajwain start OG-12                           # assign me, In Progress, and switch to the ticket's branch
ajwain start OG-12 --worktree                # ...in a separate checkout at ../<repo>-OG-12 instead
ajwain standup                               # a standup, ready to paste
```

Long text comes from standard input when you pass `-`:

```bash
ajwain update OG-12 --desc - <<'EOF'
## Why
Deliveries fail silently when the receiver restarts.

## Acceptance criteria
- [ ] Retries three times with backoff
EOF
```

## All commands

| Command | What it does |
| --- | --- |
| `login [username] [--server URL]` | Sign in. `--server` sets where the API is. |
| `logout`, `me`, `workspaces`, `projects` | Your session and what you can see. |
| `scope` | The workspace and project chosen in VS Code. `mine`, `create` and `draft` default to that project. |
| `statuses <PROJECT>` | A project's status names and categories. |
| `mine [--all]` | Your open tickets. |
| `show <KEY>` | One ticket. |
| `comments <KEY>`, `attachments <KEY>` | Its discussion; its files, with download links. |
| `summary <KEY> [--fresh]` | An AI summary of the ticket and its discussion. |
| `similar <PROJECT> <text>` | Open tickets like this text. Check before creating a duplicate. |
| `template <TYPE>` | The description skeleton for a ticket type. |
| `quality <KEY>` or `quality [fields]` | Ticket health: a score and what's missing, for a ticket or a draft. |
| `draft <PROJECT> <text>` | AI: turn notes, a thread or an email into a ticket draft. `--create` also creates it. |
| `create <PROJECT> <title> [fields] [--no-assign]` | Create a ticket: a task, medium priority, assigned to you, unless you say otherwise. |
| `update <KEY> [fields]` | Change fields. Only the ones you pass change. |
| `status <KEY> <status>` | Move a ticket. |
| `log <KEY> <duration> [note]` | Log time for today. |
| `comment <KEY> <text>` | Add a comment. |
| `attach <KEY> <file...>` | Upload files, up to 20 MB each. |
| `branch <KEY>` | Print the branch name `start` would use. |
| `start <KEY> [--worktree]` | Assign the ticket to you, move it to In Progress, and create or check out its branch. |
| `standup [--fresh]` | Your standup as text. |

**Fields:** `--title`, `--type EPIC|STORY|TASK|BUG|SUBTASK`, `--priority HIGHEST|HIGH|MEDIUM|LOW|LOWEST`, `--estimate 3h`, `--due YYYY-MM-DD`, `--parent KEY`, `--status NAME`, `--desc TEXT`.

**No attendance, on purpose.** Punching in and out of Zoho People is only in VS Code, where a person clicks it, so that no script or AI assistant can do it. `ajwain punch`, `ajwain attendance` and the like refuse with exit code 2. See [ATTENDANCE.md](ATTENDANCE.md#claude-cant-punch-for-you).

## Output and errors

Output is laid out for people: tables for lists, a page for a ticket, a one-line confirmation for changes. In a terminal it's in colour: overdue dates in red, high priorities in orange. `NO_COLOR=1` turns the colour off, and piping to a file or another program leaves it out.

```
$ ajwain mine
KEY      TYPE   STATUS        PRIORITY  TIME     DUE     TITLE
OG-1730  Task   In Progress   ↑ High    2h/4h    Oct 11  Add retry with backoff to webhook delivery
OG-1732  Story  To be Tested  = Medium  1h/8h    Oct 8   Dashboard: show sprint burndown chart

2 open tickets in the project chosen in VS Code · --all for every project
```

**`--raw`** prints JSON instead, for scripts and `jq`: `ajwain mine --raw | jq -r '.[].key'`. Three commands print plain text either way: `template`, `standup` and `branch`.

Errors go to standard error as `ajwain <command>: <message>`, with exit code 1. The ones you will meet:

| Message | What to do |
| --- | --- |
| `No server address set` | `ajwain login --server https://…`, or sign in once from VS Code. |
| `… (run: ajwain login)` | Your session expired. Sign in again. |
| `add an estimate first` | The workspace wants an estimate before a ticket starts: `ajwain update KEY --estimate 2h`, then `start` again. Nothing was changed. |
| `The AI assistant is busy` | Try again in a minute. |

## Settings

The CLI reads environment variables, not VS Code settings.

| Variable | What it sets |
| --- | --- |
| `AJWAIN_API` | The server's API address, instead of the saved one. |
| `AJWAIN_APP` | The web app's address, for the `url` of a ticket. By default it is guessed from the API address (`api` becomes `app`). |
| `AJWAIN_WORKSPACE` | A workspace id, instead of the one chosen in VS Code or your first. |
| `AJWAIN_BRANCH_TEMPLATE` | Branch names for `start` and `branch`, e.g. `{key}-{slug}`. The default is `{type}/{key}-{slug}`. |
| `AJWAIN_PASSWORD` | The password for `login`, for scripts. Prefer the prompt. |

It keeps three small files in `~/.config/ajwain/` (or `$XDG_CONFIG_HOME/ajwain/`):

- `tokens.json`: your login tokens, readable only by you. No password is stored.
- `server.json`: the server's address. `login --server` writes it, and so does the VS Code extension when you sign in there.
- `scope.json`: the workspace and project chosen in VS Code, written by the extension.
