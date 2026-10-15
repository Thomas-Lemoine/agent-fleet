#!/usr/bin/env python3
"""Run many independent prompts through headless Claude Code, the codex_pool.py way.

    claude_pool.py PROMPTS.jsonl [-o results.jsonl] [--model opus] [--effort high]
                   [--web] [--concurrency 8] [--timeout 1800]

Same files as codex_pool.py, so a stage can switch vendor by switching the
command: PROMPTS.jsonl holds one {"id": ..., "prompt": ...} per line, ids
unique; results are appended to results.jsonl as {"id", "ok", "answer" |
"error", "attempts", "s"}, ids already ok there are skipped, and re-running the
same command resumes.

Each job is one `claude-auto --strict -p` process (~250 MB; fan-out skill,
"Claude fleets"), run from an empty directory with no tools unless --web
gives it WebSearch and WebFetch, no MCP servers, no session file, and no
CLAUDE.md, which keeps its context near 4k tokens. claude-auto picks the
account with the most room per job; exit 75 means every account is past its
cutoff, and then the whole pool stops (exit 75) instead of waiting: a pool that
sleeps until the 5-hour window resets spends each new window the moment it opens
and ate a whole week of account A in a day (2026-10-12). Re-run to resume.
Anything else that yields no answer fails the job loudly in the results file.
Put the data in the prompt: a worker cannot read files, unless --read DIR gives it read-only
Read/Grep/Glob over DIR (repeatable; name absolute paths in the prompt).
Tool-free jobs run lighter through claude_fleet.py: one process per chunk, not per job.
"""
import argparse, json, os, subprocess, tempfile, threading, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from pool_status import publish

STOP = threading.Event()  # set once every account is past its cutoff: no job starts after it


def answer_of(stdout: str) -> tuple[str | None, str]:
    """(answer, error) from `--output-format json`, which is one result object
    or, in some versions, a list of events ending in one."""
    out = json.loads(stdout)
    if isinstance(out, list):
        out = next(e for e in reversed(out) if e.get("type") == "result")
    if out.get("is_error") or not (out.get("result") or "").strip():
        return None, f"{out.get('subtype')}: {(out.get('result') or '')[:300]}"
    return out["result"], ""


def run_job(job: dict, args, cwd: str) -> dict:
    tools = ",".join((["WebSearch", "WebFetch"] if args.web else []) + (["Read", "Grep", "Glob"] if args.read else []))
    cmd = ["claude-auto", "--strict", "-p", "--model", args.model, "--effort", args.effort,
           "--output-format", "json", "--tools", tools, "--setting-sources", "project",
           "--strict-mcp-config", "--no-session-persistence"]
    for d in args.read:  # read-only file access to these trees (absolute paths in the prompt)
        cmd += ["--add-dir", os.path.expanduser(d)]
    if tools:
        cmd += ["--allowedTools", tools]
    t0, attempts = time.time(), 0
    while True:
        if STOP.is_set():
            return None
        attempts += 1
        try:
            p = subprocess.run(cmd, input=job["prompt"], capture_output=True, text=True,
                               cwd=cwd, timeout=args.timeout)
        except subprocess.TimeoutExpired:
            return {"id": job["id"], "ok": False, "error": f"timeout {args.timeout}s",
                    "attempts": attempts, "s": round(time.time() - t0)}
        if p.returncode == 75:
            print(f"{time.strftime('%T')} {job['id']}: every account past its cutoff, stopping", flush=True)
            STOP.set()
            return None
        try:
            ans, err = answer_of(p.stdout)
        except (json.JSONDecodeError, StopIteration):
            ans, err = None, f"rc={p.returncode} {(p.stdout + p.stderr)[-300:]}"
        # The usage readout claude-auto picks by lags the server: a job it sends to an account that has
        # just hit its limit dies in seconds with this message. Treat it like exit 75 (stop, job left
        # unrecorded), or the pool burns through its whole queue as failures (10-11: 1,496 jobs in 25 minutes).
        if ans is None and "hit your session limit" in err:
            print(f"{time.strftime('%T')} {job['id']}: account hit its limit, stopping", flush=True)
            STOP.set()
            return None
        row ={"id": job["id"], "ok": ans is not None, "attempts": attempts, "s": round(time.time() - t0)}
        row.update({"answer": ans} if ans is not None else {"error": err})
        return row


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prompts")
    ap.add_argument("-o", "--out")
    ap.add_argument("--model", default="opus")
    ap.add_argument("--effort", default="high")
    ap.add_argument("--web", action="store_true")
    ap.add_argument("--read", action="append", default=[], metavar="DIR",
                    help="give jobs read-only Read/Grep/Glob over DIR (repeatable); prompts name absolute paths")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--timeout", type=int, default=1800)
    args = ap.parse_args()
    out = Path(args.out or args.prompts.removesuffix(".jsonl") + ".results.jsonl")
    jobs = [json.loads(x) for x in open(args.prompts) if x.strip()]
    ids = [j["id"] for j in jobs]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate ids in the prompts file")
    done = {json.loads(x)["id"] for x in open(out) if x.strip() and json.loads(x)["ok"]} if out.exists() else set()
    todo = [j for j in jobs if j["id"] not in done]
    print(f"{len(todo)} jobs ({len(done)} already done), {args.model} {args.effort} "
          f"web={'on' if args.web else 'off'}, {args.concurrency} in flight", flush=True)
    lock, failed, n = threading.Lock(), 0, 0
    # Claude jobs pick their account per job (claude-auto), so in flight is one count; the hud
    # attributes the running `claude -p` processes to accounts itself.
    publish("claude", args.prompts, args.model, lambda: {
        "total": len(done) + len(todo), "base": len(done), "done": len(done) + n, "failed": failed,
        "inflight": min(args.concurrency, len(todo) - n)})
    with tempfile.TemporaryDirectory(prefix="claude_pool.") as cwd, ThreadPoolExecutor(args.concurrency) as ex:
        for row in ex.map(lambda j: run_job(j, args, cwd), todo):
            if row is None:  # not run, or cut off by the limit: a re-run picks it up
                continue
            with lock, open(out, "a") as f:
                f.write(json.dumps(row) + "\n")
            n += 1
            failed += not row["ok"]
            if n % 10 == 0 or not row["ok"]:
                print(f"  {n}/{len(todo)} done, {failed} failed"
                      + ("" if row["ok"] else f"  {row['id']}: {row['error'][:120]}"), flush=True)
    print(f"{n} jobs, {failed} failed -> {out}" + (", stopped: every account past its cutoff" if STOP.is_set() else ""), flush=True)
    raise SystemExit(75 if STOP.is_set() else 1 if failed else 0)


if __name__ == "__main__":
    main()
