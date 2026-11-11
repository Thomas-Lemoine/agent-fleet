"""What the pools and claude-auto share.

    publish("codex", prompts_path, model, lambda: {"total": ..., "base": ..., "done": ...,
                                                    "failed": ..., "inflight": ...})

Live progress of a running pool, for the hud mod: ~/.cache/hud/pools/<pid>.json. A daemon thread
rewrites the file every 2 s from `progress()` until the process exits, which removes it; the hud's
collector drops a file 30 s stale, so a killed pool leaves nothing. `base` is the ids already ok
when the run started (a resumed pool), so the ETA counts this run.

    disk_floor("codex_pool", results_dir)

Exits DISK_EXIT unless DISK_FLOOR_GB are free on the filesystem that holds results_dir.
"""
import atexit
import json
import os
import shutil
import sys
import threading
import time

DIR = os.path.expanduser("~/.cache/hud/pools")
# A full disk cuts a pool's results file short and fails every Bash call a Claude Code session
# makes, so a pool or session refuses to start with less than this free where it writes.
DISK_FLOOR_GB = 5
DISK_EXIT = 73  # sysexits' EX_CANTCREAT: a pool tells claude-auto's refusal from a failed job by it


def disk_floor(tool, path):
    """Exits DISK_EXIT, with one line on stderr naming the free space and `path`, when its
    filesystem has less than DISK_FLOOR_GB free. Deletes nothing."""
    free = shutil.disk_usage(path).free / 1e9
    if free < DISK_FLOOR_GB:
        print(f"{tool}: only {free:.2f} GB free on {os.path.abspath(path)}, under the {DISK_FLOOR_GB} GB "
              "floor: free some space, then re-run", file=sys.stderr, flush=True)
        raise SystemExit(DISK_EXIT)


def publish(kind, prompts, model, progress, every=2.0):
    os.makedirs(DIR, exist_ok=True)
    path = os.path.join(DIR, f"{os.getpid()}.json")
    head = {"pid": os.getpid(), "kind": kind, "model": model, "started": time.time(),
            "name": os.path.splitext(os.path.basename(prompts))[0]}
    stop = threading.Event()

    def loop():
        while not stop.is_set():
            with open(path + ".tmp", "w") as f:
                json.dump({**head, **progress(), "t": time.time()}, f)
            os.replace(path + ".tmp", path)
            stop.wait(every)

    def end():
        stop.set()
        writer.join(5)  # a write in flight would re-create the file after the unlink
        for p in (path, path + ".tmp"):
            if os.path.exists(p):
                os.unlink(p)

    writer = threading.Thread(target=loop, daemon=True)
    writer.start()
    atexit.register(end)
