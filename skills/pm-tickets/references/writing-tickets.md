# Writing, refining and breaking down tickets

## Contents
- [The rubric](#the-rubric) (what `ajwain quality` checks)
- [Templates](#templates)
- [Good and bad examples](#good-and-bad-examples)
- [From messy notes](#from-messy-notes-threads-emails-meetings)
- [Presenting a draft](#presenting-a-draft)
- [Attachments](#attachments)
- [Refining and triage](#refining-and-triage)
- [Breaking down](#breaking-down)

## The rubric

`ajwain quality <KEY>`, or `ajwain quality --title … --type … --estimate … --desc -` for a draft,
returns `{score, checks:[{id, ok, label, hint}]}`. Aim for 100. Every failing check needs a fix, or a
question to the user when only they know the answer.

| id | Applies to | Passes when |
|---|---|---|
| `title` | all | 10–90 characters, more than one word, no trailing `.` or `!` |
| `description` | all | at least 40 characters besides headings |
| `repro` | BUG | mentions steps to reproduce, expected and actual |
| `criteria` | STORY, TASK, SUBTASK | has a `- [ ]` checklist or an "Acceptance criteria" section |
| `why` | STORY | has `## Why`, or "As a … I want … so that …" |
| `estimate` | all but EPIC | estimate above 0 |
| `size` (warning) | all but EPIC | the estimate is over 2 days (16h). Break the ticket down. |

The checker can't judge quality, so check these yourself too:
- **The title is imperative and specific.** It starts with a verb (Add, Fix, Show, Remove, Migrate) and names the
  thing and where it happens. Avoid vague words like "issue", "improvements", "stuff" and "update".
- **Acceptance criteria are observable.** Each item can be checked by someone else without asking. Include the
  error or edge case that matters. Write 3–7 items. More than that usually means the ticket should be split.
- **The context names real things**, such as files, endpoints, screens, error messages, customers and links.
- **The estimate is honest.** Use 1d = 8h. When unsure, take the bigger number and say why.

## Templates

`ajwain template <TYPE>` prints these exact skeletons. Fill every section, and delete a section only
when it truly doesn't apply. You can add `## Notes` (links, constraints, out of scope) to any type.

BUG
```
## Steps to reproduce
1. 

## Expected

## Actual

## Environment
```

STORY
```
## Why
As a … I want … so that …

## What

## Acceptance criteria
- [ ] 
```

TASK
```
## Why

## What

## Acceptance criteria
- [ ] 
```

SUBTASK
```
## What

## Acceptance criteria
- [ ] 
```

EPIC
```
## Goal

## Scope

## Out of scope

## Success looks like
```

How to fill a BUG's Environment: production, staging or local; browser or OS and version; app version or
commit; and the account or tenant if it matters. Paste exact error text and log lines in fenced blocks.

## Good and bad examples

### BUG
Bad:
> **Login broken**
> users complaining login doesnt work on mac, pls fix asap

There are no steps, no expected or actual result, no environment and no estimate, and "asap" isn't a priority.

Good (type BUG, priority HIGH, estimate 3h):
> **Fix redirect loop after login on Safari 17**
> ```
> ## Steps to reproduce
> 1. Open https://app.example.com in Safari 17.4 (macOS 14) with no existing session
> 2. Sign in with a valid username and password
>
> ## Expected
> You land on the board.
>
> ## Actual
> The page bounces between /login and /board until Safari stops it ("Too many redirects").
> The refresh-token cookie is not stored (SameSite=None without Secure on staging).
>
> ## Environment
> Production and staging. Safari 17.4 only, while Chrome and Firefox work. Reported by 3 customers (see support thread).
>
> ## Acceptance criteria
> - [ ] Signing in on Safari 17 lands on the board
> - [ ] The refresh cookie is set with Secure and SameSite=None
> - [ ] Regression test for the cookie flags in auth/tests/test_cookies.py
> ```

### STORY
Bad:
> **Dashboard improvements**
> make the dashboard better for PMs

Good (type STORY, priority MEDIUM, estimate 1d):
> **Show the overdue ticket count on the project dashboard**
> ```
> ## Why
> As a project manager I want to see how many tickets are overdue when I open a project,
> so that I can chase them in standup without building a filter.
>
> ## What
> A tile on the project dashboard with the count of open tickets whose due date has passed.
> Clicking it opens the list view filtered to those tickets.
>
> ## Acceptance criteria
> - [ ] The tile shows the count of open tickets with due_date < today (project time zone)
> - [ ] Done tickets are never counted
> - [ ] Clicking the tile opens the list filtered to exactly those tickets
> - [ ] The tile shows 0, not a blank, when nothing is overdue
> ```

### TASK
Bad:
> **Refactor webhooks**

Good (type TASK, estimate 4h):
> **Add retry with backoff to webhook delivery**
> ```
> ## Why
> Deliveries fail permanently on any 5xx from the receiver. Two customers lost events last week.
>
> ## What
> In webhooks/deliver.py, retry 5xx and timeouts up to 5 times with exponential backoff (1m, 2m, 4m, 8m, 16m).
> Record each attempt in WebhookAttempt.
>
> ## Acceptance criteria
> - [ ] 5xx and timeouts are retried up to 5 times with the backoff above
> - [ ] 4xx responses are not retried
> - [ ] Every attempt is visible in the delivery log
> ```

### EPIC
> **Self-serve SSO for workspaces**
> ```
> ## Goal
> Workspace admins can turn on SAML SSO without contacting support.
>
> ## Scope
> SAML 2.0 setup screen, metadata upload, enforced SSO, audit log entries.
>
> ## Out of scope
> SCIM provisioning, OIDC.
>
> ## Success looks like
> Five or more workspaces enable SSO in the first month with no support tickets.
> ```
EPICs have no estimate. Their stories carry the estimates.

### SUBTASK
> **Store webhook attempts in WebhookAttempt** (parent OG-40, estimate 2h)
> ```
> ## What
> New model plus migration. deliver.py writes one row per attempt (status, duration, error).
>
> ## Acceptance criteria
> - [ ] Migration applies cleanly on a copy of production data
> - [ ] Each delivery attempt creates exactly one row
> ```

## From messy notes (threads, emails, meetings)

1. Ask for or collect the raw text. If it mentions this repo, read the code it points at.
2. Optionally get a first draft from the app's AI. The input is cut off at 4000 characters, so trim
   greetings, signatures and quoted replies first:
   ```bash
   ajwain draft OG - <<'EOF'
   <the pasted thread>
   EOF
   ```
   It prints `{title, description, issue_type, priority, tags}` and creates nothing. Treat it as a
   starting point. Fix the title, apply the template and add what you learned from the code. If the
   AI is busy or returns 400, write the draft yourself.
3. One set of notes often holds several tickets, such as a bug, a follow-up task and a question for
   someone. List them separately and ask which to create. Open questions aren't tickets: list them for
   the user to ask.
4. Leave out personal data (emails, phone numbers, customer secrets) that the ticket doesn't need.
5. `ajwain draft OG - --create` creates the AI draft as is. Use it only when the user has seen the
   printed draft and accepted it unchanged. Flags still override fields, e.g. `--type TASK --estimate 2h`.
   Otherwise, create the edited version with `ajwain create`.

## Presenting a draft

Show it as it will appear, then ask. For example:

```
Project OG · BUG · HIGH · estimate 3h · quality 100
Title: Fix redirect loop after login on Safari 17

## Steps to reproduce
…

Possible duplicate checked: none open (ajwain similar).
Create it?
```

For several tickets, show a numbered table (title, type, estimate) and then each description, and ask
which to create. Apply the user's edits and show the result again if anything changed materially.

## Attachments

- `ajwain attach OG-12 path/to/shot.png path/to/server.log` uploads each file and prints `[{id, name, size}]`.
  The limit is 20 MB per file, and every file is checked before any upload starts.
- `ajwain attachments OG-12` lists `[{id, name, size, url}]`. The URLs are temporary download links.
  Don't paste them into tickets or PRs.
- Before you attach a log, scan it for secrets (tokens, passwords, keys) and offer to redact them first.
- When the user pastes an image into the chat, there's no file on disk to upload. Ask for the path, for
  example `~/Pictures/Screenshot….png`.

## Refining and triage

1. Gather: `ajwain show OG-12` (fields, score, subtasks, attachment names, description),
   `ajwain quality OG-12` (what's missing), `ajwain comments OG-12`, or `ajwain summary OG-12`
   (`--fresh` to regenerate) when the thread is long. Read the code when it's this repo.
2. Diagnose: is it the wrong type, missing repro, unclear done, no estimate, too big (over 2 days), a
   duplicate (`ajwain similar`), or actually several tickets?
3. Propose a rewritten title and description in the type's template, plus field changes
   (type, priority, estimate, due date). Keep every fact, link, decision and attachment reference from the
   original and the comments. Say briefly what you changed and why.
4. After approval:
   ```bash
   ajwain update OG-12 --title "…" --type BUG --estimate 3h --desc - <<'EOF'
   …full new description…
   EOF
   ```
   `--desc` replaces the whole description, so always send the complete text.
5. If questions remain for the reporter, offer to post them: `ajwain comment OG-12 - <<'EOF' … EOF`.

For triage of many tickets (`ajwain mine`, or a list the user gives), give one line per ticket:
the key, the problem, and the proposed fix. Apply only the ones the user picks.

## Breaking down

When to do it: when the user asks, or when the estimate is over 2 days, or when the ticket has more
than about 7 acceptance criteria or spans unrelated areas.

1. `ajwain show OG-12`, and read the code it touches. Note any `children` that already exist so you
   don't duplicate them.
2. Propose:
   - **Plan:** the approach, the files or modules touched, the risks, and how it will be tested (a few lines).
   - **Children:** 2–8 of them, in order. Use STORY under an EPIC and SUBTASK under anything else.
     Each takes a day or less, can be reviewed on its own, and has a title, a description in the
     template (What plus acceptance criteria) and an estimate. Their sum should roughly match the
     parent's estimate. Say so if it doesn't.
3. Show a numbered table (title, type, estimate, one-line scope) and **wait for approval**. Apply
   the user's edits.
4. Create the children in order. They're assigned to the user unless you add `--no-assign`, so ask if
   it isn't obvious:
   ```bash
   ajwain create OG "Store webhook attempts in WebhookAttempt" --type SUBTASK --parent OG-12 --estimate 2h --desc - <<'EOF'
   ## What
   …
   ## Acceptance criteria
   - [ ] …
   EOF
   ```
5. If the user wants it, append the plan to the parent. Send the parent's existing description plus a
   `## Plan` section, because `--desc` replaces the description.
6. Offer to start the first child, or to start several in parallel with `--worktree` (see lifecycle.md).
