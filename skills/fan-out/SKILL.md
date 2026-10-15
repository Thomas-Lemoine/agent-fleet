---
name: fan-out
description: Use before fanning out subagents or parallel workers, and whenever choosing which model (codex or Claude) should do a task. Covers which tool fits which width, codex pools, Claude fleets (one process, many agents), measured ceilings, caching, and gotchas.
metadata:
  requires: "agent-fleet tools on PATH (install.sh); codex and/or claude CLIs logged in"
---

# Fanning out subagents

**First read `~/.config/agent-fleet/local.md` if it exists.** It is the
operator's own layer: which model gets which task, the machines available
(an always-on server, rentable burst machines), account names and house
rules. Where it disagrees with this file, it wins.

Both vendors are subscriptions with finite quota: Claude accounts have
5-hour windows that reset within hours plus a weekly cap; codex accounts
have a weekly cap reset on a fixed day. Check both with the `quota` skill
before any wide run, and spend whichever has room. When codex is tight,
Claude is usually the better spend because its windows come back soonest.
Codex numbers below were measured 2026-09-06 with codex 0.153.2; Claude
fleet numbers 2026-09-25 to 2026-10-15 on Claude Code 2.x.

## Which model for which task

Defaults when local.md has no routing table:

| Task | Model |
|---|---|
| Classification, extraction, finding info in text, format conversion | `gpt-6-luna` or Claude Haiku |
| Taste: design, prose for humans, judgment calls on wording | Claude Opus |
| Development work | Claude Opus |
| Hard reasoning: novel proofs, subtle algorithms, soundness | `gpt-6-astra` |
| Routine review | `gpt-6.1-sol` |
| Important review (anything expensive to get wrong) | `gpt-6-astra` |
| Probes and tests of the fleet machinery itself | Claude Haiku / `gpt-6-luna` |

When a new model ships, this table is stale until someone re-reads it:
flag it to the operator rather than routing new work by old names.

## Pick the tool by width

| Concurrent calls | Use |
|---|---|
| 1–3, answer wanted in your context | `codex_ask.sh MODEL EFFORT PROMPT_FILE` from your shell tool (or a relay subagent that runs it) |
| 4–10, one-off | `codex_ask.sh` per call, backgrounded, prompts as files |
| 10–450 independent codex prompts | `codex_pool.py` (below): one process per account, ~4.5 MB per worker |
| 10–1000 Claude prompts, no tools or web search only | `claude_fleet.py` (Claude fleets, below): one headless Workflow session per chunk |
| Claude prompts that need images, `--read` of a directory, or crash isolation | `claude_pool.py`: one `claude -p` per job |
| wide, long, or must survive the laptop sleeping | the same tools on an always-on machine (local.md) |

Never spawn one `codex exec` per task past ~10: each is a ~150 MB process
plus 2 s startup, and 40 of them push a laptop into swap. The pool runs
the same work through one `codex app-server` per account.

## The codex pool

```sh
# prompts.jsonl: one {"id": "...", "prompt": "..."} per line, ids unique
codex_pool.py prompts.jsonl --model gpt-6-astra --effort high --web cached
# -> prompts.results.jsonl: {"id","ok","answer"|"error","attempts","s"}, appended as jobs finish
#    prompts.results.log: the servers' stderr, read it when jobs fail oddly
```

- **What a worker is:** a fresh conversation with no memory, a read-only
  sandbox, web search per `--web`, and no shell unless you pass `--shell`.
  Put the data in the prompt (a shard's file contents, not its path) and
  state the output format you want back. `--shell` is for audits over
  files, where the worker greps a directory you name. A job may carry
  `"images": [absolute paths]`.
- **Width:** `--concurrency` (default 50) and `--chunk` (default 100) are
  per account, and the default is every logged-in `~/.codex*` home. Every
  pool on the machine also shares 50 turns per account (lock files in
  `~/.cache/codex-slots`): a second pool on the same accounts waits for
  slots and splits them evenly with the first, instead of stacking past the
  ceiling into 429s. More width means more accounts, not more concurrency.
  Slots are per machine, so pools on two machines sharing an account still
  stack.
- **Resume:** re-running the same command skips ids already `ok` in the
  results file. It keys on id only, so a changed prompt needs a new id or a
  new `-o` file. Failed attempts stay as `"ok": false` rows; aggregate by
  taking the `ok` row per id.
- **Failure is loud:** every job ends as a row, exit code 1 if any failed.
  "At capacity" and HTTP 429 are retried `--retries` times with backoff;
  everything else (timeout, server death, empty answer) is one row and you
  decide.
- **Accounts share one queue.** A faster account takes more jobs, and an
  account that hits its usage limit drops out and hands its jobs back (one
  stderr line per account, with the reset time). If every account is dry
  the leftovers stay unrecorded and count as `missing`; re-run after the
  reset.
- **Run it in the background** and poll the results file. A 100-job Astra
  batch at `high` takes a few minutes; each turn is ~20 s.

## Claude fleets (one process, many agents)

The Claude analogue of the codex app-server is ONE headless session that
runs a Workflow: workflow agents live inside that process, so 48 Haiku
agents peaked at 380 MB for the whole process, where a separate `claude -p`
per job is ~250 MB each. The session's account pays for every agent.

```sh
claude_fleet.py prompts.jsonl --model opus --effort high --concurrency 16
```

- Same files as the codex pool (ids, `ok`, resume by id). Each `--chunk`
  (100) of jobs is one `claude-auto --strict` session, so every chunk picks
  the account with room. It stops with exit 75 when accounts run out, and
  loudly when a session runs no agents. Failed rows carry the agent's error.
- Prompts go inline in generated workflow scripts, which are capped at
  512 KB: a chunk spreads over child scripts, and a single prompt too big
  for one fails its row ("use claude_pool.py").
- Workers have no tools (WebSearch and WebFetch with `--web`) and the
  workflow's subagent framing, so answers run terser than claude_pool's.
  On a 600-item benchmark the fleet's accuracy matched claude_pool's
  run-to-run spread (92.5% vs 93.0–93.7%).
- **Web search is budgeted per session, and a workflow's agents share
  it.** The budget is a client-side counter,
  `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` (default 200, no upper bound);
  `--web` sets it to 200 per job. The second wall is the account's cap on
  concurrent requests (`rate_limit_event` with `rateLimitType:
  "concurrents"`): every search is its own request, so 15–16 agents on one
  account ran clean while 32 (one session, or two fleets of 16) lost ~25%
  of searches and some agents to "You've hit your usage limit", the CLI's
  wording for that cap too. Keep a web fleet at `--concurrency 16` per
  account. Count searches from agent transcripts, never from the agents'
  answers: Haiku's self-reported counts invented refusals.
- **No cache sharing between workflow agents (2026-09-25):** 16 agents with
  the same 9k-token prefix each paid their own cache write. Separate
  `claude -p` processes do share a common prefix. For a fleet that all
  reads one big document, give the workers the gist, or use claude_pool.
- **Lean context:** run from a neutral directory, never inside a repo whose
  CLAUDE.md/AGENTS.md would add ~45k tokens to every agent. The tools
  already do this.
- **`--bare` does not work with subscriptions:** it reads only
  `ANTHROPIC_API_KEY`, never OAuth.
- **Never wrap a Claude lane in anything that relaunches at the 5-hour
  reset:** that spends each new window the moment it opens and can burn an
  account's whole week in a day.

`claude_pool.py prompts.jsonl --model opus --effort high [--web] [--read DIR]
--concurrency 8` is the one-process-per-job fallback: each job is one
`claude-auto --strict -p` from an empty cwd with no tools (WebSearch/WebFetch
with `--web`, Read under `--read`), no MCP, no CLAUDE.md: ~4k tokens of
context, ~250 MB. One Opus web list writer cost ~0.7% of an account's
5-hour window and ~0.1% of its week.

### A fleet by hand

For a workflow that is more than a prompts file:

```sh
cd <neutral scratch dir>
CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=32 CLAUDE_CONFIG_DIR=~/.claude-b \
  claude -p --model haiku --output-format json --no-session-persistence \
  --setting-sources project --strict-mcp-config --tools Workflow --allowedTools Workflow \
  < orchestrate.prompt > run.json
```

- **orchestrate.prompt** says the user asks for this workflow and gives the
  inline script. The parent only launches it, so Haiku is enough; the
  `model:` on each `agent()` picks the workers' model. Pass the prompt on
  stdin: `--allowedTools` is variadic and swallows a trailing prompt.
- **`scriptPath` needs `Read` in `--tools`;** without it the Workflow tool
  takes only an inline `script`. Headless, the workflow runs in the
  background and the session exits once it ends. Per-agent answers are in
  `<transcript dir>/journal.jsonl` (the Workflow tool result names the
  dir); failure reasons only in the task notification's `output_file`
  (`workflowProgress[].error`). Labels come back with whitespace collapsed,
  so key agents by index.
- **Concurrency gate:** default min(16, CPUs − 2).
  `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` raises it with no hidden
  ceiling (36 agents: 236 s at the default gate on 8 CPUs, 118 s at 36).
  Agents are network-bound, so the CPU rule is far below what memory allows.
- **Workers inherit the parent's context:** a parent started from a neutral
  cwd with `--tools` narrowed gives ~950-token workers; a default session in
  a repo is ~49k tokens per agent.
- **Refusals:** a bare instruction from a script ("reply with just N") is
  sometimes refused as injected text (1 of 24 Haiku agents). Real task
  prompts that explain the job run fine.

## Ceilings (measured, one IP)

- **~50 concurrent codex turns per account is the full-speed ceiling.**
  Above it codex's websocket connect gets HTTP 403 and falls back to plain
  HTTP: turns still succeed, but median latency went 14 s → 40 s at 100 →
  75 s at 150 per account, so throughput falls.
- **IP is not the key.** 450 concurrent (3 accounts × 150) from one IP,
  zero HTTP 429s. Scale by adding accounts, never by proxies.
- **Quota** (5 h / weekly) is per account and shared between local and
  cloud use. Astra costs 2.5× Sol per token; Luna is cheap enough that a
  450-turn probe barely registers.
- **"Selected model is at capacity" is weather, not a cap:** per-model
  global congestion that changes minute to minute. The pool retries it;
  when one model sheds repeatedly, switch models (`gpt-5.6-terra` is the
  overflow when sol sheds).
- **Memory:** ~50 MB per codex server + ~4.5 MB per live thread; 450
  workers cost ~2 GB. Finished ephemeral threads stay resident while the
  client is attached, so the pool restarts each server per chunk.
- **Codex web search is a limiter for search-heavy workers:** 50 workers
  that each search many times failed 70 of 84 jobs on one account with the
  tool router's `429 Rate limit exceeded` (not retried by the pool). Size
  `--web live` swarms by searches per minute: start search-in-a-loop
  workers at ~10 per account, 50+ only for one-search workers.

## Models and effort

- Effort: `medium` for extraction and format conversion; `high` or `xhigh`
  for debugging, math, design judgment; `max` for problems worth very long
  deliberation. `ultra` is client-side orchestration (codex spawns its own
  subagents) and does not work with ephemeral threads; use it only through
  a plain `codex exec`.
- Web search: `cached` (OpenAI's index) for solvers, `live` for workers
  that need current facts, `disabled` for offline work. For many workers
  needing the same literature, run 2–4 `live` "librarian" workers first and
  feed their notes to the solvers.
- Prompt-cache hygiene: identical shared preamble across a swarm, per-task
  content at the end. The codex cache is org-wide across processes (77–90%
  hit rates measured).
- Shape sweeps as map-reduce over data shards, not one worker per question:
  a worker per file-batch returning findings, then one aggregator.

## Gotchas

- astra, sol and terra are `code_mode_only` models: `--disable
  code_mode_host` silently removes every tool including web search. The
  pool keeps the host on (one ~17 MB sidecar per server).
- `-c mcp_servers={}` is a deep-merge no-op; MCP servers must be disabled by
  name. The pool reads each home's `config.toml` and disables every server
  it finds.
- Ubuntu 24.04 blocks the user namespaces codex's bubblewrap sandbox needs
  (`--shell` workers fail). Set `kernel.apparmor_restrict_unprivileged_userns=0`
  in `/etc/sysctl.d/`.
- A `codex exec --sandbox workspace-write` on an untrusted dir writes a
  `[projects."…"] trust_level` entry into that account's `config.toml`;
  delete stray entries after such runs. The read-only pool never does.
- Never copy `auth.json` between homes or machines: refresh tokens diverge.
  Log in on each machine.
- From a GUI-spawned shell, `ulimit -n` may be 256; raise it to 4096 before
  a wide swarm or the pool hits EMFILE around 40–80 workers.
- Lean `codex exec` line, when you need a standalone process:
  `codex exec --ignore-user-config --ephemeral --skip-git-repo-check
  --sandbox read-only -m MODEL -c model_reasoning_effort="EFFORT"
  -c 'web_search="cached"' -o OUT -` with the prompt on stdin.

## Codex Cloud (only when no machine can stay up)

`codex cloud exec --env <environment> "<task>"` returns a task URL in ~2 s
and 15+ tasks run in parallel. Tasks must write their answer to a file in
the repo (`codex cloud diff <id>` / `apply`). Model and effort are
service-controlled, secrets are stripped before the agent phase, agent
internet is off by default, and `uv` needs an explicit `uv sync --locked` in
both setup and maintenance scripts. Validate with one task before fanning
out: a broken setup script kills the whole batch. `--attempts ≤4` runs N
alternatives with no judge; compare `--attempt N` diffs yourself.
