#!/usr/bin/env python3
"""One snapshot of accounts, machines and fan-outs for the agent-fleet plugin's hud.

    collect.py [--ttl S] [--remote HOST] [--archive REMOTE]
        refresh ~/.cache/hud/snapshot-v3.json unless it is under S seconds old; HOST is an ssh
        host shown as a second machine, REMOTE an sftp rclone remote whose free space is shown
    collect.py --machine
        print this machine's stats as one JSON line (the remote half, run over ssh)

Every Claude session's hud calls this on a timer, so it must be cheap and idempotent: a flock
lets one collector run at a time and the TTL check makes the rest exit at once, so N sessions
cost one collection per TTL. Nothing here spends quota or starts a model. Claude usage is the
newest of the rate limits each live session's hud measures (in its session file) and the
usage-probe.json that agent-fleet's claude-usage leaves; codex usage is agent-fleet's
codex-usage, read every CODEX_EVERY. The remote half is this same file piped to `python3 -`
over a multiplexed ssh connection, so the remote needs no deploy and the connection costs one
handshake per 10 minutes.

Pools publish live progress to ~/.cache/hud/pools/<pid>.json (agent-fleet's bin/pool_status.py),
and each hud mod its session's subagents to ~/.cache/hud/sessions/<id>.json (headless runs too,
once they start agents: a `claude -p` running a Workflow is one process holding a whole fleet).

Ghostty tabs: when one tab splits into several Claude sessions, only one of them (the tallest)
needs the hud, so the snapshot lists the others as `muted`. Ghostty's AppleScript names each
tab's terminals by title, and a session's title is the newest custom or AI title in its transcript.
"""
import argparse
import fcntl
import glob
import json
import os
import re
import resource
import subprocess
import sys
import threading
import time

HOME = os.path.expanduser("~")
DIR = os.path.join(HOME, ".cache", "hud")
# Renamed whenever its format changes: a session that hot-reloads a new mod must never parse the
# file an old collector wrote moments before.
SNAPSHOT = os.path.join(DIR, "snapshot-v3.json")
HISTORY = 90  # samples kept per machine for the sparklines (~15 min at the 10 s TTL)
SESSION_STALE = 120  # a session file not rewritten for this long is a session that is gone
ARCHIVE_EVERY = 3600  # an archive's free space barely moves: one `rclone about` an hour
ARCHIVE_RETRY = 300  # after a failure (say, the first collection after wake, before Wi-Fi)
CODEX_EVERY = 120  # codex-usage: one rate-limit read per account, ~1 s for four
GHOSTTY_EVERY = 30  # splits change rarely: Ghostty's AppleScript (~0.5 s wall, 0.1 s cpu) twice a minute
GHOSTTY_STALE = 90  # a reading older than this (no Ghostty collector since) mutes nothing
LOCAL = "mac" if sys.platform == "darwin" else "local"  # this machine's name in the hud


def run(argv, timeout=10):
    """argv's stdout; a non-zero exit raises with the last line of its stderr."""
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError((p.stderr.strip().splitlines() or [f"exit {p.returncode}"])[-1][:120])
    return p.stdout


def claude_acct(env_dir):
    """A for ~/.claude (CLAUDE_CONFIG_DIR unset), B for ~/.claude-b, ... By basename: a home
    may be spelled through the dotfiles checkout it links to."""
    base = os.path.basename((env_dir or ".claude").rstrip("/"))
    return "A" if base == ".claude" else base[-1].upper()


def codex_acct(home):
    """a for ~/.codex (CODEX_HOME unset), b for ~/.codex-b, ... (pool_status.py letters alike)."""
    base = os.path.basename((home or ".codex").rstrip("/"))
    return "a" if base == ".codex" else base[-1]


def processes():
    """(pid, ppid, rss_kb, pcpu, argv0 basename, command line with its environment) per process.

    The environment is what attributes a claude or codex process to an account. macOS appends
    it to the command (`ps -E`); Linux has it in /proc/<pid>/environ, read only for the two
    programs that matter.
    """
    darwin = sys.platform == "darwin"
    out = run(["ps", "-Eww", "-axo", "pid=,ppid=,rss=,pcpu=,command="] if darwin
              else ["ps", "-eww", "-o", "pid=,ppid=,rss=,pcpu=,args="])
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid, ppid, rss, pcpu, cmd = int(parts[0]), int(parts[1]), int(parts[2]), float(parts[3]), parts[4]
        name = os.path.basename(cmd.split(" ", 1)[0])
        if not darwin and name in ("claude", "codex"):
            try:
                with open(f"/proc/{pid}/environ", "rb") as f:
                    cmd += " " + f.read().replace(b"\0", b" ").decode(errors="replace")
            except OSError:
                continue  # exited between ps and here
        rows.append((pid, ppid, rss, pcpu, name, cmd))
    return rows


def cpu_busy_linux():
    """Busy % of all cores over a quarter second (ps %cpu is a lifetime average on Linux)."""
    def sample():
        with open("/proc/stat") as f:
            v = [int(x) for x in f.readline().split()[1:]]
        return sum(v), v[3] + v[4]  # total, idle + iowait
    t0, i0 = sample()
    time.sleep(0.25)
    t1, i1 = sample()
    return 100 * (1 - (i1 - i0) / max(1, t1 - t0))


def memory():
    """(used %, total GB, swap used GB). macOS 'used' is 100 - memory_pressure's free
    percentage, the number macOS itself acts on; Linux uses MemAvailable."""
    if sys.platform == "darwin":
        free = int(re.search(r"free percentage: (\d+)%", run(["memory_pressure"])).group(1))
        total = int(run(["sysctl", "-n", "hw.memsize"])) / 2**30
        swap = re.search(r"used = ([\d.]+)M", run(["sysctl", "-n", "vm.swapusage"]))
        return 100 - free, total, float(swap.group(1)) / 1024 if swap else 0.0
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":")
            info[k] = int(v.split()[0])
    return (100 * (1 - info["MemAvailable"] / info["MemTotal"]), info["MemTotal"] / 2**20,
            (info["SwapTotal"] - info["SwapFree"]) / 2**20)


def disk():
    """[free GB, total GB] of the volume holding the user's files (macOS: the Data volume)."""
    st = os.statvfs("/System/Volumes/Data" if sys.platform == "darwin" else "/")
    return [round(st.f_bavail * st.f_frsize / 2**30, 1), round(st.f_blocks * st.f_frsize / 2**30)]


def pools():
    """Running pools' progress files. A pool rewrites its file every 2 s, so one 30 s stale is a
    pool that died without its atexit (SIGKILL), whatever process now holds its pid: it goes."""
    live = []
    for path in glob.glob(os.path.join(DIR, "pools", "*.json*")):
        try:
            if time.time() - os.path.getmtime(path) > 30:
                os.unlink(path)
            elif path.endswith(".json"):
                with open(path) as f:
                    live.append(json.load(f))
        except (OSError, ValueError):
            pass  # gone or mid-rename this time; the next collection gets it
    return live


def machine():
    procs = processes()
    live_pools = pools()
    # A claude pool's workers are its children (claude-auto execs claude), and its in-flight count,
    # rewritten every 2 s, is theirs: ps here catches a 10 s Haiku job only by luck.
    pooled = {p["pid"] for p in live_pools if p["kind"] == "claude"}
    ncpu = os.cpu_count()
    claude, codex, rss = {}, {}, 0
    for pid, ppid, kb, pcpu, name, cmd in procs:
        if name == "claude":
            m = re.search(r"CLAUDE_CONFIG_DIR=(\S+)", cmd)
            a = claude.setdefault(claude_acct(m and m.group(1)), {"live": 0, "headless": 0})
            if not re.search(r" (-p|--print)( |$)", cmd):
                a["live"] += 1
            elif ppid not in pooled:
                a["headless"] += 1
            rss += kb
        elif name == "codex":
            m = re.search(r"CODEX_HOME=(\S+)", cmd)
            k = codex_acct(m and m.group(1))
            codex[k] = codex.get(k, 0) + 1
            rss += kb
    cpu = cpu_busy_linux() if sys.platform != "darwin" else min(100.0, sum(p[3] for p in procs) / ncpu)
    mem, mem_total, swap = memory()
    return {"t": time.time(), "ncpu": ncpu, "load": round(os.getloadavg()[0], 2), "cpu": round(cpu, 1),
            "mem": round(mem, 1), "mem_total": round(mem_total, 1), "swap": round(swap, 2),
            "agents_gb": round(rss / 2**20, 2), "disk": disk(), "claude": claude, "codex": codex,
            "pools": live_pools}


def remote_machine(host):
    with open(__file__) as f:
        src = f.read()
    ssh = ["ssh", "-o", "ControlMaster=auto", "-o", f"ControlPath={HOME}/.ssh/cm-hud-%C",
           "-o", "ControlPersist=10m", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host]
    try:
        p = subprocess.run(ssh + ["python3", "-", "--machine"], input=src, capture_output=True,
                           text=True, timeout=15)
        if p.returncode != 0:
            return {"error": (p.stderr.strip().splitlines() or [f"ssh exit {p.returncode}"])[-1][:120]}
        return json.loads(p.stdout.strip().splitlines()[-1])
    except subprocess.TimeoutExpired:
        return {"error": "ssh timed out"}
    except Exception as e:  # the remote shows as unreachable, with why, rather than vanishing
        return {"error": f"{type(e).__name__}: {e}"[:120]}


def claude_usage(prev, beats):
    """Per account, the newest of: the last snapshot's reading (so an account keeps its reading
    after its sessions end), claude-usage's usage-probe.json (the only one with the Fable week),
    and the rate limits a live session's hud measured (near real time for accounts in use)."""
    out = {acct: dict(u) for acct, u in prev.items()}
    for home in [f"{HOME}/.claude"] + sorted(glob.glob(f"{HOME}/.claude-?")):
        acct = claude_acct(home)
        # Rewritten in place (write_text), so a read can land mid-write: skip that reading this
        # time rather than fail the whole snapshot.
        try:
            with open(f"{home}/usage-probe.json") as f:
                p = json.load(f)
        except (FileNotFoundError, ValueError):
            continue
        if p["t"] > out.get(acct, {}).get("t", 0):
            out[acct] = {k: p[k] for k in ("t", "five", "five_reset", "week", "week_reset", "fable")}
    for b in beats:
        lim = b.get("limits")
        if lim and lim["t"] > out.get(b["acct"], {}).get("t", 0):
            out[b["acct"]] = {**out.get(b["acct"], {}), **lim}  # keeps a probe's Fable week
    return dict(sorted(out.items()))


def codex_usage():
    """The weekly window of every codex account, by agent-fleet's codex-usage (no model call)."""
    out, now = {}, time.time()
    for line in run(["codex-usage", "--porcelain"], timeout=30).splitlines():
        home, used, resets = line.split()
        out[codex_acct(home)] = {"t": now, "week": int(used), "week_reset": int(resets)}
    return dict(sorted(out.items()))


def sessions():
    """Live hud sessions (each mod rewrites its file every 30 s and on every subagent change)."""
    live, now = [], time.time()
    for path in glob.glob(os.path.join(DIR, "sessions", "*.json")):
        try:
            age = now - os.path.getmtime(path)
            if age > 86400:
                os.unlink(path)
            elif age < SESSION_STALE:
                with open(path) as f:
                    beat = json.load(f)
                if beat["t"]:  # 0: the session ended
                    live.append(beat)
        except (OSError, ValueError):
            pass
    return live


def archive(name):
    """Free and total GB behind the rclone remote `name` (`rclone about`; not every backend
    reports them)."""
    a = json.loads(run(["rclone", "about", f"{name}:", "--json"], timeout=30))
    return {"t": time.time(), "name": name, "free": round(a["free"] / 2**30), "total": round(a["total"] / 2**30)}


GHOSTTY = """
if application "Ghostty" is running then
  set sep to tab -- inside the tell block `tab` is Ghostty's tab class
  tell application "Ghostty"
    set out to ""
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in terminals of t
          set out to out & (id of t) & sep & (name of s) & linefeed
        end repeat
      end repeat
    end repeat
    return out
  end tell
end if
"""


def ghostty_tabs():
    """Ghostty's split tabs as lists of terminal titles, glyph stripped (`✳ Fix x` is `Fix x`).
    Only a collector Ghostty launched asks: from another terminal (VS Code) the AppleScript would
    raise a macOS automation prompt, so that one reuses the last reading."""
    if os.environ.get("TERM_PROGRAM") != "ghostty":
        return None
    tabs = {}
    for line in run(["osascript", "-e", GHOSTTY]).splitlines():
        tab, _, name = line.partition("\t")
        if len(name) > 2 and name[1] == " " and not name[0].isalnum():
            name = name[2:]
        tabs.setdefault(tab, []).append(name)
    return {"t": time.time(), "tabs": [names for names in tabs.values() if len(names) > 1]}


def title(beat):
    """The session's title as its terminal shows it: its newest /rename, else its newest AI title.
    Both are rewritten into the transcript every few turns, so its tail has them."""
    home = f"{HOME}/.claude" if beat["acct"] == "A" else f"{HOME}/.claude-{beat['acct'].lower()}"
    paths = glob.glob(f"{home}/projects/*/{beat['id']}.jsonl")
    try:
        with open(paths[0], "rb") as f:
            f.seek(max(0, os.path.getsize(paths[0]) - 262144))
            tail = f.read().decode(errors="replace")
    except (IndexError, OSError):
        return None  # no transcript yet, or it moved since the glob
    for key in ("customTitle", "aiTitle"):
        found = re.findall(rf'"{key}":("(?:[^"\\]|\\.)*")', tail)
        if found:
            return json.loads(found[-1])
    return None


def muted(beats, tabs):
    """Ids of the sessions that share a Ghostty tab with a taller one (ties: the first terminal
    keeps it). A title two sessions share mutes neither: which pane is which is unknown."""
    by_title = {}
    for b in beats:
        if not b.get("headless"):
            by_title.setdefault(title(b), []).append(b)
    out = []
    for names in tabs:
        here = [by_title[n][0] for n in names if len(by_title.get(n, [])) == 1]
        if len(here) > 1:
            keep = max(here, key=lambda b: b.get("rows", 0))  # max keeps the first of equals
            out += [b["id"] for b in here if b is not keep]
    return out


def collect(prev, remote, archive_name):
    t0, c0 = time.time(), (resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN))
    machines, side = {}, {}
    # The slow reads (ssh to the remote, the archive, codex-usage, Ghostty's AppleScript) run
    # beside this machine's own, each in a thread.
    def reading(key, f, *args):
        """A side reading; a failure is kept with its time and why, so it waits its turn to retry."""
        try:
            side[key] = f(*args)
        except Exception as e:
            side[key] = {"t": time.time(), "error": f"{type(e).__name__}: {e}"[:120]}

    jobs = {}
    if remote:
        jobs["remote"] = lambda: machines.__setitem__(remote, remote_machine(remote))
    arch = prev.get("archive") or {}
    if archive_name and (arch.get("name", archive_name) != archive_name
                         or time.time() - arch.get("t", 0) > (ARCHIVE_RETRY if "error" in arch else ARCHIVE_EVERY)):
        jobs["archive"] = lambda: reading("archive", archive, archive_name)
    if time.time() - (prev.get("codex_read") or {}).get("t", 0) > CODEX_EVERY:
        jobs["codex"] = lambda: reading("codex", codex_usage)
    if sys.platform == "darwin" and time.time() - (prev.get("ghostty") or {}).get("t", 0) > GHOSTTY_EVERY:
        jobs["ghostty"] = lambda: reading("ghostty", ghostty_tabs)
    threads = [threading.Thread(target=f) for f in jobs.values()]
    for th in threads:
        th.start()
    here = machine()
    for th in threads:
        th.join()
    # This machine first, whichever thread finished first: readers take the first as local.
    machines = {LOCAL: here, **machines}
    # A failed codex-usage keeps the last accounts and says why; a success records when.
    got = side.get("codex")
    if got is None:
        codex, codex_read = prev.get("codex", {}), prev.get("codex_read")
    elif "error" in got:
        codex, codex_read = prev.get("codex", {}), got
    else:
        codex, codex_read = got, {"t": time.time()}
    hist = prev.get("hist", {})
    for name, m in machines.items():
        if "error" not in m:
            hist[name] = (hist.get(name, []) + [[round(m["t"]), m["cpu"], m["mem"]]])[-HISTORY:]
    cpu = sum(r.ru_utime + r.ru_stime for r in (resource.getrusage(resource.RUSAGE_SELF),
                                                  resource.getrusage(resource.RUSAGE_CHILDREN)))
    cpu -= sum(r.ru_utime + r.ru_stime for r in c0)
    beats = sessions()
    # A fleet's own `claude -p` beats its agents, which count instead of the process.
    for b in beats:
        if b.get("headless") and b["running"] > 0 and here["claude"].get(b["acct"], {}).get("headless"):
            here["claude"][b["acct"]]["headless"] -= 1
    ghostty = side.get("ghostty") or prev.get("ghostty")
    fresh = ghostty and time.time() - ghostty["t"] <= GHOSTTY_STALE
    tabs = ghostty.get("tabs") if fresh else None  # a failed reading has none
    return {"t": time.time(), "machines": machines, "claude": claude_usage(prev.get("claude", {}), beats),
            "codex": codex, "codex_read": codex_read, "sessions": beats, "hist": hist,
            "archive": side.get("archive", prev.get("archive")) if archive_name else None,
            "ghostty": ghostty, "muted": muted(beats, tabs) if tabs else [],
            "cost": {"wall_ms": round(1000 * (time.time() - t0)), "cpu_ms": round(1000 * cpu)}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--machine", action="store_true")
    ap.add_argument("--ttl", type=float, default=8.0)
    ap.add_argument("--remote", default="")
    ap.add_argument("--archive", default="")
    args = ap.parse_args()
    if args.machine:
        print(json.dumps(machine()))
        return
    ttl = args.ttl
    os.makedirs(DIR, exist_ok=True)
    with open(os.path.join(DIR, "collect.lock"), "w") as lock:
        # Another session collecting: wait for it, then the TTL check below finds its snapshot
        # fresh, so a session never spins re-running while one collection is in flight.
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(SNAPSHOT) as f:
                prev = json.load(f)
        except (FileNotFoundError, ValueError):
            prev = {}
        if time.time() - prev.get("t", 0) < ttl:
            return
        snap = collect(prev, args.remote, args.archive)
        tmp = SNAPSHOT + ".tmp"
        with open(tmp, "w") as f:
            json.dump(snap, f, separators=(",", ":"))
        os.replace(tmp, SNAPSHOT)


if __name__ == "__main__":
    main()
