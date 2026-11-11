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
| `codex_ask.sh` | One `codex exec` turn that fails loudly (`CODEX FAILED: …`) instead of returning an empty or truncated answer, and leaves its whole stdout in `PROMPT_FILE.out`. For agents that relay a second opinion. |
| `claude-auto` | Starts `claude` on the Claude account with the most usage to spare, based on its 5-hour and weekly windows. `--strict` exits 75 when every account is past its cutoff, so lanes stop instead of burning a window. |
| `claude-usage`, `codex-usage` | Live quota of every logged-in account. Neither one costs a model call. |
| `codex` | Optional router that shadows the real `codex` on PATH and gives every `codex` call the account with the most weekly quota left. |
| `codex_reset.py` | Shows an account's rate limits and reset credits. |
| `pool_status.py` | Library: the pools write live progress to `~/.cache/hud/pools/<pid>.json` for dashboards, and it holds the disk floor the pools and `claude-auto` check before starting. |

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
- **Fake tool calls:** a Claude row whose answer holds a tool call written out as text (`<invoke name=...>`, which never ran) also carries `"fake_tool_call": true`.
- **Out of quota:** exit 75 means every account ran out; re-run after the reset.
- **Disk floor:** a pool refuses to start (exit 73) with less than 5 GB free where its results file goes, and so does `claude-auto` with less than 5 GB free in its working dir. A Claude pool whose `claude-auto` refuses mid-run stops the same way, leaving the unfinished jobs unrecorded. A full disk cuts results files short and fails every Bash call a Claude Code session makes. Nothing is deleted to make room.

## The skills

`skills/fan-out` is the operating manual: which tool to use at which width, the limits we measured, and the gotchas. `skills/quota` reads quota before a wide run. Install them for Claude Code and Codex by linking each folder into `~/.claude/skills/` and `~/.codex/skills/`.

They read `~/.config/agent-fleet/local.md` if it exists. Put your own setup there: which model gets which task, your machines, your account names. That way the shared skills stay generic.

## The Claude Code plugin

`plugin/` is a Claude Code plugin, `agent-fleet`:

- **The `pkill -f` guard.** Denies a Bash (or Monitor) command where `pkill` appears with `-f`, `--full` or a cluster like `-9f` after it, in every session and subagent: bare, after `&&` or `;`, inside `ssh host '…'`, behind `sudo` or `xargs`. `pkill -f` matches whole command lines, so it kills its own shell and other sessions' processes that mention the pattern. The deny says to record `$!` or a pidfile at launch and kill that PID instead. `pgrep -f`, `pkill name`, and text handed to grep, sed, git or gh still run. It reads the command, not a script it runs.
- **The hud.** Claude and codex quota per account, this machine's cpu, memory and disk (and one remote machine's), running pools, and the session's subagents. It draws as a band above the prompt, plus a pane (docked beside the transcript in the fullscreen TUI); `/hud` toggles the pane.
- **`agent-fleet:astra` and `agent-fleet:sol`.** Haiku subagents that run a task through `codex_ask.sh` (GPT-6 Astra, GPT-6.1 Sol). Their descriptions tell Claude to use them only when you ask for that model by name, and they need a working codex login. The plugin hands the caller `codex_ask.sh`'s own output (the `PROMPT_FILE.out` it leaves; the relay's command runs as written, which auto mode needs) in place of the relay's message, or the relay's `CODEX FAILED:` line, so a relay cannot pass off its own answer as GPT's.

Run `install.sh` first: the plugin calls `codex_ask.sh` and `codex-usage` from PATH, and shows accounts with no live session from `claude-usage`'s `usage-probe.json`. Then, at a Claude Code prompt:

```
/plugin install agent-fleet --marketplace Thomas-Lemoine/agent-fleet
```

Options, set in `/config`: `remote`, an ssh host the hud shows as a second machine, and `archive`, an rclone remote whose free space it shows. To run the plugin from a checkout instead, so edits reload live, set `CLAUDE_CODE_PLUGIN_DIRS` to the `plugin` folder in the `env` block of `~/.claude/settings.json`, and the options under `pluginConfigs["agent-fleet"].options`.

## Tests

```sh
uv run --no-project python tests/test_codex_pool.py
uv run --no-project python tests/test_claude_fleet.py
uv run --no-project python tests/test_claude_pool.py
bin/claude-auto --selftest
claude plugin test plugin
```

They use fake servers and sessions, so they make no model calls.

## License

MIT
