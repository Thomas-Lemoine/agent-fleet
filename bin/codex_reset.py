#!/usr/bin/env python3
"""Read an account's rate limits and reset credits over codex app-server;
--redeem consumes the next available "Full reset" credit (starts a fresh
7-day window, so never spend one right before a natural reset).
    usage: codex_reset.py ~/.codex-b [--redeem]"""
import argparse, json, os, sys, uuid, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from codex_pool import Server

ap = argparse.ArgumentParser(); ap.add_argument("home"); ap.add_argument("--redeem", action="store_true")
a = ap.parse_args()
home = os.path.expanduser(a.home)
srv = Server(types.SimpleNamespace(model="gpt-6-luna", web="disabled", shell=False), home, sys.stderr)
try:
    r = srv.request("account/rateLimits/read", {})
    if r["error"]: sys.exit(f"rateLimits/read: {r['error']}")
    res = r["result"]
    rl = res.get("rateLimits") or res
    print(json.dumps({k: rl.get(k) for k in ("primary", "secondary")}, indent=None)[:400])
    rc = res["rateLimitResetCredits"]
    print(f"reset credits available: {rc['availableCount']}",
          [(c["status"], c["expiresAt"]) for c in rc["credits"]])
    if a.redeem:
        r = srv.request("account/rateLimitResetCredit/consume", {"idempotencyKey": str(uuid.uuid4()), "creditId": None})
        print("redeem:", r["result"] if not r["error"] else r["error"])
finally:
    srv.stop()
