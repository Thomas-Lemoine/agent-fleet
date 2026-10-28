#!/usr/bin/env python3
"""Run many independent codex prompts concurrently through `codex app-server`.

    codex_pool.py PROMPTS.jsonl [-o results.jsonl] [--model gpt-6-astra]
                  [--effort high] [--web cached] [--concurrency 50] [--shell]
                  [--home ~/.codex --home ~/.codex-b ...]

PROMPTS.jsonl: one {"id": ..., "prompt": ...} per line, ids unique, plus an
optional "images": [absolute paths], attached after the prompt as local
images, each behind a text line naming its path so the prompt can refer to
it. Results
are appended to results.jsonl as {"id", "ok", "answer" | "error", "attempts",
"s"}; ids already ok there are skipped, so re-running the same command
resumes. Server stderr goes to results.log next to it.

One app-server process per --home (default: every ~/.codex* that exists), all
pulling jobs from one shared queue, at most --concurrency turns in flight per
server. Every pool on this machine also shares ACCOUNT_CAP turns per account
(lock files in ~/.cache/codex-slots), so stacked pools take turns instead of
drawing 429s. Each pool waits with one acquirer per account, so waiting pools
split freed slots about evenly (a newcomer can wait a few turns' worth of
seconds for its first slot while an incumbent sits at the cap), and a pool
alone gets them all. A worker takes a job only once it holds a slot, so a busy
account holds no job the others could run. Each server is restarted every
--chunk jobs because finished ephemeral threads stay resident while the client
is attached and cannot be deleted. An account that hits its usage limit, or
whose login was revoked, drops out and its jobs go back to the queue for the
others; if every account is dry
the leftovers stay unrecorded, so re-running resumes them after the reset.
"At capacity" and HTTP 429 turns are retried with backoff; anything else fails
the job loudly in the results file. Workers are fresh read-only conversations
with no shell unless --shell is given, so put the data in the prompt.

Measured 2026-09-06 (fan-out skill): ~50 MB per server + ~4.5 MB per thread;
above ~50 concurrent per account the websocket path 403s and falls back to
HTTP, so turns still succeed but take 2-5x longer.
"""
import argparse, collections, fcntl, glob, json, os, random, resource, subprocess, sys, threading, time, tomllib

from pool_status import publish

# The real binary, not the ~/.local/bin router: each server gets an explicit CODEX_HOME.
# CODEX_BIN overrides the system codex (e.g. a newer private install a new model needs)
CODEX = os.environ.get("CODEX_BIN") or next(p for p in ("/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex") if os.path.exists(p))

# Turns in flight per account across every pool on this machine. ~50 is the full-speed ceiling
# (fan-out skill, measured 2026-09-06): past it latency grows faster than width (50 at 14 s is
# 3.6 turns/s, 150 at 75 s is 2), and five pools stacked past it drew 429s (2026-10-15).
ACCOUNT_CAP = 50
SLOTS = os.path.expanduser("~/.cache/codex-slots")


def account(home):
    """a for ~/.codex, b for ~/.codex-b, ...: the hud's and the slot files' name for an account."""
    return "a" if os.path.basename(home) == ".codex" else home[-1]


class AccountSlots:
    """This process's handle on one account's machine-wide turn slots: `cap` lock files under
    SLOTS/<account>/, one flock'd per turn in flight. flock belongs to the open file, so the kernel
    drops a dead process's slots and nothing leaks. One per account per pool: pools see each
    other only through the locks."""

    def __init__(self, acct, cap=ACCOUNT_CAP):
        d = os.path.join(SLOTS, acct)
        os.makedirs(d, exist_ok=True)
        self.fds = [os.open(os.path.join(d, f"{i}.lock"), os.O_RDWR | os.O_CREAT, 0o600) for i in range(cap)]
        self.held, self.lock = set(), threading.Lock()

    def acquire(self, give_up):
        """A free slot's index, polling while every slot is held (another pool's turn ending frees
        one); None once give_up() is true after a scan found none. Locking a slot we already hold
        would succeed again (same open file), hence `held`."""
        while True:
            with self.lock:
                for i in random.sample(range(len(self.fds)), len(self.fds)):
                    if i in self.held:
                        continue
                    try:
                        fcntl.flock(self.fds[i], fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        continue
                    self.held.add(i)
                    return i
            if give_up():
                return None
            time.sleep(random.uniform(0.2, 0.6))

    def release(self, i):
        with self.lock:
            fcntl.flock(self.fds[i], fcntl.LOCK_UN)
            self.held.remove(i)


def retryable(err):
    """Errors worth another try after a backoff: a model "at capacity" (congestion, minute to
    minute) and HTTP 429 after codex's own retries (the account's rate limit, say from pools on another
    machine sharing the account, which this machine's slots do not see)."""
    return "capacity" in err.lower() or "429 Too Many Requests" in err or '"httpStatusCode": 429' in err


class AccountDry(Exception):
    """The account behind this server can run no turn (at its usage limit, or
    its login revoked): not this job's fault, so it goes back to the queue for
    another account."""


def mcp_servers(home):
    """Names of the MCP servers configured in this home. They would spawn per
    thread, so the server disables each by name (an empty `mcp_servers={}`
    override is a deep-merge no-op, and naming a server that is not configured
    is a config error)."""
    p = os.path.join(home, "config.toml")
    if not os.path.exists(p):
        return []
    with open(p, "rb") as f:
        return list(tomllib.load(f).get("mcp_servers", {}))


def server_cmd(a, home):
    cmd = [CODEX, "app-server", "--listen", "stdio://",
           # astra/sol/terra are code_mode_only: the code-mode host must stay
           # enabled or they lose every tool, web search included.
           "--enable", "code_mode_host", "--disable", "code_mode_prewarm",
           "--disable", "hooks", "--disable", "shell_snapshot",
           "--disable", "apps", "--disable", "plugins", "--disable", "memories",
           "-c", f'model="{a.model}"', "-c", f'web_search="{a.web}"',
           "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"',
           "-c", "notify=[]", "-c", 'history.persistence="none"',
           "-c", "analytics.enabled=false"]
    if not a.shell:
        cmd += ["--disable", "shell_tool"]
    for s in mcp_servers(home):
        cmd += ["-c", f"mcp_servers.{s}.enabled=false"]
    return cmd


def tree_rss_mb(root):
    pids, frontier = {root}, [root]
    while frontier:
        for c in subprocess.run(["pgrep", "-P", str(frontier.pop())], capture_output=True, text=True).stdout.split():
            if int(c) not in pids:
                pids.add(int(c)); frontier.append(int(c))
    out = subprocess.run(["ps", "-o", "rss=", "-p", ",".join(map(str, pids))], capture_output=True, text=True).stdout.split()
    return sum(map(int, out)) // 1024


class Server:
    """One app-server process: JSON-RPC over stdio, one reader thread.
    Any transport failure marks the server dead and wakes every waiting call."""

    def __init__(self, a, home, log):
        self.home = home
        self.proc = subprocess.Popen(server_cmd(a, home), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=log, text=True, bufsize=1,
                                     env=dict(os.environ, CODEX_HOME=home))
        self.lock = threading.Lock()        # pending / turn_done / msgs
        self.write_lock = threading.Lock()  # stdin only, never held with self.lock, so the reader keeps draining stdout
        self.dead, self.failure = threading.Event(), None
        self.next_id, self.pending = 1, {}
        self.turn_done = {}                        # threadId -> turn dict from turn/completed
        self.msgs = collections.defaultdict(list)  # threadId -> final_answer texts, in order
        threading.Thread(target=self._read, daemon=True).start()
        try:
            r = self.request("initialize", {"clientInfo": {"name": "codex_pool", "title": "codex_pool", "version": "1"}})
            if r["error"]:
                raise RuntimeError(f"initialize failed for {home}: {r['error']}")
            self.notify("initialized")
        except Exception:
            self.stop(); raise

    def _fail(self, reason):
        with self.lock:
            if self.dead.is_set():
                return
            self.failure = reason; self.dead.set()
            for slot in self.pending.values():
                slot["error"] = {"code": -32603, "message": reason}; slot["ev"].set()
        if self.proc.poll() is None:
            self.proc.kill()

    def _read(self):
        try:
            for line in self.proc.stdout:
                try:
                    m = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "id" in m and "method" not in m:            # response to us
                    with self.lock:
                        slot = self.pending.get(m["id"])
                        if slot:
                            slot["result"], slot["error"] = m.get("result"), m.get("error")
                            slot["ev"].set()
                elif "id" in m:                                # server asking us something: decline, off-thread
                    threading.Thread(target=self._send, daemon=True,
                                     args=({"id": m["id"], "error": {"code": -32601, "message": "codex_pool declines"}},)).start()
                else:
                    meth, p = m.get("method", ""), m.get("params", {})
                    with self.lock:
                        if meth == "turn/completed":
                            self.turn_done[p["threadId"]] = p["turn"]
                        elif (meth == "item/completed" and p["item"]["type"] == "agentMessage"
                              and p["item"]["phase"] == "final_answer"):  # other phases are commentary
                            self.msgs[p["threadId"]].append(p["item"]["text"] or "")
        except Exception as e:
            self._fail(f"app-server reader: {type(e).__name__}: {e}")
        finally:
            self._fail("app-server exited")

    def _send(self, o):
        with self.write_lock:
            try:
                self.proc.stdin.write(json.dumps(o) + "\n"); self.proc.stdin.flush()
            except OSError as e:
                self._fail(f"app-server stdin: {type(e).__name__}: {e}"); raise

    def notify(self, method, params=None):
        self._send({"method": method, "params": params or {}})

    def request(self, method, params, timeout=60):
        """One JSON-RPC call; resent with jittered backoff when the server
        rejects it as overloaded (-32001, never enqueued so safe to resend)."""
        deadline = time.monotonic() + timeout
        for bp in range(6):
            r = self._request_once(method, params, deadline)
            if not (r["error"] and r["error"].get("code") == -32001) or bp == 5:
                return r
            self.dead.wait(min(max(0, deadline - time.monotonic()), random.uniform(0, 2 ** (bp + 1))))

    def _request_once(self, method, params, deadline):
        if self.dead.is_set():
            raise ConnectionError(self.failure)
        with self.lock:
            rid = self.next_id; self.next_id += 1
            slot = {"ev": threading.Event(), "result": None, "error": None}
            self.pending[rid] = slot
        try:
            self._send({"id": rid, "method": method, "params": params})
            if not slot["ev"].wait(max(0, deadline - time.monotonic())):
                raise TimeoutError(f"{method} timed out")
            return slot
        finally:
            with self.lock:
                self.pending.pop(rid, None)  # a late reply then finds nothing to mutate

    def _wait_turn(self, tid, timeout):
        deadline = time.monotonic() + timeout
        while True:
            with self.lock:
                if tid in self.turn_done:
                    return self.turn_done[tid]
            if self.dead.is_set():
                raise ConnectionError(self.failure)
            if time.monotonic() >= deadline:
                raise TimeoutError("turn timeout")
            self.dead.wait(0.25)

    def run_turn(self, a, prompt, images=()):
        """One ephemeral thread, one turn, one --timeout for all of it.
        Returns (answer, None) or (None, error); the answer is the last final message."""
        deadline = time.monotonic() + a.timeout
        left = lambda: max(0, deadline - time.monotonic())
        r = self.request("thread/start", {"ephemeral": True, "model": a.model, "cwd": a.cwd,
                                          "approvalPolicy": "never", "sandbox": "read-only"}, timeout=left())
        if r["error"]:
            return None, f"thread/start: {r['error']}"
        tid = r["result"]["thread"]["id"]
        inp = [{"type": "text", "text": prompt}]
        for path in images:
            inp += [{"type": "text", "text": f"[image: {path}]"}, {"type": "localImage", "path": path}]
        r = self.request("turn/start", {"threadId": tid, "effort": a.effort, "input": inp}, timeout=left())
        if r["error"]:
            return None, f"turn/start: {r['error']}"
        turn_id = r["result"]["turn"]["id"]
        try:
            t = self._wait_turn(tid, left())
        except TimeoutError:
            # Free the slot for real: interrupt, then wait for the turn to confirm it stopped.
            # If it does not confirm, the TimeoutError reaches the caller and the job fails.
            self.request("turn/interrupt", {"threadId": tid, "turnId": turn_id}, timeout=10)
            self._wait_turn(tid, 10)
            return None, "turn timeout"
        if t["status"] != "completed":
            # v2 TurnError.codexErrorInfo is a plain string for this variant
            if t["error"].get("codexErrorInfo") == "usageLimitExceeded":
                raise AccountDry(t["error"]["message"])
            # A revoked login fails every turn in seconds ("workspace routing discovery
            # unauthorized (401)"), so left in, its worker would fail the queue while the
            # live accounts are still on their first turns.
            if t["error"].get("codexErrorInfo") == "unauthorized" or "(401)" in t["error"]["message"]:
                raise AccountDry(f"{t['error']['message']} (log in again: CODEX_HOME={self.home} codex login --device-auth)")
            return None, f"turn {t['status']}: {json.dumps(t['error'])[:300]}"
        with self.lock:
            texts = self.msgs.get(tid) or [i["text"] or "" for i in t["items"] if i["type"] == "agentMessage"]
        texts = [x for x in texts if x.strip()]
        if not texts:
            return None, "turn completed with no final answer"
        return texts[-1], None

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill(); self.proc.wait()


def load_done(out_path):
    """ids already ok in the results file. A torn last line (crash mid-append)
    is dropped and the file rewritten newline-terminated; corruption anywhere
    else raises."""
    if not os.path.exists(out_path):
        return set()
    lines = [l for l in open(out_path).read().splitlines() if l.strip()]
    rows = []
    for i, l in enumerate(lines):
        try:
            rows.append(json.loads(l))
        except json.JSONDecodeError:
            if i != len(lines) - 1:
                raise
            print(f"dropping torn last line of {out_path}", file=sys.stderr); lines.pop()
    with open(out_path, "w") as f:
        f.write("".join(l + "\n" for l in lines))
    return {r["id"] for r in rows if r["ok"]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prompts")
    ap.add_argument("-o", "--out", help="results JSONL (default: PROMPTS with .results.jsonl)")
    ap.add_argument("--model", default="gpt-6-astra")
    ap.add_argument("--effort", default="high", help="low|medium|high|xhigh|max (ultra needs collab, not this)")
    ap.add_argument("--web", default="cached", help="disabled|cached|indexed|live")
    ap.add_argument("--home", action="append", help="CODEX_HOME of an account; repeatable (default: every logged-in ~/.codex*)")
    ap.add_argument("--concurrency", type=int, default=50, help="turns in flight per account")
    ap.add_argument("--chunk", type=int, default=100, help="restart each server after this many jobs (>= concurrency)")
    ap.add_argument("--cwd", default=os.getcwd(), help="thread cwd (read-only; never written to)")
    ap.add_argument("--timeout", type=int, default=1800, help="seconds per turn, thread start to final answer")
    ap.add_argument("--shell", action="store_true", help="let workers run read-only shell commands (file audits)")
    ap.add_argument("--retries", type=int, default=5, help="retries per job on 'at capacity' and HTTP 429")
    a = ap.parse_args()
    if min(a.concurrency, a.chunk, a.timeout) <= 0 or a.retries < 0:
        ap.error("concurrency, chunk and timeout must be positive; retries non-negative")
    a.chunk = max(a.chunk, a.concurrency)  # a chunk smaller than the width would cap the width

    # Default: every ~/.codex* that is logged in. An explicit --home must be.
    candidates = a.home or [h for h in glob.glob(os.path.expanduser("~/.codex")) + glob.glob(os.path.expanduser("~/.codex-*"))
                            if os.path.exists(os.path.join(h, "auth.json"))]
    homes = sorted(set(os.path.realpath(os.path.expanduser(h)) for h in candidates))
    if not homes or any(not os.path.exists(os.path.join(h, "auth.json")) for h in homes):
        ap.error(f"no logged-in account homes among {homes or candidates} (codex login with CODEX_HOME set)")

    # A slot file stays open per account per slot: 4 accounts at the cap is 200 fds, near macOS's 256.
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    want = 4096 if hard == resource.RLIM_INFINITY else min(hard, 4096)
    resource.setrlimit(resource.RLIMIT_NOFILE, (max(soft, want), hard))

    out_path = a.out or os.path.splitext(a.prompts)[0] + ".results.jsonl"
    done = load_done(out_path)
    jobs = [j for j in (json.loads(l) for l in open(a.prompts) if l.strip()) if j["id"] not in done]
    if len({j["id"] for j in jobs}) != len(jobs):
        sys.exit("prompt ids must be unique (resume and aggregation key on them)")
    if not jobs:
        print(f"nothing to do: all ids already ok in {out_path}"); return
    out = open(out_path, "a", buffering=1)
    log = open(os.path.splitext(out_path)[0] + ".log", "ab")
    out_lock = threading.Lock()
    print(f"{len(jobs)} jobs ({len(done)} already done) over {len(homes)} account(s), "
          f"{a.concurrency}/account in flight, {a.model} {a.effort} web={a.web}", flush=True)

    stats = collections.Counter(); peak = [0]; t0 = time.time()
    busy = collections.Counter()  # turns in flight per account letter, for the hud
    publish("codex", a.prompts, a.model, lambda: {
        "total": len(done) + len(jobs), "base": len(done), "failed": stats["failed"],
        "done": len(done) + stats["ok"] + stats["failed"], "inflight": dict(busy)})

    def record(row):
        with out_lock:
            out.write(json.dumps(row) + "\n")
            stats["ok" if row["ok"] else "failed"] += 1
            n = stats["ok"] + stats["failed"]
            if n % 10 == 0 or n == len(jobs):
                print(f"  {n}/{len(jobs)} done, {stats['failed']} failed, {time.time() - t0:.0f}s", flush=True)

    # One queue for every account: a fast account takes more, and a job whose
    # account went dry mid-run is put back for the others. A taken job counts
    # as in flight until it has a row or is put back, so the run ends when the
    # queue is empty and nothing is in flight -- never by waiting on a row
    # that will not come. Both are guarded by out_lock.
    todo, inflight = collections.deque(jobs), [0]

    def take():
        """The next queued job, now counted in flight, or None if none is queued."""
        with out_lock:
            if todo:
                inflight[0] += 1
                return todo.popleft()
        return None

    def wait_for_work():
        """Blocks until a job is queued (True), or nothing is queued or in flight
        anywhere (False; a job in flight elsewhere may yet come back to the queue)."""
        while True:
            with out_lock:
                if todo:
                    return True
                if not inflight[0]:
                    return False
            time.sleep(1)

    def give_back(job):
        with out_lock:
            todo.append(job); inflight[0] -= 1

    def solve(job, srv, release, dry):
        """Runs one job to a row (or hands it back when the account is dry), then frees its
        pool permit and account slot through `release`."""
        t_job = time.time()
        with out_lock:
            busy[account(srv.home)] += 1
        try:
            for attempt in range(a.retries + 1):
                try:
                    answer, err = srv.run_turn(a, job["prompt"], job.get("images", ()))
                except AccountDry as e:
                    with out_lock:
                        first = not dry.is_set(); dry.set()
                        todo.append(job)  # inflight drops in the finally below
                    if first:
                        print(f"{srv.home}: {e} -- its jobs go to the other accounts", file=sys.stderr, flush=True)
                    return
                except Exception as e:  # timeouts, dead server
                    answer, err = None, f"{type(e).__name__}: {e}"
                if err is None:
                    row = {"id": job["id"], "ok": True, "attempts": attempt + 1,
                           "s": round(time.time() - t_job, 1), "answer": answer}
                    break
                row = {"id": job["id"], "ok": False, "attempts": attempt + 1,
                       "s": round(time.time() - t_job, 1), "error": err}
                if not retryable(err) or attempt == a.retries:
                    break
                time.sleep(min(60, 2 ** (attempt + 1)) + random.uniform(0, 3))
            record(row)
        finally:
            with out_lock:
                inflight[0] -= 1
                busy[account(srv.home)] -= 1
            release()

    def sample(srv, stop):
        while not stop.is_set():
            rss = tree_rss_mb(srv.proc.pid)
            with out_lock:
                peak[0] = max(peak[0], rss)
            stop.wait(3)

    def account_worker(home):
        """Serves jobs on one account until nothing is left or it goes dry. `job`
        is the one taken but not yet started; it is given back on every way out,
        so a crash here (a thread that cannot start, a stop() that raises) ends
        as a missing row, never a hang."""
        slots, job = AccountSlots(account(home)), None
        try:
            while wait_for_work():
                srv, sem, dry, sampler_stop, ths = None, threading.Semaphore(a.concurrency), threading.Event(), threading.Event(), []
                # Start up to --chunk jobs on one server. Each job is taken only once this
                # pool has a permit and the account a free slot, so a worker waiting on a
                # busy account holds nothing the others could run. Stop early once the
                # account is dry or nothing is queued (a job in flight elsewhere may yet come
                # back: wait_for_work waits for it). The server starts with the first job. A
                # dead server is not checked here: its jobs fail with a row each, as before.
                for _ in range(a.chunk):
                    sem.acquire()
                    slot = slots.acquire(lambda: dry.is_set() or not todo)
                    job = take() if slot is not None else None
                    if job is None:
                        if slot is not None:
                            slots.release(slot)
                        sem.release(); break
                    release = lambda slot=slot, sem=sem: (slots.release(slot), sem.release())
                    if srv is None:
                        try:
                            srv = Server(a, home, log)
                        except Exception as e:  # server would not start: leave this account out, the others carry on
                            release()
                            print(f"{home}: app-server would not start, leaving it out: {type(e).__name__}: {e}",
                                  file=sys.stderr, flush=True)
                            return  # the finally gives the job back
                        sampler = threading.Thread(target=sample, args=(srv, sampler_stop), daemon=True)
                        sampler.start()
                    t = threading.Thread(target=solve, args=(job, srv, release, dry)); t.start()
                    job = None  # solve owns it now; nothing below may give it back
                    ths.append(t)
                    if dry.is_set():
                        break
                for t in ths: t.join()
                if srv is not None:
                    sampler_stop.set(); sampler.join(); srv.stop()
                if dry.is_set():
                    break
        finally:
            if job is not None:
                give_back(job)

    ths = [threading.Thread(target=account_worker, args=(h,)) for h in homes]
    for t in ths: t.start()
    for t in ths: t.join()
    out.close()
    missing = len(jobs) - stats["ok"] - stats["failed"]
    print(f"done: {stats['ok']} ok, {stats['failed']} failed, {missing} missing, {time.time() - t0:.0f}s, "
          f"peak RSS of one server {peak[0]} MB -> {out_path}", flush=True)
    sys.exit(1 if stats["failed"] or missing else 0)


if __name__ == "__main__":
    main()
