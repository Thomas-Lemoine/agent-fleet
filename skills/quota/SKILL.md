---
name: quota
description: Read live quota across every Claude and codex account (`claude-usage`, `codex-usage`), and pick or switch the account a job runs on. Use whenever asked about usage, limits or quota, before any fan-out or long lane, and before assuming usage can't be seen — it can.
---

# Usage across accounts

Neither command costs a model call. `~/.config/agent-fleet/local.md`, if it
exists, names the accounts and machines.

```sh
claude-usage               # every Claude account: 5h %, week %, Fable week %, time to the weekly reset
claude-usage --porcelain   # <acct> <5h%> <week%> <fable%> <week resetsAt>, for scripts
codex-usage                # every ~/.codex* home: weekly % used + reset time
codex-usage --porcelain
```

- **Claude accounts:** A is `~/.claude` (CLAUDE_CONFIG_DIR unset), and each
  `~/.claude-<x>` is account `<X>`. `echo ${CLAUDE_CONFIG_DIR:-unset}` shows
  which one this session spends: unset means A. Workflow agents and
  subagents spend the session's account.
- **Cutoffs:** don't fan out on an account at ≥75% of its 5-hour window or
  ≥98% of its week. If the session's own account is near its week, it can
  cut this session off too, so move the bulk work elsewhere.
- **Switching Claude accounts:** `claude-auto [claude args]` runs on the
  account with the most room (`--which` prints the pick, `--strict` exits
  75 when every account is past a cutoff, `CLAUDE_AUTO_ONLY=B,C` limits the
  choice).
- **Codex:** `codex_pool.py` spreads work over every home; pass `--home` to
  skip one that is at 100%. `codex_reset.py` shows an account's reset
  credits.
- **Which to spend:** Claude's 5-hour windows reset within hours, codex
  weeks on a fixed day. When codex is tight, prefer whichever Claude
  account has room.
