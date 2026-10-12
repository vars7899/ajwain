# ajwain CLI reference

Run every command with `--raw`: it prints JSON, as described below. Without `--raw` the output is laid
out for people (tables, colour). `template` and `standup` (plain text) and `branch` (a string) are the same
either way. The examples below leave `--raw` out to stay short; add it.
Errors go to stderr with exit code 1, as `ajwain <cmd>: <message>`. A message ending in
`(run: ajwain login)` means the session expired: ask the user to run `! ajwain login`.

## Session and scope

| Command | Output |
|---|---|
| `ajwain login [username] [--server URL]` | `{signed_in}`. **The user runs it** (`! ajwain login`). It prompts for the password. `--server` is needed once, to say where the API is, unless the VS Code extension is already signed in. |
| `ajwain logout` | `{signed_out: true}` |
| `ajwain me` | the user record (`id`, `username`, `ai_enabled`, …) |
| `ajwain workspaces` | the workspaces |
| `ajwain projects` | `[{key, name, id}]` in the current workspace |
| `ajwain scope` | `{workspace, project, key?, name?}`: the workspace and project picked in VS Code. `key` and `name` are present when a project is set. |
| `ajwain statuses OG` | `[{name, category}]`, where the category is TODO, IN_PROGRESS or DONE |

`AJWAIN_WORKSPACE=<id>` overrides the workspace. Otherwise the CLI uses the scope, then the first workspace.

## Reading

| Command | Output |
|---|---|
| `ajwain mine` | `[brief]` of my open tickets in the scoped project. `--all` covers every project. |
| `ajwain show OG-12` | `brief` plus `score`, `branch`, `description`, and `children` `[{key, title, status}]` and `attachments` `[name]` when there are any |
| `ajwain comments OG-12` | `[{author, body, created_at}]` |
| `ajwain summary OG-12 [--fresh]` | `{key, text, generated_at}`, the app's AI summary of the ticket and its discussion |
| `ajwain attachments OG-12` | `[{id, name, size, url}]`. The `url` is a temporary download link. |
| `ajwain similar OG "safari login redirect"` | `[{key, title, status}]` of open tickets like the text. `-` reads the text from stdin. |
| `ajwain quality OG-12` | `{key, score, checks:[{id, ok, warn?, label, hint}]}` |
| `ajwain branch OG-12` | the branch name `start` would use |

A `brief` is `{key, title, type, priority, status, estimate, logged, due, url}`.

## Drafting

| Command | Output |
|---|---|
| `ajwain template BUG` | the description skeleton for EPIC, STORY, TASK, BUG or SUBTASK |
| `ajwain quality --title "…" --type BUG --estimate 3h --desc -` | `{score, checks}` for a draft (nothing is saved) |
| `ajwain draft OG -` (notes on stdin) | `{title, description, issue_type, priority, tags}`, an AI draft. Nothing is created. The input is cut off at 4000 characters. |
| `ajwain draft OG - --create [--type --priority --estimate --title]` | creates the draft (assigned to me, in the project's first status, with the flags taking precedence) and prints a `brief` |

## Writing (confirm the content with the user first)

| Command | Notes |
|---|---|
| `ajwain create OG "<title>" [fields] [--no-assign]` | Defaults: TASK, MEDIUM, the first status, assigned to me. Prints a `brief`. |
| `ajwain update OG-12 [fields]` | Only the fields you pass change. `--desc` replaces the whole description. |
| `ajwain status OG-12 "To be Tested"` | Takes a status name or a category (`DONE`, `IN_PROGRESS`). An unknown name lists the options. |
| `ajwain comment OG-12 -` | the comment body on stdin |
| `ajwain log OG-12 1h30m "note"` | logs for today. Durations: `45m`, `2h`, `1h30m`, `1.5h`, `1d` (= 8h). |
| `ajwain attach OG-12 a.png b.log` | `[{id, name, size}]`. The limit is 20 MB per file, checked before any upload. |
| `ajwain start OG-12 [--worktree]` | `{branch, path, key, status}`. Creates or checks out the branch (or a worktree at `../<repo>-OG-12`), assigns me, and moves the ticket to In Progress. |

**Fields:** `--title`, `--type EPIC|STORY|TASK|BUG|SUBTASK`, `--priority HIGHEST|HIGH|MEDIUM|LOW|LOWEST`,
`--estimate 3h`, `--due YYYY-MM-DD` (empty clears it), `--parent OG-12`, `--status "<name>"`, `--desc TEXT`
(`--desc -` reads stdin).

**Env:** `AJWAIN_BRANCH_TEMPLATE` (the team uses `{key}-{slug}`), `AJWAIN_WORKSPACE`. Never set
`AJWAIN_PASSWORD`. It exists only for scripted tests.

## Stdin pattern

```bash
ajwain create OG "Add retry with backoff to webhook delivery" --type TASK --estimate 4h --desc - <<'EOF'
## Why
…
EOF
```
Quote the delimiter (`'EOF'`), so `$`, backticks and `!` in the text reach the ticket unchanged.

## AI commands

`draft`, `summary` and `standup` use the app's server-side AI. When `me.ai_enabled` is false or the AI
fails, they behave like this:
- **"The AI assistant is busy, try again in a minute"** (429): retry once later, or do the job yourself.
- **400:** there was nothing to work with, such as empty notes or no activity. Give it more input, or do the job yourself.
- **`standup`** never fails for these reasons. It falls back to my open tickets grouped In progress / Up next.

## Not in the CLI

Attendance (Zoho People punch in and out) is not in the CLI on purpose, and `ajwain punch …` and the like
refuse with exit code 2. Never work around that: it is for the user, in VS Code (see the ground rules in SKILL.md).

If the user needs one of these, use the web app (`ajwain show OG-12` prints the ticket's `url`), or the VS Code
extension's board:
- deleting tickets
- changing the assignee to someone else
- sprints
- logging time on a past date
- listing today's worklogs
