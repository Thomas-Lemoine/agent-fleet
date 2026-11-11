import { expect, test } from 'claude-code/testing'

// pkillGuard: a shell command where pkill runs with -f is denied wherever pkill sits in it; one
// that only reads (pgrep -f), kills by name, or hands a mention of pkill -f to grep, sed or git runs.

const DENY = "`pkill -f` matches its own shell and other sessions' processes; record `$!` or a pidfile at launch and kill that PID."
const bash = (command: string) => ({ tool: 'Bash', command }) as never

test('pkill -f is denied wherever it runs, and nothing else is', async ($, on) => {
  on('tool.call', (_$, e) => ({ result: {} as never, text: (e as unknown as { command: string }).command }))
  for (const c of [
    'pkill -f "python serve.py"',
    'pkill -9f alarm',
    'pkill --full alarm',
    'pkill --ful alarm',
    'pkill alarm -f',
    'cd /srv && pkill -f worker',
    'make; sudo -u svc pkill -fe worker',
    "ssh host 'pkill -f worker'",
    'ssh -o "BatchMode=yes" -p 2222 host pkill -f worker',
    'ssh host "tmux kill-session -t a; /usr/bin/pkill -f worker"',
    'timeout -s KILL 5 pkill -f worker',
    'echo "$(pkill -f worker)"',
    "bash -c 'pkill -f worker'",
    'pgrep -f a | xargs -I{} pkill -f {}',
    'if pgrep -f worker; then pkill -f worker; fi',
    'while true; do pkill -f worker; sleep 1; done',
    '! pkill -f worker',
    'pkill -u "$(id -u)" -f worker',
    'pkill \\\n  -f worker',
    `python3 -c 'import subprocess; subprocess.run(["pkill", "-f", "worker"])'`,
    'echo pkill -f worker | sh',
  ]) {
    expect((await $.tool.call(bash(c))).deny).toBe(DENY)
  }
  expect((await $.tool.call({ tool: 'Monitor', command: 'pkill -f worker', description: 'd', timeout_ms: 1000 } as never)).deny).toBe(DENY)
  for (const c of [
    'pgrep -f worker',
    "ssh host 'pgrep -fl worker'",
    'pkill worker',
    'pkill -9 worker',
    'pkill -F /run/worker.pid',
    'pkill -- -f',
    'pkill worker; tail -f log',
    'tail -f log | grep pkill',
    'grep -rn "pkill -f" bin',
    "sed -i 's/pkill -f worker/kill $(cat w.pid)/' run.sh",
    'git commit -m "docs: never ssh in and pkill -f there"',
    `git commit -m "$(cat <<'EOF'\nguards: deny\n\npkill -f matches whole command lines.\nEOF\n)"`,
  ]) {
    expect((await $.tool.call(bash(c))).text).toBe(c)
  }
})
