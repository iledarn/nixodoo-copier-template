# The pipeline runs in a mother session and child sessions

Status: accepted (grill of 2026-10-22, kb record [1189], parts 9–11)

One pipeline run used to live in one session, from reading the ticket to closing it, so the
grill, the ticket work, every dev and QC round and the deploy all sat in one context that each
call re-read. The run is now split. A **mother** session reads the task, loads what kb knows
about its areas (`kb context`), grills, sends the status and writes the ticket with its test
cases. Then it writes a brief and starts a **child** session (title `[child] …`, in the base
checkout) that brings up its own worktree env and runs dev, the QC gate, docs, the demo GIF
and the PR, and ends with a fixed report. Afterwards the mother checks the PR and CI, deploys
only on the user's command, and closes the ticket and the kb task.

- **Grouping is the mother's call**: related tickets (one module, the same files) go to one
  child with one env and one PR, independent ones to children in parallel.
- **Questions go up**: a child asks the mother (`SendMessage`), the mother asks the user,
  writes the answer on the ticket and replies. After the PR the mother forwards review
  comments and CI failures, and the child fixes them.
- **The brief has fixed sections**: task and goal, the Alignment Summary, the rules as kb
  record ids with one line each, acceptance and test cases (on the ticket), what not to do,
  the report format.
- **The child's SessionStart output is slim**: the kb hook recognises the `[child] ` prefix of
  `session_title` and prints the pinned rules and a one-line standup count, about 7 KB instead
  of about 31 KB, which is over the 10,000 characters Claude Code keeps of a hook's output.
  If the app does not fill `session_title` for a session it starts, a child gets the full
  output: that fallback was agreed.
- **No session tool, one session**: in terminal `claude`, in Antigravity or for a teammate
  without the desktop app, the whole pipeline runs in one session, as before, and says so.

## Considered options

- **One session, as before.** Rejected: the context cost grows with every task, and the dev
  rounds re-read the grill they do not need.
- **The child as a subagent of the mother.** Rejected: a subagent cannot spawn the `dev`,
  `review` and `documenter` agents the child runs, and cannot ask the user for the demo GIF
  itself.
- **Agent teams.** Rejected for the reasons in the skill's "Agent economy": a teammate ignores
  its definition's `skills:`, spawns only in an interactive CLI session and does not survive
  `/resume`.

## Consequences

- Two sessions are more moving parts, and the brief is a single point of failure: a thin brief
  costs questions through the mother. Accepted.
- The child's report reaching the mother at the end of its turn, and `SendMessage` from child to
  mother, are assumptions of the desktop app; if either fails, the user relays by hand.
- The pipeline-gates mod keeps one run per session. A child (the skill loaded as
  `child <TASK-KEYS>`) takes the status and grill gates the user opened in its mother's run
  for that task, read from the mod's store, which every session shares; its QC gate stays its
  own, in front of its `gh pr create`. A mother that started a `[child] ` session closes its
  Phase 7 without a QC pass of its own. Without this the child's dev work and the mother's
  closure were refused until the user opened each gate by hand.
