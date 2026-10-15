# agent-fleet

Tools for running many Claude Code and Codex agents at once across several subscription accounts:

- prompts go out as one file of jobs and come back as one file of answers;
- a few processes do the work, not one per job;
- each run spends whichever account has quota left.

Python stdlib only; every tool is a single file in `bin/`.

| Tool | What it does |
|---|---|
| `codex_pool.py` | Runs a JSONL file of prompts through `codex app-server`, one server per account and ~50 turns in flight each. Accounts share one queue; an account that runs dry hands its jobs back. A re-run resumes by job id. |
| `claude_fleet.py` | The Claude version: each chunk of 100 prompts is one headless Claude Code session running a Workflow, so one ~400 MB process does what would otherwise be 100 `claude -p` processes of ~250 MB each. Workers get no tools (web search with `--web`). |
| `claude_pool.py` | Same files, one `claude -p` per job. Use it for what the fleet cannot do: images, read access to a directory (`--read`), or crash isolation. |
| `codex_ask.sh` | One `codex exec` turn that fails loudly (`CODEX FAILED: …`) instead of returning an empty or truncated answer. For agents that relay a second opinion. |
| `claude-auto` | Starts `claude` on the Claude account with the most usage to spare, based on its 5-hour and weekly windows. `--strict` exits 75 when every account is past its cutoff, so lanes stop instead of burning a window. |
| `claude-usage`, `codex-usage` | Live quota of every logged-in account. Neither one costs a model call. |
| `codex` | Optional router that shadows the real `codex` on PATH and gives every `codex` call the account with the most weekly quota left. |
| `codex_reset.py` | Shows an account's rate limits and reset credits. |
| `pool_status.py` | Library: the pools write live progress to `~/.cache/hud/pools/<pid>.json` for dashboards. |

## Install

```sh
git clone https://github.com/Thomas-Lemoine/agent-fleet ~/GitHub/agent-fleet
~/GitHub/agent-fleet/install.sh            # links the tools into ~/.local/bin
~/GitHub/agent-fleet/install.sh --router   # also the codex router (shadows `codex`)
```

You need Python 3.11+ and the `codex` and/or `claude` CLIs. `git pull` updates everything, since the installed files are links.

## Accounts

- **Codex:** `~/.codex` plus every `~/.codex-<x>` dir that holds an `auth.json`. Add one with `CODEX_HOME=~/.codex-b codex login`; on a headless box, use `codex login --device-auth`.
- **Claude:** `~/.claude` is account A, and each one-letter `~/.claude-<x>` is account `<X>`. Add one with `CLAUDE_CONFIG_DIR=~/.claude-b claude`, then `/login`. `CLAUDE_AUTO_ONLY=B,C` limits `claude-auto` to those accounts.

`claude-auto` reads each account's usage from two files and uses the newer one:

- **`usage-probe.json`:** run `claude-usage` from cron every 10–30 min on every machine that spends the accounts.
- **`last-statusline.json`:** for readings fresh to the second, add one line to your Claude Code statusline script:

  ```sh
  printf "%s" "$input" > "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/last-statusline.json"   # $input: the JSON Claude Code passes on stdin
  ```

## Jobs files

All three pools use the same format. Switching vendor for a stage means switching the command.

```sh
# prompts.jsonl: one {"id": "...", "prompt": "..."} per line, ids unique
# codex_pool also takes "images": [absolute paths]; claude_pool workers open files under --read DIR
codex_pool.py prompts.jsonl --model gpt-6-astra --effort high --web cached
claude_fleet.py prompts.jsonl --model opus --effort high --concurrency 16
# -> prompts.results.jsonl: {"id", "ok", "answer" | "error", "attempts", "s"}, appended as jobs finish
```

- **Resume:** a re-run skips ids already `ok`.
- **Failures:** every job ends as a row, and the exit code is 1 if any failed.
- **Out of quota:** exit 75 means every account ran out; re-run after the reset.

## The skills

`skills/fan-out` is the operating manual: which tool to use at which width, the limits we measured, and the gotchas. `skills/quota` reads quota before a wide run. Install them for Claude Code and Codex by linking each folder into `~/.claude/skills/` and `~/.codex/skills/`.

They read `~/.config/agent-fleet/local.md` if it exists. Put your own setup there: which model gets which task, your machines, your account names. That way the shared skills stay generic.

## Tests

```sh
uv run --no-project python tests/test_codex_pool.py
uv run --no-project python tests/test_claude_fleet.py
bin/claude-auto --selftest
```

They use fake servers and sessions, so they make no model calls.

## License

MIT
