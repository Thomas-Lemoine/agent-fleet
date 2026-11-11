#!/usr/bin/env python3
"""Self-check for claude_pool's results file: rows land as jobs finish, not in submission order,
and a re-run resumes. A fake claude-auto on PATH stands in for `claude -p`, so it runs anywhere:

    uv run --no-project python tests/test_claude_pool.py
"""
import contextlib, io, json, os, shutil, stat, sys, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin"))
import claude_pool

claude_pool.publish = lambda *a, **k: None  # no hud status files from tests

# Answers the prompt in capitals. "after b" answers only once job b's row is in the results file,
# and fails if it never gets there, so a pool that holds rows back in submission order fails it.
FAKE = r'''#!/usr/bin/env python3
import json, os, sys, time
prompt = sys.stdin.read()
out = os.environ["FAKE_OUT"]
if prompt == "after b":
    for _ in range(100):
        if os.path.exists(out) and '"id": "b"' in open(out).read():
            break
        time.sleep(0.05)
    else:
        print(json.dumps({"type": "result", "is_error": True, "subtype": "error", "result": "b's row was never written"}))
        sys.exit(1)
print(json.dumps({"type": "result", "result": prompt.upper()}))
'''


def run(d, prompts):
    """claude_pool over these (id, prompt)s, resuming what d already holds: (exit code, rows)."""
    path, out = os.path.join(d, "p.jsonl"), os.path.join(d, "p.results.jsonl")
    with open(path, "w") as f:
        f.writelines(json.dumps({"id": i, "prompt": p}) + "\n" for i, p in prompts)
    sys.argv = ["claude_pool", path, "--concurrency", "2"]
    try:
        claude_pool.main()
    except SystemExit as e:
        code = e.code
    return code, [json.loads(x) for x in open(out)]


def test_rows_land_as_jobs_finish():
    with tempfile.TemporaryDirectory() as d:
        bin_ = os.path.join(d, "bin"); os.mkdir(bin_)
        fake = os.path.join(bin_, "claude-auto")
        open(fake, "w").write(FAKE)
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        os.environ["PATH"] = bin_ + os.pathsep + os.environ["PATH"]
        os.environ["FAKE_OUT"] = os.path.join(d, "p.results.jsonl")
        # a is submitted first but finishes after b.
        code, rows = run(d, [("a", "after b"), ("b", "x")])
        assert code == 0 and [(r["id"], r["answer"]) for r in rows] == [("b", "X"), ("a", "AFTER B")], rows
        # A re-run runs only the job not yet ok.
        code, rows = run(d, [("a", "after b"), ("b", "x"), ("c", "y")])
        assert code == 0 and [r["id"] for r in rows] == ["b", "a", "c"], rows


def fake_auto(d, script):
    """Puts a claude-auto running this sh script first on PATH."""
    bin_ = os.path.join(d, "bin"); os.mkdir(bin_)
    fake = os.path.join(bin_, "claude-auto")
    open(fake, "w").write("#!/bin/sh\n" + script)
    os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
    os.environ["PATH"] = bin_ + os.pathsep + os.environ["PATH"]


def pool_exit(d, n):
    """claude_pool over n jobs in d: its exit code."""
    path = os.path.join(d, "p.jsonl")
    open(path, "w").writelines(json.dumps({"id": str(i), "prompt": "x"}) + "\n" for i in range(n))
    sys.argv = ["claude_pool", path, "--concurrency", "2"]
    try:
        claude_pool.main()
    except SystemExit as e:
        return e.code


def test_full_disk_refuses_to_start():
    # Under 5 GB free where the results go: the pool exits 73 with one line naming the space and the
    # path, and no job runs (this claude-auto records that it ran).
    real, err = shutil.disk_usage, io.StringIO()
    shutil.disk_usage = lambda p: real(p)._replace(free=4_500_000_000)
    try:
        with tempfile.TemporaryDirectory() as d, contextlib.redirect_stderr(err):
            fake_auto(d, f"touch {d}/ran\n")
            assert pool_exit(d, 1) == 73
            assert sorted(os.listdir(d)) == ["bin", "p.jsonl"], os.listdir(d)
            assert f"claude_pool: only 4.50 GB free on {d}, under the 5 GB floor" in err.getvalue(), err.getvalue()
    finally:
        shutil.disk_usage = real
    # The disk crosses the floor mid-run: claude-auto refuses the jobs, and the pool stops (exit 73)
    # with them unrecorded instead of failing every one.
    with tempfile.TemporaryDirectory() as d:
        fake_auto(d, "echo 'claude-auto: only 4.90 GB free on /x, under the 5 GB floor' >&2; exit 73\n")
        assert pool_exit(d, 20) == 73
        assert not os.path.exists(os.path.join(d, "p.results.jsonl"))


if __name__ == "__main__":
    test_rows_land_as_jobs_finish()
    test_full_disk_refuses_to_start()
    print("ok")
