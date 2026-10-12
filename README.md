# Ajwain

**Project management that lives in your editor.** Boards, sprints, tickets, timers and your whole working day, inside VS Code. Flat, fast, keyboard-first. And yes, there's a slot machine.

## Why you'll like it

- **No more tab-switching.** Create, move, estimate, comment and close tickets without opening a browser.
- **From ticket to pull request in clicks.** Start work makes the branch (or a worktree), the timer runs while you code, and Open PR pushes, opens the pull request and moves the ticket to review.
- **Your time fills itself in.** Ajwain reads your commits and suggests what to log, ticket by ticket.
- **Keyboard everything.** `Ctrl+K` jumps to any ticket, view or command. Arrow keys walk the board.
- **It knows what changed.** Come back after a day off and the board flags what moved, what's new and what changed hands.
- **Better tickets.** A live health check, duplicate detection and AI drafting while you write.
- **It looks after you.** Stretch breaks, focus sessions, a wind-down ritual and a weekly wrap-up.

## Try it in two minutes

You don't need a server to look around. The repository has a demo server with sample people, projects and tickets.

```bash
git clone https://github.com/vars7899/ajwain.git && cd ajwain
npm run package && code --install-extension ajwain-*.vsix    # build and install the extension
npm run dev                                                   # the demo server, on http://localhost:8765
```

In VS Code, click the **Ajwain** cone in the activity bar and choose **Sign in**:

- server: `http://localhost:8765`
- username: `sam`
- password: `secret`

Everything works against it, and it starts fresh each time you run it.

## Install

If you have the `.vsix` file:

```bash
code --install-extension ajwain-<version>.vsix
```

From the source (needs Node 20 or newer; the first run downloads the packaging tool):

```bash
git clone https://github.com/vars7899/ajwain.git
cd ajwain
npm run package
code --install-extension ajwain-*.vsix
```

To update later: `git pull`, then the last two commands again.

Then click the **Ajwain** cone in the activity bar and sign in. The first time, it asks for your server's address; after that, just your username and password.

**What you need**

- VS Code 1.90 or newer.
- A project management server that speaks Ajwain's API, and an account on it. [docs/SERVER.md](docs/SERVER.md) describes the API and the demo server.
- `git`, for Start work, Open PR and time from commits.
- Optional: the `claude` CLI (Claude drafts breakdowns and implements tickets), and the `aws` CLI or `gh` for opening pull requests on AWS CodeCommit or GitHub without leaving the editor.

Upgrading from 0.9 or earlier? Uninstall the old copy first; see the [changelog](CHANGELOG.md).

## More to read

| | |
| --- | --- |
| [docs/SERVER.md](docs/SERVER.md) | Pointing Ajwain at a server, the demo server, and the API a server has to offer. |
| [docs/ATTENDANCE.md](docs/ATTENDANCE.md) | Punching in and out of Zoho People. Switched off for now: Zoho doesn't allow API access for our roles. |
| [docs/CLI.md](docs/CLI.md) | The `ajwain` command line. |
| [docs/SKILL.md](docs/SKILL.md) | The Claude Code skill: what to ask, how it behaves, how to adapt it. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Working on the code: layout, tests, the preview page, releasing. |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version. |

## The tour

### Today: your day on one screen

A greeting that follows the time of day, today's numbers, and **Your day**: a timeline of your commits, the stretches you were in flow, focus sessions and breaks. Below it, **Log today's time** suggests durations from the gaps between your commits (edit, then log them all in one click), **Untracked work** turns branches without a ticket into tickets, and **In progress** and **Up next** line up your queue.

### The board

- **Drag cards** between statuses. **Quick add** at the foot of a column creates a ticket from just a title.
- **Swimlanes** group the board by assignee, priority, type or parent. Drop a card into someone's lane and it's theirs.
- **Cards tell you things:** a red or orange edge for urgent work, a bar showing time logged against the estimate, a hatched "9d idle" tag on tickets nobody has touched, and timer and start buttons when you hover.
- **Since you were last here** flags what moved, what's new, what was reassigned and what was edited since your last visit. Your own changes don't count.
- **The sprint pulse** shows one segment per sprint day, the days left and how much is done.
- **It stays current.** A ticket you create appears at once, at the top and highlighted. Changes made on the web app show up by themselves when you come back to VS Code or to the board, and every couple of minutes while you're looking (never while you're typing).
- **Big projects stay quick.** Tables draw 200 rows and board columns 100 cards at a time, with **Show more** for the rest; sorting, filters and search always cover every ticket. Table cells become dropdowns when you click them.

### Every ticket, one panel

Every field is editable in place. The **Plan · Start · Build · Track · Ship · Done** line is the development cycle, and each station is one click. The panel also has ticket health, an AI summary, time logged, a Markdown description with an **Improve** button, attachments (drop or paste screenshots), subtasks and comments.

### Command palette

`Ctrl+K` (`⌘K` on a Mac) from anywhere on the board. Type a ticket key, a number or a few words from a title to jump to it, or run any command: switch view or project, sort, lanes, standup, lucky dip and more. `Shift+Enter` on a ticket starts work on it.

### My work

- **Three tabs:** Assigned to me, Reported by me (still open, so you can chase it), and Done, last 14 days.
- **The strip on top** counts what needs you: overdue, due in 7 days, idle 7+ days, over estimate, no estimate. Click a count to see just those tickets.
- **Group** by project, due date, status or priority.
- **Sort** by recently updated, newest, oldest, priority, due date and more. **Columns** picks what the tables show, including Created, Updated and Reporter.

### Sprints

The active and planned sprints and the backlog. Drag rows between them to plan. **Workload** shows each person's remaining estimate against the working days left, and flags who has more than fits.

### The sidebar

The Ajwain cone opens **Home**:

- your day in four numbers;
- the running timer;
- six tiles into the board;
- the sprint;
- your open tickets, most urgent first.

Hover a ticket to start a timer, start work, or open its full action menu. `/` filters the list. The dock at the bottom creates a ticket, writes your standup, starts a focus session, winds down the day, or opens the command palette.

### Lucky dip

Can't decide what's next? Pull the lever.

- **A full-size slot machine:** big travelling bulbs, a lit sign, three reels (type, priority, ticket), a lever that swings, an LED ticker and a WIN meter that counts up.
- **The pick is fair:** it's weighted by priority and due date, and the **Odds** meter shows its real chance.
- **Every result has its own show and sound:**
  - **Jackpot** (urgent or overdue): the bell that won't stop, a fanfare, ka-ching ka-ching ka-ching, sunbeams and a rain of chips.
  - **Big win** (high priority or due soon): a fanfare and three ka-chings.
  - **Easy money** (small or low priority): a slide whistle and a light chime.
  - **Nice pick:** one clean ka-ching.
  - **A bug:** the lights dim, bugs drift down, and you get poing, poing, poing and a sad trombone.
- **Hold** a reel to keep it for the next spin, for example "only bugs". `Space` pulls the lever again.
- With an empty queue, it deals the sprint's unassigned work.
- Sound is on; the speaker button in the machine mutes it, and it stays muted.

### Light themes too

Everything follows your VS Code theme, light or dark.

## The workflow, start to finish

1. **Morning.** A reminder opens **Write standup**: yesterday's commits grouped by ticket plus today's plan, ready to paste.
2. **Plan.** **Break down** splits a ticket into subtasks. Claude can draft them from your codebase, and nothing is created until you approve.
3. **Start.** This assigns the ticket to you, moves it to In Progress, creates the branch (or a worktree for parallel work) and starts the timer. If your workspace wants an estimate before a ticket can start, Ajwain asks for one first.
4. **Build.** Code yourself, or **Implement with Claude** in the ticket's own checkout, with the ticket as the brief.
5. **Code.** On a ticket branch:
   - the commit box is pre-filled with the ticket key;
   - ticket keys in code become links with a hover card;
   - a `TODO` or `FIXME` turns into a ticket from the lightbulb;
   - after each commit, Ajwain offers to log time, update the status or comment.
6. **Ship.** **Open PR** pushes the branch and opens the pull request. It works with AWS CodeCommit, GitHub, GitLab and Bitbucket. The ticket moves to review and gets the PR link.
7. **Done.** **Finish** logs the timer, sets the final status and cleans up: the worktree, or the merged branch.
8. **Evening.** **Wind down**: log what's left, note where you stopped, and pick tomorrow's first ticket. It's waiting for you in the morning.

## Writing better tickets

- **Draft from notes:** paste a chat thread, an email or meeting notes, and the AI fills in the title, description, type, priority and tags.
- **Similar open tickets** appear as you type the title, so duplicates get caught early.
- **Ticket health** is a live checklist that needs no AI: a specific title, context, acceptance criteria (steps to reproduce for bugs), an estimate, and a nudge to split anything big. **Add missing sections** fills in the gaps.
- **Improve** rewrites a description, and you see it before anything changes. **AI summary** condenses a long ticket.
- **Ask** filters the board in plain words: "my open bugs this sprint".

The AI features use your project management server's own AI and appear when it's enabled for your account.

## Wellbeing and fun

- **Stretch breaks:** after 50 minutes of continuous activity, the mascot leads a routine of about 75 seconds: reach, lean, two more moves, breathe. If you use jj-stretch, it takes over the automatic breaks.
- **Eye break:** run **Ajwain: Take an eye break (20-20-20)** to look far away for 20 seconds. This one is on demand, not automatic.
- **Focus 25:** a Pomodoro with a countdown in the status bar, then a stretch.
- **Your week, wrapped:** commits, tickets, PRs, hours, a commit heatmap and a title for your week. Save it as an image or copy it as text.
- **Streaks and 13 badges**, confetti when you ship, and a mascot whose mood follows your day.

## Keyboard

| Keys | What it does |
| --- | --- |
| `Ctrl+K` / `⌘K` | Command palette |
| `1` – `5` | Today, Board, List, Sprints, My work |
| `← ↑ → ↓` | Walk the board |
| `Shift+← / →` | Move the focused card to the previous or next status |
| `C` | New ticket |
| `/` | Filter |
| `Space` | Spin again (Lucky dip) |
| `Ctrl+Enter` | Create, comment, save |
| `?` | All shortcuts |

## Settings

Search "Ajwain" in VS Code settings. The ones worth knowing:

| Setting | What it does |
| --- | --- |
| `ajwain.startWorkIn` | `ask`, `branch` or `worktree` |
| `ajwain.branchTemplate` | branch names, e.g. `{key}-{slug}` |
| `ajwain.reminders.schedule` | standup, end-of-day and wind-down reminders |
| `ajwain.timer.autoStart` | start a timer when you start work |
| `ajwain.reviewStatus` | where a ticket goes when its PR opens |
| `ajwain.breaks.mode` | when stretch breaks are suggested |
| `ajwain.apiUrl` | your server's address; **Ajwain: Change server…** sets it |
| `ajwain.appUrl` | the web app's address, for "Open in browser", if it can't be guessed |

**Board empty?** Check the workspace and project at the top left, and the Sprint filter (it starts on the active sprint). **Something wrong?** **View → Output → Ajwain** logs every request and error.

## CLI and Claude

- **`ajwain`** does the same operations from a terminal, with readable tables and pages (`--raw` for JSON): `ajwain mine`, `ajwain show OG-12`, `ajwain start OG-12 --worktree`, `ajwain log OG-12 1h30m`. Run `npm link` in this repository to get it. Details are in [docs/CLI.md](docs/CLI.md).
- **The Claude Code skill** builds on it. Ask Claude to "break down OG-12", "write a bug ticket from this thread" or "start OG-12 in a worktree", and it confirms before it changes anything. Setup and examples are in [docs/SKILL.md](docs/SKILL.md).

## Development

No build step and no dependencies: `extension.js` is the host, `media/` holds the board and sidebar, and `pm.mjs` is the shared API client.

```bash
npm test          # the full suite, no network (Node 22+, and Chrome or Chromium for the board tests)
npm run dev       # the demo server, and the board in a browser
npm run package   # builds the .vsix
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the code map, the design rules and how the tests work.

## Licence

MIT. See [LICENSE](LICENSE).
