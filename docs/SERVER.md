# The server Ajwain talks to

Ajwain is a client. Tickets, sprints, people and time all live on a project management server, and Ajwain reads and writes them over a REST API. No server address is built in: you tell Ajwain where yours is.

This page covers three things: how to point Ajwain at a server, how to try it with the demo server in this repository, and the API a server has to offer.

## Pointing Ajwain at a server

**In VS Code:** run **Ajwain: Sign in**. The first time, it asks for the server's API address, then your username and password. **Ajwain: Change server…** changes it later, and signs you out of the old one.

| Setting | What it is |
| --- | --- |
| `ajwain.apiUrl` | The API's address, e.g. `https://pm-api.example.com`. |
| `ajwain.appUrl` | The web app's address, used for **Open in browser** and for ticket links in pull requests. If you leave it empty, Ajwain guesses it from the API address by turning `api` into `app` (`pm-api.example.com` becomes `pm-app.example.com`). If the API's host has no `api` in it, set this yourself, or those links are left out. |

**In the CLI:** `ajwain login --server https://pm-api.example.com`. If the VS Code extension is already signed in on the same machine, the CLI picks the address up from it and plain `ajwain login` is enough. See [CLI.md](CLI.md).

Your login is a token pair. The extension keeps it in VS Code's secret storage; the CLI keeps it in `~/.config/ajwain/tokens.json`, readable only by you. Passwords are never stored.

## Trying it without a server

The repository includes a small demo server with sample people, projects, sprints and tickets. Everything is in memory, so it starts fresh each time.

```bash
npm run dev        # http://localhost:8765
```

Sign in from VS Code with the server `http://localhost:8765`, the username `sam` and the password `secret`. The other sample users are `ana`, `kai` and `nia`, with the same password.

The demo server also serves the board on its own, without VS Code, at `http://localhost:8765/dev/preview.html#view=board&project=OG`. That page is described in [CONTRIBUTING.md](../CONTRIBUTING.md).

The demo server is `test/mock-api.mjs`. The test suite runs against it, so it is also the most precise description of the API below: if this page and that file ever disagree, the file is right.

## The API

JSON over HTTPS. Every response is wrapped in an envelope:

```json
{ "success": true, "data": { } }
{ "success": false, "message": "Invalid input.", "errors": { "title": ["This field may not be blank."] } }
```

Ajwain shows field errors to the user as sentences, so write them to be read by a person.

**Authentication** is a bearer token. `POST /auth/token/` with `{username, password}` returns `{access, refresh}`. Requests carry `Authorization: Bearer <access>`. On a 401, Ajwain calls `POST /auth/token/refresh/` with `{refresh}` once, and retries with the new `access`. If that fails, the user is signed out.

**Ids** may be numbers or UUIDs. **Lists** may be plain arrays or pages (`{count, next, results}`); the issue list is always paged, with `page` and `page_size`.

### Endpoints

| Method and path | Used for |
| --- | --- |
| `POST /auth/token/`, `POST /auth/token/refresh/` | Signing in and staying signed in. |
| `GET /auth/me/` | Who you are: `{id, username, first_name, last_name, ai_enabled}`. |
| `GET /api/workspaces/` | The workspace picker: `[{id, name}]`. |
| `GET /api/projects/?workspace=` | Projects: `{id, workspace, key, name, issue_count}`. |
| `GET /api/projects/{id}/statuses/` | A project's statuses, in board order: `{id, name, category, color}`. |
| `GET /api/sprints/?project=` | Sprints: `{id, name, state, start_date, end_date}`. |
| `GET /api/members/` | People: `{workspace, user: {id, username, first_name, last_name, is_active}}`. |
| `GET /api/tags/?workspace=` | Tags: `{id, title, color}`. |
| `GET /api/issues/` | Tickets, with the filters below. |
| `POST /api/issues/` | Create a ticket. |
| `GET /api/issues/{id or key}/` | One ticket, with `children` and `attachments`. |
| `PATCH /api/issues/{id}/` | Change any fields of a ticket. |
| `GET /api/comments/?issue=`, `POST /api/comments/` | A ticket's discussion: `{id, issue, author, body, created_at}`. |
| `GET /api/worklogs/?issue=`, `POST /api/worklogs/` | Time logged: `{id, issue, user, minutes, logged_on, note}`. |
| `POST /api/attachments/presign/`, `POST /api/attachments/`, `GET /api/attachments/{id}/url/`, `DELETE /api/attachments/{id}/` | Attachments. |
| `GET /api/issues/similar/?project=&q=` | Possible duplicates while you type a title: `[{key, title, status, category}]`. |
| `POST /api/issues/draft/` | AI: notes in, a ticket draft out. |
| `GET /api/issues/{id}/summary/` | AI: a summary of a ticket and its discussion. |
| `POST /api/projects/{id}/filter-from-text/` | AI: "my open bugs this sprint" in, board filters out. |
| `GET /api/activity/users/{id}/standup/` | AI: a standup written from your activity. |
| `GET /api/reports/people/` | Time logged per person, for "My week". |

### A ticket

```json
{
  "id": "…", "project": "…", "number": 1730, "key": "OG-1730",
  "issue_type": "TASK", "priority": "HIGH", "title": "Add retry with backoff to webhook delivery",
  "description": "## Why\n…",
  "status": "…", "status_detail": { "id": "…", "name": "In Progress", "category": "IN_PROGRESS", "color": "amber" },
  "sprint": "…", "sprint_detail": { "id": "…", "name": "Sprint 14", "state": "ACTIVE" },
  "parent": null, "parent_key": null,
  "reporter": "…", "assignee": "…", "tags": ["…"],
  "estimate_minutes": 240, "logged_minutes": 120,
  "start_date": null, "due_date": "2026-10-09", "resolved_at": null,
  "attachment_count": 0, "created_at": "…", "updated_at": "…"
}
```

- `issue_type` is one of `EPIC`, `STORY`, `TASK`, `BUG`, `SUBTASK`.
- `priority` is one of `HIGHEST`, `HIGH`, `MEDIUM`, `LOW`, `LOWEST`.
- A status `category` is `TODO`, `IN_PROGRESS` or `DONE`. Ajwain uses the category, not the name, to know what "in progress" and "done" mean, so a project can name and order its statuses freely.
- A sprint `state` is `ACTIVE`, `PLANNED` or `CLOSED`.
- `updated_at` and `created_at` drive sorting, the "idle" tag and "since you were last here".
- The single-ticket response adds `children` (tickets whose `parent` is this one) and `attachments` (`{id, name, size, content_type}`).

### Filters on `GET /api/issues/`

`project`, `workspace`, `assignee`, `reporter`, `type`, `priority`, `sprint`, `tags` (each can repeat), `open=true` (not done), `planning=true` (not in a closed sprint), `ordering` (a field name, `-` in front for descending). `assignee=none`, `sprint=none` and `tags=none` mean "has none".

### Attachments

Uploads go straight to storage, in three steps:

1. `POST /api/attachments/presign/` with `{target_type: "issues.issue", target_id, name, size, content_type}` returns `{key, url}`.
2. Ajwain `PUT`s the file's bytes to `url`.
3. `POST /api/attachments/` with `{target_type, target_id, key, name}` records it.

`GET /api/attachments/{id}/url/` returns a short-lived `{url}` to show or download the file. In a description, `![name](attachment:<id>)` is an image stored this way. Ajwain refuses files over 20 MB before uploading.

### What a server can leave out

- **The AI endpoints.** Ajwain shows AI features only when `/auth/me/` says `ai_enabled: true`. A 429 from one of them means "busy, try again"; a 400 means there was nothing to work with. The duplicate check (`similar`) is shown whenever it answers.
- **The people report.** If it is refused (it is often admin-only), "My week" uses what Ajwain recorded itself.
- **Attachments, tags, sprints.** Each part of the board that needs them stays empty without them.

### Rules a server may enforce

A server can reject a change with a field error, and Ajwain shows the message. One rule gets special handling: if starting a ticket is refused with an error on `estimate_minutes` (a workspace that wants an estimate before work starts), Ajwain asks for the estimate, saves it, and starts the ticket.
