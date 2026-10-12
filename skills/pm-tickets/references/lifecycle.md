# Ticket lifecycle: start, build, ship, finish, daily

## Contents
- [Start](#start)
- [Build and commit](#build-and-commit)
- [Log time](#log-time)
- [Ship: open a pull request](#ship-open-a-pull-request)
- [Finish](#finish)
- [Parallel work](#parallel-work)
- [Daily: standup and wrap-up](#daily-standup-and-wrap-up)

## Start

```bash
git fetch origin                         # so the branch starts from the latest default branch
AJWAIN_BRANCH_TEMPLATE='{key}-{slug}' ajwain start OG-12              # this checkout
AJWAIN_BRANCH_TEMPLATE='{key}-{slug}' ajwain start OG-12 --worktree   # new checkout at ../<repo>-OG-12
```

`start` prints `{branch, path, key, status}`. It does four things, the ticket first:
- It assigns the ticket to the user.
- It moves the ticket to the project's first In Progress status.
- It creates the branch from `origin/HEAD`, or checks it out if it already exists.
- With `--worktree`, it adds a sibling checkout instead of switching this one.

**If `start` fails with "add an estimate first":** the workspace doesn't let a ticket start without an
estimate, and nothing has been changed yet (no branch either). Ask the user for an estimate, set it
with `ajwain update OG-12 --estimate 3h`, then run `start` again.

**Branch names** come from `AJWAIN_BRANCH_TEMPLATE`, with the tokens `{key}`, `{slug}` (the title, at
most 40 characters) and `{type}` (`fix` for bugs, `feat` otherwise). The CLI reads only the environment
variable, not the VS Code setting. `{key}-{slug}` gives `OG-12-fix-redirect-loop-after-login-on-safari`. Follow the
names existing branches in the repo use (`git branch -r | head`): match their pattern.
If `echo $AJWAIN_BRANCH_TEMPLATE` prints nothing, prefix the command as shown above. Without it, the
default is `feat/OG-12-…`. `ajwain branch OG-12` prints the name without creating anything.

Before you start:
- Run `git status --porcelain`. If there are uncommitted changes, ask whether to commit them, stash
  them, or use `--worktree`, which leaves this checkout untouched.
- If `origin/HEAD` is missing, the branch would start from the current commit. Run
  `git remote set-head origin -a` first.
- Starting changes the assignee and status. When the user asked to start, that's the confirmation.
  If the ticket is assigned to someone else, ask first.

## Build and commit

- Read the ticket (`ajwain show OG-12`) and treat its acceptance criteria as the definition of done.
- Commit only when the user asks. Every message starts with the key:
  `OG-12: Add Secure flag to refresh cookie`. Use one ticket per commit. Follow the repo's existing
  style for the rest of the message (`git log --oneline -10`).
- When the work reveals something new (a bug, a follow-up, a scope change), offer to create a ticket or
  comment on this one. Don't just mention it in passing.

## Log time

```bash
ajwain log OG-12 1h30m "Cookie flags and regression test"
```
- Durations look like `45m`, `2h`, `1h30m`, `1.5h` or `1d` (1d = 8h). The time is logged for today.
  The CLI can't log a past date, so send the user to the board for that.
- Never log without the user's yes to the exact amount for each ticket. Suggest a number with your
  reasoning, for example "commits from 10:05 to 11:40, so about 1h30m", and let them change it.
- At the end of a work session, or right after a PR, offer to log time once. Don't nag.

## Ship: open a pull request

Do this only when the user asks to open a PR, ship, or send for review.

1. **Gather:**
   ```bash
   git remote get-url origin
   git rev-parse --abbrev-ref HEAD                      # the branch
   git rev-parse --abbrev-ref origin/HEAD               # e.g. origin/main, so the base is main
   git log --format='%s' origin/main..HEAD              # the commits
   ajwain show OG-12                                    # title, description, children
   ```
2. **Draft the PR.** The title is `OG-12: <ticket title>`, at most 150 characters. The body:
   ```
   Ticket: [OG-12](<the ticket's url, from `ajwain show OG-12`>) <ticket title>

   <ticket description>

   ## Subtasks
   - [x] OG-13 <title>        (mark [x] when its status is done)

   ## Commits
   - OG-12: <subject>
   ```
   Leave out empty sections. Add a `## Testing` section saying how the change was verified, if you know.
3. **Show the title and body, the source and base branches, and what happens next.** Next means the
   push, the PR on the host, the move to the review status, and the comment with the link. Wait for a yes.
4. **Push and create.** Write the body to a temp file, not into the repo:
   ```bash
   body=$(mktemp) && cat > "$body" <<'EOF'
   …body…
   EOF
   git push -u origin HEAD
   ```

   **AWS CodeCommit.** The remote looks like
   `https://git-codecommit.<region>.amazonaws.com/v1/repos/<repo>`, `ssh://git-codecommit.<region>…/v1/repos/<repo>`
   or `codecommit::<region>://<repo>`. Take the region and repo name from it. If the remote has no region
   (`codecommit://<repo>`), use `aws configure get region`.
   ```bash
   aws codecommit create-pull-request --region <region> \
     --title "OG-12: Fix redirect loop after login on Safari 17" \
     --description "file://$body" \
     --targets "repositoryName=<repo>,sourceReference=<branch>,destinationReference=<base>" \
     --query pullRequest.pullRequestId --output text
   ```
   The PR's link is
   `https://<region>.console.aws.amazon.com/codesuite/codecommit/repositories/<repo>/pull-requests/<id>/details?region=<region>`.
   The description can hold at most 10,240 characters, so shorten the commit list if needed. If `aws`
   reports missing or expired credentials, ask the user to sign in themselves (for example
   `! aws sso login`). Never handle AWS keys.

   **GitHub:** run `gh pr view` first. If a PR already exists for the branch, use it. Otherwise:
   ```bash
   gh pr create --base <base> --head <branch> --title "OG-12: …" --body-file "$body"
   ```
   It prints the PR URL.

   **Other hosts:** give the user the host's new-PR page. GitLab and Bitbucket can prefill the
   source and target branches.
5. **Send the ticket for review:**
   ```bash
   ajwain statuses OG                     # find the review status
   ajwain status OG-12 "To be Tested"     # or "In review", "QA"…
   ajwain comment OG-12 "PR: <url>"
   ```
   Prefer a status named "To be Tested". Otherwise use one containing "review", "test" or "QA". If
   there's none, ask.

## Finish

When the PR is merged, or the user says the ticket is done:
1. Check that it merged:
   `aws codecommit get-pull-request --region <region> --pull-request-id <id> --query 'pullRequest.[pullRequestStatus,pullRequestTargets[0].mergeMetadata.isMerged]'`
   or `gh pr view <branch> --json state`.
2. Offer to log any remaining time (see Log time).
3. Confirm, then close it: `ajwain status OG-12 DONE`. That picks the first status in the Done category.
   You can name a status instead, e.g. `"Closed"`.
4. Tidy up, and ask before deleting anything:
   - **Worktree:** from the main checkout, run `git worktree remove ../<repo>-OG-12`, then `git branch -d <branch>`.
     Git refuses when there are uncommitted changes. Don't force it. Show the user what's there.
   - **Branch:** run `git switch <base> && git pull --ff-only && git branch -d <branch>`. After a squash
     merge, `-d` may refuse. Use `-D` only after the user confirms the work is merged.

## Parallel work

Start each ticket with `--worktree`. Each one gets its own checkout `../<repo>-<KEY>` on its own branch.
Work in it with absolute paths or `git -C <path>`, because the shell's directory may reset between
commands. You can also hand each worktree to a separate agent with the ticket as its brief. The main
checkout stays untouched. Ship and finish each ticket on its own.

## Daily: standup and wrap-up

### Standup (morning)

```bash
ajwain standup          # plain text: the app's AI standup, or the queue grouped In progress / Up next
ajwain standup --fresh  # regenerate
```
Show it as is, ready to paste. Offer to:
- add what was done on the previous workday (Friday on a Monday) from the commits:
  `git log --all --since="<previous workday> 00:00" --author="$(git config user.email)" --format='%s'`, grouped by key
- add blockers the user mentions
- point out tickets that are in progress but have no commits lately, or that are overdue

Don't post it anywhere. The user does that.

### Wrap-up (end of day)

1. Get today's commits in this repo. Worktrees share the repo, so `--all` covers them. Ask if the user
   also worked in other repos.
   ```bash
   git log --all --since=midnight --author="$(git config user.email)" --format='%ct%x09%s'
   ```
2. Group the commits by the ticket key in the subject (`OG-12: …`). Suggest time per ticket the way the
   VS Code Today view does:
   - Go through the commits oldest first.
   - Credit each one with the minutes since the previous commit (on any ticket) if that gap is 2h or
     less. Otherwise credit 30m, because it starts a new session.
   - Round each ticket's total to 15m, with a minimum of 15m.
   Say it's a guess.
3. The CLI can't list today's worklogs, so ask whether anything was already logged today. Subtract it.
4. Show a table (key, title, commits, suggested time). The user edits it and confirms. Then run
   `ajwain log KEY <time> "<summary of today's commits>"` for each ticket.
5. For commits with no ticket key, offer to create a ticket (title and description drawn from the
   commits, following writing-tickets.md), or to log them on an existing ticket the user names.
6. Optionally suggest status moves, for example a ticket whose PR is open but which is still In Progress.
