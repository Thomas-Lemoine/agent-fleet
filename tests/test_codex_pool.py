#!/usr/bin/env python3
"""Self-check for codex_pool's scheduler: a dry account hands its jobs back
and the others finish them, and pools share each account's slots. Fakes the
app-server, so it runs anywhere:

    uv run --no-project python tests/test_codex_pool.py
"""
import json, os, subprocess, sys, tempfile, threading, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin"))
import codex_pool

served, quota_hit = [], threading.Event()


class FakeServer:
    """Stands in for codex_pool.Server: home "dry" is at its usage limit. The
    healthy home serves nothing until the dry one has raised, so the dry
    worker is guaranteed to take a job and give it back."""

    def __init__(self, a, home, log):
        self.home, self.dead = home, threading.Event()
        self.proc = type("P", (), {"pid": os.getpid()})()

    def run_turn(self, a, prompt, images=()):
        if self.home.endswith("dry"):
            quota_hit.set()
            raise codex_pool.QuotaExhausted("You've hit your usage limit.")
        quota_hit.wait(5)
        served.append(prompt)
        return f"echo {prompt}", None

    def stop(self):
        pass


def free_slots(acct):
    """How many of the account's slots no one holds."""
    h, n = codex_pool.AccountSlots(acct), 0
    while h.acquire(lambda: True) is not None:
        n += 1
    return n


def pool(d, homes, n):
    """Runs codex_pool over n one-word jobs on these homes; its result rows."""
    prompts = os.path.join(d, "p.jsonl")
    with open(prompts, "w") as f:
        for i in range(n):
            f.write(json.dumps({"id": str(i), "prompt": str(i)}) + "\n")
    sys.argv = ["codex_pool", prompts, "--concurrency", "3", "--chunk", "4",
                "--retries", "0"] + [x for h in homes for x in ("--home", h)]
    try:
        codex_pool.main()
    except SystemExit as e:
        assert e.code == 0, f"exit {e.code}"
    return [json.loads(l) for l in open(os.path.join(d, "p.results.jsonl"))]


def homes_in(d, *names):
    homes = [os.path.join(d, h) for h in names]
    for h in homes:
        os.mkdir(h); open(os.path.join(h, "auth.json"), "w").close()
    return homes


def test_dry_account_hands_back_its_jobs():
    codex_pool.Server = FakeServer
    codex_pool.tree_rss_mb = lambda pid: 0
    with tempfile.TemporaryDirectory() as d:
        codex_pool.SLOTS = os.path.join(d, "slots")
        rows = pool(d, homes_in(d, "ok", "dry"), 20)
        assert free_slots("k") == free_slots("y") == codex_pool.ACCOUNT_CAP  # every slot released
    assert quota_hit.is_set(), "the dry account never got a job"
    assert sorted(r["id"] for r in rows) == sorted(str(i) for i in range(20)), rows
    assert all(r["ok"] for r in rows), rows
    assert sorted(served) == sorted(str(i) for i in range(20)), served  # the healthy home did every job once


def test_saturated_account_takes_no_jobs():
    """Another pool holds every slot of account x: this pool runs everything on y and exits,
    instead of holding a job while it waits on x."""
    class Server(FakeServer):
        def run_turn(self, a, prompt, *_):
            served_on.append(self.home[-1])
            return f"echo {prompt}", None
    served_on = []
    codex_pool.Server = Server
    codex_pool.tree_rss_mb = lambda pid: 0
    with tempfile.TemporaryDirectory() as d:
        codex_pool.SLOTS = os.path.join(d, "slots")
        other = codex_pool.AccountSlots("x")
        for _ in range(codex_pool.ACCOUNT_CAP):
            assert other.acquire(lambda: True) is not None
        done = []
        t = threading.Thread(target=lambda: done.append(pool(d, homes_in(d, "hx", "hy"), 6)), daemon=True)
        t.start(); t.join(30)
        assert done, "the pool did not finish"
        assert sorted(r["id"] for r in done[0] if r["ok"]) == sorted(str(i) for i in range(6)), done
        assert set(served_on) == {"y"}, served_on
        assert free_slots("y") == codex_pool.ACCOUNT_CAP


def test_slots_are_shared_and_die_with_their_process():
    """Two handles stand for two pools (flock belongs to the open file, so they contend like
    processes): they share the cap, a released slot goes to the one waiting, and a killed
    process's slot frees itself."""
    never = lambda: False

    def after(s):
        deadline = time.time() + s
        return lambda: time.time() > deadline

    with tempfile.TemporaryDirectory() as d:
        codex_pool.SLOTS = d
        a, b = codex_pool.AccountSlots("x", cap=2), codex_pool.AccountSlots("x", cap=2)
        held = [a.acquire(never), a.acquire(never)]
        assert sorted(held) == [0, 1], held
        assert b.acquire(after(1)) is None  # a holds both: b gives up when told to
        got = []
        waiter = threading.Thread(target=lambda: got.append(b.acquire(never)), daemon=True)
        waiter.start(); time.sleep(0.5)
        assert not got  # b is waiting
        a.release(held[0])
        waiter.join(5)
        assert got == [held[0]], got

        here = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin"))
        holder = subprocess.Popen([sys.executable, "-c", (
            f"import sys, threading, time; sys.path.insert(0, {here!r}); import codex_pool as c; "
            f"c.SLOTS = {d!r}; c.AccountSlots('y', cap=1).acquire(lambda: False); "
            "print('held', flush=True); time.sleep(60)")], stdout=subprocess.PIPE, text=True)
        try:
            assert holder.stdout.readline().strip() == "held"
            y = codex_pool.AccountSlots("y", cap=1)
            assert y.acquire(after(1)) is None
        finally:
            holder.kill(); holder.wait()
        assert y.acquire(after(5)) == 0


if __name__ == "__main__":
    test_slots_are_shared_and_die_with_their_process()
    test_dry_account_hands_back_its_jobs()
    test_saturated_account_takes_no_jobs()
    print("ok")
