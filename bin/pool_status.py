"""Live progress of a running pool, for the hud mod: ~/.cache/hud/pools/<pid>.json.

    publish("codex", prompts_path, model, lambda: {"total": ..., "base": ..., "done": ...,
                                                    "failed": ..., "inflight": ...})

A daemon thread rewrites the file every 2 s from `progress()` until the process exits, which
removes it; the hud's collector drops a file 30 s stale, so a killed pool leaves nothing.
`base` is the ids already ok when the run started (a resumed pool), so the ETA counts this run.
"""
import atexit
import json
import os
import threading
import time

DIR = os.path.expanduser("~/.cache/hud/pools")


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
