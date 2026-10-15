#!/usr/bin/env python3
"""Self-check for claude_fleet's bookkeeping: answers, failed agents, a usage limit and a session
that runs nothing become the right rows and exit codes. A fake claude-auto on PATH stands in for
the session, so it runs anywhere:

    uv run --no-project python tests/test_claude_fleet.py
"""
import json, os, stat, sys, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin"))
import claude_fleet

claude_fleet.publish = lambda *a, **k: None  # no hud status files from tests

# Plays a session: finds the jobs through the scripts the fleet wrote, then journals each agent.
# Prompts: "boom" fails its agent, "noid" fails it before it starts (agentId ""), "slow" writes its
# line in two halves across a poll, "limit" makes the account run out there (a rejected rate limit
# event; "limit5h" a typed one, then a concurrent-request cap refusal), "spent" fails its agent with the CLI's limit message and
# nothing else, "busy" fails it with the cap's words after the account's concurrent-request cap
# refused a request. Afterwards a relaunch
# answers every job again in a second journal, which the fleet must ignore. Each session logs its
# arguments and web search budget to calls.jsonl.
FAKE = r'''#!/usr/bin/env python3
import json, os, re, sys, tempfile, time
with open(os.path.join(os.environ["FAKE_DIR"], "calls.jsonl"), "a") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "searches": os.environ["CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION"]}) + "\n")
if os.environ.get("FAKE_EXIT"):
    sys.exit(int(os.environ["FAKE_EXIT"]))
top = re.search(r"script at (\S+):", sys.stdin.read()).group(1)
parts = json.loads(re.search(r"const PARTS = (.*)\n", open(top).read()).group(1))
jobs = [x for p in parts for x in json.loads(re.search(r"const JOBS = (.*)\n", open(p).read()).group(1))]
say = lambda e: print(json.dumps(e), flush=True)
if os.environ.get("FAKE_NOJOURNAL"):
    say({"type": "result", "result": "I would rather not."})
    sys.exit(0)

def journal():
    wf = tempfile.mkdtemp(dir=os.environ["FAKE_DIR"])
    say({"type": "user", "message": {"content": [{"type": "tool_result", "content": f"Launched\nTranscript dir: {wf}\nRun ID: x"}]}})
    f = open(os.path.join(wf, "journal.jsonl"), "w")
    f.write('{"type":"launched"}\n')
    for k, _ in jobs:
        f.write(json.dumps({"type": "started", "agentId": f"a{k}", "label": str(k)}) + "\n")
    f.flush()
    return f

j, progress = journal(), []
for k, prompt in jobs:
    if prompt in ("limit", "limit5h"):
        say({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected",
             **({"rateLimitType": "five_hour"} if prompt == "limit5h" else {})}})
        if prompt == "limit5h":
            say({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "rateLimitType": "concurrents"}})
        break
    if prompt == "busy":
        say({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "rateLimitType": "concurrents"}})
    if prompt in ("boom", "noid", "spent", "busy"):
        line = {"type": "failed", "agentId": "" if prompt == "noid" else f"a{k}"}
        progress.append({"type": "workflow_agent", "label": str(k), "state": "error",
                         "error": {"boom": "kaboom", "noid": "spawn refused",
                                   "spent": "You've hit your limit · resets 5pm",
                                   "busy": "You've hit your usage limit"}[prompt]})
    else:
        line = {"type": "result", "agentId": f"a{k}", "result": prompt.upper()}
    s = json.dumps(line) + "\n"
    if prompt == "slow":
        j.write(s[:10]); j.flush(); time.sleep(2.5)
        s = s[10:]
    j.write(s); j.flush()
j.close()
again = journal()
for k, _ in jobs:
    again.write(json.dumps({"type": "result", "agentId": f"a{k}", "result": "AGAIN"}) + "\n")
again.close()
summary = os.path.join(os.environ["FAKE_DIR"], f"summary{os.getpid()}.json")
json.dump({"workflowProgress": progress}, open(summary, "w"))
say({"type": "system", "subtype": "task_notification", "output_file": summary})
say({"type": "result", "result": "done"})
'''


def setup(d):
    bin_ = os.path.join(d, "bin"); os.mkdir(bin_)
    fake = os.path.join(bin_, "claude-auto")
    open(fake, "w").write(FAKE)
    os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
    os.environ["PATH"] = bin_ + os.pathsep + os.environ["PATH"]
    os.environ["FAKE_DIR"] = d


def run(d, prompts, *flags):
    """claude_fleet over these (id, prompt)s, resuming what d already holds: (exit code, rows)."""
    path = os.path.join(d, "p.jsonl")
    with open(path, "w") as f:
        f.writelines(json.dumps({"id": i, "prompt": p}) + "\n" for i, p in prompts)
    sys.argv = ["claude_fleet", path, "--chunk", "2", *flags]
    try:
        claude_fleet.main()
    except SystemExit as e:
        code = e.code
    out = os.path.join(d, "p.results.jsonl")
    return code, [json.loads(x) for x in open(out)] if os.path.exists(out) else []


def test_rows_failures_and_limit():
    with tempfile.TemporaryDirectory() as d:
        setup(d)
        # Sessions [1, "b  c"], ["q 1", "q  1"], ["n"]; the runtime would collapse those ids' spaces.
        code, rows = run(d, [(1, "x"), ("b  c", "boom"), ("q 1", "slow"), ("q  1", "y"), ("n", "noid")])
        assert code == 1, code
        assert [r["id"] for r in rows].count(1) == 1 and len(rows) == 5, rows  # one row per job, ids as given
        assert {r["id"]: r["answer"] for r in rows if r["ok"]} == {1: "X", "q 1": "SLOW", "q  1": "Y"}, rows
        errors = {r["id"]: r["error"] for r in rows if not r["ok"]}
        assert errors.keys() == {"b  c", "n"} and "kaboom" in errors["b  c"] and "spawn refused" in errors["n"], errors

        # A re-run retries only what failed; d is answered, the limit strikes at e, and f never runs.
        code, rows = run(d, [(1, "x"), ("b  c", "z"), ("d", "w"), ("e", "limit"), ("f", "v")])
        assert code == 75, code
        assert [(r["id"], r["ok"]) for r in rows[5:]] == [("b  c", True), ("d", True)], rows

        # Out of usage with no rejected event: only the agent's error says so. e (unrecorded at the
        # limit above) is answered now; g gets no row.
        code, rows = run(d, [("e", "x"), ("g", "spent")])
        assert code == 75 and [(r["id"], r["ok"]) for r in rows[7:]] == [("e", True)], (code, rows)


def test_concurrent_cap_is_not_a_usage_limit():
    with tempfile.TemporaryDirectory() as d:
        setup(d)
        # The cap fails a's agent with the CLI's usage-limit words; the fleet records that and
        # goes on to the next session, which answers c.
        code, rows = run(d, [("a", "busy"), ("b", "x"), ("c", "y")])
        assert code == 1, code
        assert sorted((r["id"], r["ok"]) for r in rows) == [("a", False), ("b", True), ("c", True)], rows
        assert "concurrent requests" in rows[1]["error"], rows  # failures are written as a session ends

    # The cap does not hide the account running out in the same session, typed or only in words.
    for out in ("limit5h", "spent"):
        with tempfile.TemporaryDirectory() as d:
            setup(d)
            code, rows = run(d, [("a", "busy"), ("b", out), ("c", "x")])
            assert code == 75 and rows == [], (out, code, rows)


def test_web_tools_and_budget():
    with tempfile.TemporaryDirectory() as d:
        setup(d)
        run(d, [("a", "x"), ("b", "y"), ("c", "z")])
        run(d, [("d", "x"), ("e", "y")], "--web")
        calls = [json.loads(x) for x in open(os.path.join(d, "calls.jsonl"))]
        for flag in ("--tools", "--allowedTools"):  # headless, a tool not allowed is refused
            tools = [c["argv"][c["argv"].index(flag) + 1] for c in calls]
            assert tools == ["Workflow,Read"] * 2 + ["Workflow,Read,WebSearch,WebFetch"], (flag, tools)
        assert [c["searches"] for c in calls] == ["400", "200", "400"], calls  # 200 per job in the session


def test_sessions_that_run_nothing():
    for env, expect in (("FAKE_NOJOURNAL", "ran no agents"), ("FAKE_EXIT", 75)):
        with tempfile.TemporaryDirectory() as d:
            setup(d)
            os.environ[env] = "75" if env == "FAKE_EXIT" else "1"
            try:
                code, rows = run(d, [("a", "x"), ("b", "y")])
            finally:
                del os.environ[env]
            assert rows == [], rows  # nothing recorded: a re-run does it all
            assert code == expect if isinstance(expect, int) else expect in code, code


if __name__ == "__main__":
    test_rows_failures_and_limit()
    test_concurrent_cap_is_not_a_usage_limit()
    test_web_tools_and_budget()
    test_sessions_that_run_nothing()
    print("ok")
