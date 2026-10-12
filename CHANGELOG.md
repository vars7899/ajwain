# Changelog

## 0.13.2 (2026-10-12)

- **Attendance is switched off for now.** Zoho People doesn't allow API access for our roles, so the timer, the Workday box, the pop-up and the attendance commands and settings are gone from this release. The code stays, ready for when access is allowed: see [docs/ATTENDANCE.md](docs/ATTENDANCE.md).

## 0.13.1 (2026-10-12)

- **Zoho People: reading your attendance asks for today, for you.** Ajwain now sends the date and your Zoho People email with the request. Before, it sent neither, and Zoho could answer only "Error occurred".
- **Zoho's errors say what's wrong.** Zoho wraps its reasons in a generic "Error occurred"; Ajwain now shows the reason, and writes Zoho's whole reply to **View → Output → Ajwain**.
- **After a failure, Zoho is left alone for 5 minutes,** as intended. Before, Ajwain tried again every 30 seconds.

## 0.13.0 (2026-10-12)

- **A pop-up to punch in when you open VS Code.** On a workday, when you open VS Code or come back to it and you haven't punched in, Ajwain says good morning and asks: **Punch in** or **Not today**. Once a day, and only while you're at VS Code.
- **Choose how you're punched in and out,** separately: asked in a pop-up, automatically at the time, or only by hand. Click the timer in the status bar and pick **Punch-in** or **Punch-out**, or set `ajwain.attendance.punchIn` (default `ask`) and `ajwain.attendance.punchOut` (default `auto`). These replace `ajwain.attendance.auto`.

## 0.12.0 (2026-10-12)

- **Attendance runs on a schedule:** in at 09:00, out at 18:00, on your workdays (`ajwain.attendance.in`, `.out`, `.days`). If VS Code starts later, you're punched in then, at the real time; the punch-out is timed 18:00 even if VS Code notices later that evening. Nothing watches your activity any more: being away never punches you out, and neither does Wind down.
- **A running timer:** `In 5:14:02` in the status bar, and a **Workday** box in the sidebar and on Today with your time, your day from 09:00 to 18:00 and a button to punch.
- **A punch-out you missed is asked about,** once: punch out at 18:00 that day, now, or leave it.
- **Claude Code can't punch for you.** The CLI has no attendance commands (they refuse with exit code 2), the skill forbids it, and a new guard hook, `skills/pm-tickets/attendance-guard.mjs`, blocks the workarounds. Install it from [docs/SKILL.md](docs/SKILL.md#the-attendance-guard).
- Removed: `ajwain.attendance.idleMinutes`, `.earliest` and `.outOnWindDown`, and the separate Punch in and Punch out commands. **Ajwain: Attendance (Zoho People)…** has both.

## 0.11.0 (2026-10-12)

- **Attendance with Zoho People.** Connect once (**Ajwain: Connect Zoho People**; a Self Client, no admin needed) and Ajwain punches you in on your first activity of the workday. It punches you out after an hour away, at the time of your last activity, or when you finish Wind down. The status bar shows In or Out, and clicking it punches by hand. A punch-out you make yourself sticks for the day; punches made on the Zoho app or a biometric device are respected. Set up and rules: [docs/ATTENDANCE.md](docs/ATTENDANCE.md).
- Window focus and terminal commands now count as activity, for attendance and for stretch breaks.

## 0.10.2 (2026-10-09)

- **The `ajwain` CLI is readable by default:** tables for lists, a page for a ticket (with its description, checklists and subtasks), one-line confirmations for changes, and colour in a terminal. **`--raw`** prints the JSON, for scripts and `jq`. The Claude skill uses `--raw`.

## 0.10.1 (2026-10-08)

- **New tickets appear at once.** A ticket you create shows straight away, at the top of its column or list, highlighted and marked New. Before, the board reloaded the whole project to show it (about 4 seconds on a project of 2,000 tickets) and it then sat at the bottom of the list.
- **If the view's filters hide a new ticket, you're told**, with a link to open it.
- **Changes made on the web app show up by themselves:** when you come back to VS Code, to the board or to the sidebar, and every two minutes while you're looking. Never while you're typing.
- **The sidebar updates** when you create or change a ticket on the board.
- **Faster on big projects:** pages of tickets load four at a time; tables draw 200 rows and board columns 100 cards at once, with **Show more** for the rest; table cells become dropdowns only when clicked. Redrawing a 1,900-ticket list went from about 1.8 seconds to about 0.13.

## 0.10.0 (2026-10-08)

**Ready to share.**

- **No server is built in any more.** Sign in asks for your server's address the first time, and **Ajwain: Change server…** changes it. `ajwain.appUrl` sets the web app's address for links; left empty, it's guessed from the API address. The CLI learns the address from `ajwain login --server`, or from VS Code once you've signed in there.
- **The extension's id changed** to `ajwain.ajwain`. If you have 0.9 or earlier installed, uninstall it first (Extensions → Ajwain → Uninstall): two copies would clash. You sign in again once.
- **A demo server** (`npm run dev`) with sample data, so you can try everything without a server of your own.
- **New docs:** the server and its API, the command line, the Claude Code skill, and a guide to working on the code.
- **The slot machine can't clip.** A soft limiter keeps every sound under full scale.
- The "since you were last here" snapshot keeps tickets touched in the last 30 days, not every ticket ever seen. On a large project this shrinks the board's saved state from hundreds of kilobytes to a few.
- MIT licence.

## 0.9.5 (2026-10-08)

- **Start work when the server wants an estimate first:** Ajwain asks for the estimate, saves it and carries on, before any branch is made. Cancelling changes nothing.
- Server errors read as sentences, not raw JSON.
- A move the server refuses snaps back, and the message links to the ticket.
- "My week" asks for the admin-only time report once per session, not every time.

## 0.9.4 (2026-10-07)

- **Lucky dip, full size:** big travelling bulbs, a lit sign, a WIN meter, sunbeams and chip rain.
- **A sound for every result:** ka-ching for a win, a bell and fanfare for a jackpot, a slide whistle for easy money, and poing, poing, poing with a sad trombone for a bug.

## 0.9.2 – 0.9.3 (2026-10-07)

- **A new sidebar:** your day in four numbers, the running timer, six tiles into the board, the sprint, and your open tickets with one-click actions.
- The README rewritten.

## 0.9.1 (2026-10-06)

- **My work:** Assigned to me, Reported by me, and Done in the last 14 days, with counts of what needs you and grouping by due date, status or priority.
- **Sort and columns:** sort everywhere by recently updated, newest, priority and more; choose table columns, including Created, Updated and Reporter.
- Today's header follows the time of day. The slot machine's lever swings.

## 0.9.0 (2026-10-06)

- **A flat redesign** of the whole board.
- **Command palette** (`Ctrl+K`), keyboard control of the board, swimlanes, quick add, and "since you were last here".
- **Workload** per person in Sprints, the sprint pulse, and the timeline of your day.
- Lucky dip becomes a slot machine.

## 0.8

- Help writing tickets: drafts from notes, duplicate detection, ticket health, AI summaries.
- Attachments: paste or drop screenshots, preview, download.
- Stretch breaks, focus sessions, wind down, your week wrapped, streaks and badges.

## Earlier

- The board, list, sprints and ticket panel; reminders; time from commits; breaking a ticket down with Claude; starting work on a branch or worktree; opening pull requests; the `ajwain` CLI and the Claude Code skill.
