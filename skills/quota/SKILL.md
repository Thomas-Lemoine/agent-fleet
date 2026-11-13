---
name: quota
description: Read live quota across every Claude and codex account (`claude-usage`, `codex-usage`), and pick or switch the account a job runs on. Use whenever asked about usage, limits or quota, before any fan-out or long lane, and before assuming usage can't be seen — it can.
---

# Usage across accounts

Neither command costs a model call. `~/.config/agent-fleet/local.md`, if it
exists, names the accounts and machines.

```sh
claude-usage               # every Claude account: week %, Fable week %, time to the weekly reset
claude-usage --porcelain   # <acct> <week%> <fable%> <week resetsAt>, for scripts
codex-usage                # every ~/.codex* home: weekly % used + reset time
codex-usage --porcelain
```

- **Claude accounts:** A is `~/.claude` (CLAUDE_CONFIG_DIR unset), and each
  one-letter `~/.claude-<x>` is account `<X>`. `echo ${CLAUDE_CONFIG_DIR:-unset}` shows
  which one this session spends: unset means A. Workflow agents and
  subagents spend the session's account.
- **Cutoffs:** don't fan out on an account at ≥98% of its week (for Fable
  work, of its Fable week too). If the session's own account is near its week, it can
  cut this session off too, so move the bulk work elsewhere.
- **Switching Claude accounts:** `claude-auto [claude args]` runs on the
  account with the most room (`--which` prints the pick, `--strict` exits
  75 when every account is past the cutoff, `CLAUDE_AUTO_ONLY=B,C` limits the
  choice).
- **Codex:** `codex_pool.py` spreads work over every home; pass `--home` to
  skip one that is at 100%. `codex_reset.py` shows an account's reset
  credits.
- **Which to spend:** every Claude and codex account has only a weekly
  cap, each reset on its own day. Spend the account whose reset is
  nearest with allowance left, since that allowance is lost at the reset
  (`claude-auto` ranks Claude accounts this way).
