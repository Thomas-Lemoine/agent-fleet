#!/usr/bin/env python3
"""Run many prompts through Claude in one process per chunk: claude_pool.py's files and resume,
but one headless Workflow session holds a whole chunk instead of one `claude -p` per job.

    claude_fleet.py PROMPTS.jsonl [-o results.jsonl] [--model opus] [--effort high] [--web]
                    [--concurrency 16] [--chunk 100] [--timeout 1800]

PROMPTS.jsonl holds one {"id": ..., "prompt": ...} per line, ids unique; rows {"id", "ok",
"answer" | "error", "attempts", "s"} are appended to results.jsonl as agents finish, ids already
ok there are skipped, and re-running the same command resumes. A failed row carries the agent's
error; the sessions' stderr goes to results.log.

Each chunk of --chunk jobs is one `claude-auto --strict -p` session from an empty directory (the
parent on --model with only the Workflow and Read tools, plus WebSearch and WebFetch with --web;
no MCP, no CLAUDE.md) that runs a generated workflow: one agent() per job with its prompt inline,
--concurrency at once. Workers get no tools (WebSearch and WebFetch with --web) and the
workflow's subagent framing ("your final text is the return value"). A chunk is one ~400 MB process where claude_pool spends ~250 MB per
job in flight (fan-out skill, "Claude fleets"). The Workflow tool refuses a script over 512 KB,
so a chunk's jobs are spread over child scripts that the top script runs under one concurrency
gate. Answers come from the workflow's journal.jsonl, read as it grows. Chunks run one after
another, so each one's last wave runs below --concurrency.

A session's agents share one web search budget (200 searches by default), so --web gives each
session 200 per job. Each search is its own request and agents send several at once, so a web
fleet past ~16 agents on one account (--concurrency 32, or two web fleets at once) draws the
account's cap on concurrent requests: about a quarter of the searches fail, as do some agents.
Keep --web at the default --concurrency. claude_pool.py stays the driver for --read.

claude-auto picks the account per chunk; when it exits 75 (every account past its cutoff) or a
session hits its usage limit, the fleet stops (exit 75) and leaves the unfinished jobs
unrecorded: re-run to resume. Agents refused by the concurrent-request cap carry the CLI's "usage
limit" words, but the account has room: those jobs fail and the fleet goes on. A session that
runs no agents at all stops the fleet loudly rather than failing chunk after chunk. Anything else
that yields no answer fails its job in the results file.
"""
import argparse, json, math, os, re, signal, subprocess, sys, tempfile, threading, time
from pathlib import Path

from pool_status import publish

SCRIPT_MAX = 500_000  # bytes per workflow script: the Workflow tool refuses files over 524,288
SEARCHES_PER_JOB = 200  # the CLI's default web search budget for a whole session
ORCHESTRATE = ("I am asking you to run the workflow script at {path}: call the Workflow tool once with "
               "scriptPath set to that path, and do not relaunch or resume it. When it completes, reply "
               "with the single word done.")
# How the CLI words a spent account: "You've hit your limit", "hit your session limit", "You've
# reached your Fable limit", "You're out of usage credits", "usage credit limit".
LIMIT = re.compile(r"hit your (\w+ )?limit|reached your \w+ limit|out of usage credits|usage credit limit")
# The CLI's words for a request the account's concurrent-request cap refused (and for an untyped
# rejection); its real limits name themselves ("hit your session limit", "hit your limit · resets").
CAP_WORDS = re.compile(r"hit your usage limit")


def part_script(entries: list[tuple[int, str]], model: str, effort: str) -> str:
    """A workflow that runs each (index, prompt) as one tool-free agent labelled by its index (the
    runtime rewrites labels' whitespace, so ids would not survive as labels)."""
    return ("export const meta = { name: 'claude-fleet-part', description: 'Answer independent prompts, one agent each' }\n"
            f"const JOBS = {json.dumps(entries, ensure_ascii=False)}\n"
            f"const out = await parallel(JOBS.map(([k, prompt]) => () => agent(prompt, "
            f"{{ label: String(k), model: {json.dumps(model)}, effort: {json.dumps(effort)}, disallowedTools: ['Read'] }})))\n"
            "return out.filter(x => x != null).length\n")


def top_script(parts: list[str]) -> str:
    """The script the session runs: every part script at once, sharing the session's agent gate."""
    return ("export const meta = { name: 'claude-fleet', description: 'Answer independent prompts, one agent each' }\n"
            f"const PARTS = {json.dumps(parts)}\n"
            "const n = await parallel(PARTS.map(p => () => workflow({ scriptPath: p })))\n"
            "return `${n.reduce((a, b) => a + (b || 0), 0)} answered`\n")


def entry_bytes(k: int, prompt: str) -> int:
    return len(json.dumps([k, prompt], ensure_ascii=False).encode()) + 2  # its entry in JOBS, with the ", "


def pack(entries: list[tuple[int, str]], model: str, effort: str) -> list[list[tuple[int, str]]]:
    """Consecutive runs of entries whose part script stays under SCRIPT_MAX."""
    base, parts, size = len(part_script([], model, effort).encode()), [], 0
    for k, prompt in entries:
        if not parts or size + entry_bytes(k, prompt) > SCRIPT_MAX:
            parts.append([]); size = base
        parts[-1].append((k, prompt)); size += entry_bytes(k, prompt)
    return parts


def run_session(chunk: list[dict], args, workdir: str, log: Path, record, live) -> bool:
    """Runs one chunk as one headless session, calling record(row) for each job as it finishes and
    live(n) with the agents in flight. Returns True when the session ran out of usage (claude-auto's
    exit 75, or the account hit its limit); its unfinished jobs then get no row. Raises SystemExit
    when the session ran no agents at all."""
    d = tempfile.mkdtemp(dir=workdir)
    paths = []
    for i, part in enumerate(pack([(k, j["prompt"]) for k, j in enumerate(chunk)], args.model, args.effort)):
        paths.append(os.path.join(d, f"part{i}.js"))
        Path(paths[-1]).write_text(part_script(part, args.model, args.effort))
    top = os.path.join(d, "fleet.js")
    Path(top).write_text(top_script(paths))
    # The parent runs on the workers' model so claude-auto weighs the right limits (a Fable week).
    # Workers inherit the parent's tools, minus Read (their part script disallows it).
    tools = "Workflow,Read" + (",WebSearch,WebFetch" if args.web else "")
    cmd = ["claude-auto", "--strict", "-p", "--model", args.model, "--output-format", "stream-json", "--verbose",
           "--tools", tools, "--allowedTools", tools, "--setting-sources", "project",
           "--strict-mcp-config", "--no-session-persistence"]
    env = {**os.environ, "CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS": str(args.concurrency),
           # A session's agents share one web search budget, 200 by default: size the shared pool
           # at the 200 a `claude -p` per job would have had.
           "CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION": str(SEARCHES_PER_JOB * len(chunk))}
    with open(log, "a") as err:
        err.write(f"== {time.strftime('%F %T')} session of {len(chunk)} jobs in {d}\n")
        err.flush()
        log_from = err.tell()
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err,
                                text=True, cwd=workdir, env=env)
    try:
        return watch(proc, top, chunk, args, log, log_from, record, live)
    finally:  # a crash or SIGTERM here must not leave the session spending the chunk unrecorded
        if proc.poll() is None:
            proc.kill(); proc.wait()
        live(0)


def watch(proc, top, chunk, args, log, log_from, record, live) -> bool:
    """run_session's body once the session is up: stream rows from its journal until it exits."""
    proc.stdin.write(ORCHESTRATE.format(path=top))
    proc.stdin.close()

    # The stream says where the journal is (the first Workflow tool result names the run's
    # transcript dir; a relaunch's is ignored), where the run's summary lands (the task
    # notification), which of the account's limits refused a request ("rejected", by
    # rateLimitType), and what the parent said last.
    seen = {"journal": None, "summary": None, "rejected": set(), "last": ""}

    def read_stream():
        for line in proc.stdout:
            e = json.loads(line)
            if e["type"] == "rate_limit_event" and e["rate_limit_info"]["status"] == "rejected":
                seen["rejected"].add(e["rate_limit_info"].get("rateLimitType", ""))
            elif e["type"] == "result":
                seen["last"] = e.get("result") or ""
            elif e["type"] == "system" and e.get("subtype") == "task_notification" and not seen["summary"]:
                seen["summary"] = e.get("output_file")
            elif e["type"] == "user" and isinstance(e["message"]["content"], list) and not seen["journal"]:
                for c in e["message"]["content"]:
                    text = c.get("content") if c.get("type") == "tool_result" else None
                    text = text if isinstance(text, str) else json.dumps(text)
                    if m := re.search(r"Transcript dir: (\S+)", text):
                        seen["journal"] = Path(m.group(1)) / "journal.jsonl"

    reader = threading.Thread(target=read_stream, daemon=True)
    reader.start()
    agents, failed, finished = {}, set(), set()  # agentId -> (index, start); indexes that failed / got a row
    offset, t0, timed_out = 0, time.time(), False
    deadline = t0 + args.timeout * math.ceil(len(chunk) / args.concurrency)  # --timeout per wave
    while True:
        exited = proc.poll() is not None  # before the read, so the last pass sees every line
        j = seen["journal"]
        if j and j.exists():
            with open(j, "rb") as f:
                f.seek(offset)
                data = f.read()
            data = data[:data.rfind(b"\n") + 1]  # whole lines only: the writer may be mid-line
            offset += len(data)
            for e in map(json.loads, data.splitlines()):
                # Only lines naming an agent we saw start count: a failed line can carry agentId ""
                # (an agent refused before it started), and that job gets its row at the end.
                if e["type"] == "started":
                    agents[e["agentId"]] = (int(e["label"]), time.time())
                elif e["type"] in ("result", "failed") and e["agentId"] in agents:
                    k, t = agents[e["agentId"]]
                    ans = e.get("result") if isinstance(e.get("result"), str) else ""
                    if e["type"] == "result" and ans.strip() and k not in finished:
                        finished.add(k)
                        record({"id": chunk[k]["id"], "ok": True, "attempts": 1,
                                "s": round(time.time() - t), "answer": ans})
                    else:
                        failed.add(k)
            live(len(agents) - len(finished) - len(failed - finished))
        if exited:
            break
        if time.time() > deadline:
            proc.kill(); proc.wait(); timed_out = True
            continue  # one more read of whatever the journal has
        time.sleep(2)
    reader.join(10)

    # Why agents failed: the run summary's per-agent errors, by label.
    reasons = {}
    if seen["summary"] and os.path.exists(seen["summary"]):
        for p in json.load(open(seen["summary"])).get("workflowProgress", []):
            if p.get("type") == "workflow_agent" and p.get("error"):
                reasons[int(p["label"])] = p["error"]
    with open(log) as f:
        f.seek(log_from)
        said = f.read() + seen["last"] + " ".join(reasons.values())
    # "concurrents" is the account's cap on requests in flight, not its usage: the requests it
    # refused fail their agents with the CLI's "You've hit your usage limit", but the account
    # has room, so those jobs fail (a re-run retries them) and the fleet goes on. Any other
    # rejection, or limit words other than the cap's, still mean the account ran out.
    busy = "concurrents" in seen["rejected"]
    if busy:
        said = CAP_WORDS.sub("", said)
    if proc.returncode == 75 or seen["rejected"] - {"concurrents"} or LIMIT.search(said):
        return True
    if not agents:
        cap = "; the account's cap on concurrent requests refused it (another fleet on this account?)"
        raise SystemExit(f"a session ran no agents (rc={proc.returncode}, journal "
                         f"{'named' if seen['journal'] else 'never named'}){cap if busy else ''}; its "
                         f"parent said {seen['last'][:300]!r}; see {log}")
    for k in sorted(set(range(len(chunk))) - finished):
        why = (reasons.get(k) or ("its agent failed" if k in failed else
               f"timeout after {round(time.time() - t0)}s" if timed_out else
               f"the session ended (rc={proc.returncode}) before its agent did: {seen['last'][:200]!r}"))
        if busy and CAP_WORDS.search(why):
            why = f"the account's cap on concurrent requests ({why})"
        record({"id": chunk[k]["id"], "ok": False, "attempts": 1, "s": round(time.time() - t0),
                "error": f"{why}; see {log}"})
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prompts")
    ap.add_argument("-o", "--out")
    ap.add_argument("--model", default="opus")
    ap.add_argument("--effort", default="high")
    ap.add_argument("--web", action="store_true", help="give workers WebSearch and WebFetch")
    ap.add_argument("--concurrency", type=int, default=16, help="agents in flight")
    ap.add_argument("--chunk", type=int, default=100, help="jobs per session (claude-auto picks its account)")
    ap.add_argument("--timeout", type=int, default=1800,
                    help="seconds per job: a session gets this per wave of --concurrency jobs")
    args = ap.parse_args()
    if not 1 <= args.chunk <= 1000:
        raise SystemExit("--chunk must be 1..1000 (a workflow runs at most 1000 agents)")
    out = Path(args.out or args.prompts.removesuffix(".jsonl") + ".results.jsonl")
    log = out.with_suffix(".log")
    jobs = [json.loads(x) for x in open(args.prompts) if x.strip()]
    if len({str(j["id"]) for j in jobs}) != len(jobs):
        raise SystemExit("duplicate ids in the prompts file")
    if with_images := sum(1 for j in jobs if j.get("images")):
        raise SystemExit(f"{with_images} jobs carry images, which a workflow agent cannot take: use codex_pool.py")
    done = {json.loads(x)["id"] for x in open(out) if x.strip() and json.loads(x)["ok"]} if out.exists() else set()
    todo = [j for j in jobs if j["id"] not in done]
    print(f"{len(todo)} jobs ({len(done)} already done), {args.model} {args.effort}, "
          f"{args.concurrency} in flight, {args.chunk} per session", flush=True)

    lock, n, failed, inflight, total = threading.Lock(), [0], [0], [0], len(todo)

    def record(row):
        with lock, open(out, "a") as f:
            f.write(json.dumps(row) + "\n")
            n[0] += 1
            failed[0] += not row["ok"]
        if n[0] % 10 == 0 or not row["ok"]:
            print(f"  {n[0]}/{total} done, {failed[0]} failed"
                  + ("" if row["ok"] else f"  {row['id']}: {row['error'][:120]}"), flush=True)

    room = SCRIPT_MAX - len(part_script([], args.model, args.effort).encode())
    too_big = [j for j in todo if entry_bytes(args.chunk, j["prompt"]) > room]
    for j in too_big:
        record({"id": j["id"], "ok": False, "attempts": 0, "s": 0,
                "error": f"prompt of {len(j['prompt'].encode())} bytes is over a workflow script's limit: use claude_pool.py"})
    todo = [j for j in todo if j not in too_big]
    publish("claude", args.prompts, args.model, lambda: {
        "total": len(done) + total, "base": len(done), "done": len(done) + n[0],
        "failed": failed[0], "inflight": inflight[0]})
    # SIGTERM (a backgrounded fleet being stopped) unwinds like an error, so the session is killed.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    stop = False
    with tempfile.TemporaryDirectory(prefix="claude_fleet.") as workdir:
        for i in range(0, len(todo), args.chunk):
            if run_session(todo[i:i + args.chunk], args, workdir, log, record,
                           lambda k: inflight.__setitem__(0, k)):
                print(f"{time.strftime('%T')} out of usage (every account past its cutoff, or the "
                      "session's account at its limit), stopping", flush=True)
                stop = True
                break
    print(f"{n[0]} jobs, {failed[0]} failed -> {out}" + (", stopped at a usage limit" if stop else ""), flush=True)
    raise SystemExit(75 if stop else 1 if failed[0] else 0)


if __name__ == "__main__":
    main()
