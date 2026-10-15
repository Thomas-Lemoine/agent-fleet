#!/usr/bin/env bash
# codex_ask.sh — one `codex exec` turn that fails loudly instead of letting a
# wrapper agent improvise an answer.
#
#   codex_ask.sh MODEL EFFORT PROMPT_FILE [SANDBOX] [WEB]
#     MODEL        gpt-6-astra | gpt-6.1-sol | ...
#     EFFORT       low | medium | high | xhigh | max | ultra
#     PROMPT_FILE  the task; piped to codex on stdin, so no task text (git words,
#                  quotes, $(...)) ever appears on the command line and the
#                  worktree-isolation guard has nothing to trip on
#     SANDBOX      read-only (default) | workspace-write
#     WEB          live (default) | disabled | cached | indexed
#
# stdout on success (exit 0): one provenance line
#   [codex_ask model=… effort=… sandbox=… web=… tokens=…]
# followed by the model's final message verbatim.
# stdout on failure (exit 1): `CODEX FAILED: <why>` then the last stderr lines.
# Failure = codex never started as MODEL (header check), exited non-zero, or
# wrote no answer. Capacity shedding ("at capacity") is retried with backoff.
# Side files next to PROMPT_FILE: PROMPT_FILE.answer and PROMPT_FILE.stderr.
set -u

fail() { echo "CODEX FAILED: $1"; [ -n "${2:-}" ] && [ -f "$2" ] && tail -n 20 "$2"; exit 1; }

[ $# -ge 3 ] && [ $# -le 5 ] || fail "usage: codex_ask.sh MODEL EFFORT PROMPT_FILE [SANDBOX] [WEB]"
model=$1 effort=$2 prompt=$3 sandbox=${4:-read-only} web=${5:-live}
out=$prompt.answer err=$prompt.stderr
[ -s "$prompt" ] || fail "prompt file '$prompt' is missing or empty"
command -v codex >/dev/null 2>&1 || fail "codex CLI not on PATH"

rc=1
for attempt in 1 2 3 4 5; do
  rm -f "$out"
  # --color never: from 0.155 `auto` colors stderr even when redirected, which
  # wraps the header's "model:" in ANSI codes and fails the check below
  codex exec --color never --skip-git-repo-check -m "$model" --ignore-user-config --ephemeral \
    --sandbox "$sandbox" -c "web_search=\"$web\"" -c "model_reasoning_effort=\"$effort\"" \
    -o "$out" - <"$prompt" >/dev/null 2>"$err"
  rc=$?
  # only a FAILED turn is a capacity shed: the sidecar also echoes every shell
  # command's output, and a worker that cats a file mentioning "at capacity"
  # used to be re-run from scratch (twice on 2026-09-10)
  [ "$rc" -ne 0 ] && grep -qi "at capacity\|overloaded\|temporarily unavailable\|try again later" "$err" || break
  [ "$attempt" -lt 5 ] && sleep $((attempt * 20))
done

grep -qx "model: $model" "$err" || fail "codex did not start as $model (exit $rc)" "$err"
[ "$rc" -eq 0 ] && [ -s "$out" ] || fail "codex exited $rc without an answer" "$err"

tokens=$(awk '/^tokens used/{getline; print; exit}' "$err")
echo "[codex_ask model=$model effort=$effort sandbox=$sandbox web=$web tokens=${tokens:-?}]"
cat "$out"
