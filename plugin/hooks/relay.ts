import type { EngineInterface, On } from 'claude-code'

// The relay agents (agents/astra.md, agents/sol.md) run a task through `codex_ask.sh` and hand
// back what it printed. A Haiku relay that answers the task itself and labels it as the GPT
// model's is the failure this prevents, so the relay's own words never reach its caller:
//
// - A relay's Bash command that runs codex_ask.sh gets an export of AGENT_FLEET_REPLY_DIR, a
//   folder of the relay's own, put in front. codex_ask.sh leaves its whole stdout there once it
//   finishes (the answer, or its CODEX FAILED lines).
// - At the relay's SubagentHandback (how a subagent reports), the caller gets the newest such
//   output since the relay last started codex_ask.sh, in place of the relay's message.
// - While a run moved to the background has not finished, the handback is denied: ending the
//   relay would end the run.
// - With no output, the relay's own one-line `CODEX FAILED:` goes through (its tool call was
//   refused, say); anything else is denied, and after MAX_BLOCKS denies the caller gets a
//   CODEX FAILED line instead.
// - Where a relay ends on text instead (a host without SubagentHandback), SubagentStop checks
//   that text holds the output whole, at most MAX_BLOCKS times.
//
// A relay whose spawn this load did not see (a hot reload mid-run) is let through: with its
// history unknown, a deny would be a guess.

const RELAY = /^agent-fleet:(astra|sol)$/
const MAX_BLOCKS = 3

const PENDING = 'codex_ask.sh is still running in the background. Wait for its completion notification, then hand back.'
const NO_OUTPUT =
  'No codex_ask.sh output reached the agent-fleet plugin, and your own answer is never passed on. Run codex_ask.sh ' +
  'and let it finish, then hand back its stdout. If it cannot run, hand back one line: `CODEX FAILED: <what went wrong>`.'

type Relay = { dir: string; since: number; pending: boolean; blocks: number }

// Per load, by agent id.
const relays = new Map<string, Relay>()

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const failLine = (s: string) => (s.trim().startsWith('CODEX FAILED:') ? (s.trim().split('\n')[0] ?? '') : null)

/** The newest complete codex_ask.sh output in the relay's folder since it last started one. */
async function newestOutput($: EngineInterface, r: Relay): Promise<string | null> {
  if (!(await $.fs.exists(r.dir))) return null
  let best: { t: number; path: string } | null = null
  for (const f of await $.fs.list(r.dir)) {
    if (f.kind !== 'file' || !f.name.endsWith('.out')) continue
    const path = `${r.dir}/${f.name}`
    const t = (await $.fs.stat(path)).mtimeMs
    if (t >= r.since && (!best || t > best.t)) best = { t, path }
  }
  return best && (await $.fs.read(best.path)).toString().trimEnd()
}

export function relayGuard(on: On) {
  // The hud holds the unmatched agent.spawn and tool.call hooks (one per event per plugin), so
  // these match on the relay's type and the tools they follow.
  on('agent.spawn', { subagentType: RELAY }, async ($, e, next) => {
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
    const r = await next(e)
    // A resume (SendMessage) spawns the same id again; it keeps what the relay ran.
    if (r.deny === undefined && r.agentId && !relays.has(r.agentId)) {
      relays.set(r.agentId, { dir: `${tmp}/agent-fleet-relay/${r.agentId}`, since: Infinity, pending: false, blocks: 0 })
    }
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'agent-fleet could not set up its relay check.' }))

  on('tool.call', { tool: /^Bash$/ }, async ($, e, next) => {
    const r = e.agentId ? relays.get(e.agentId) : undefined
    const command = (e as unknown as { command?: unknown }).command
    if (!r || typeof command !== 'string' || !command.includes('codex_ask.sh')) return next(e)
    r.since = Date.now()
    const res = await next({ ...e, command: `export AGENT_FLEET_REPLY_DIR='${r.dir}'; ${command}` } as typeof e)
    r.pending = Boolean((res.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId)
    return res
  })

  on('tool.call', { tool: /^SubagentHandback$/ }, async ($, e, next) => {
    const r = e.agentId ? relays.get(e.agentId) : undefined
    if (!r) return next(e)
    const hand = (message: string) => next({ ...e, message } as typeof e)
    const out = await newestOutput($, r)
    if (out !== null) return hand(out)
    const said = (e as unknown as { message?: unknown }).message
    const failed = typeof said === 'string' ? failLine(said) : null
    if (!r.pending && failed) return hand(failed)
    if (r.blocks >= MAX_BLOCKS) {
      return hand(
        r.pending
          ? 'CODEX FAILED: the relay stopped waiting for codex_ask.sh to finish.'
          : 'CODEX FAILED: no codex_ask.sh output reached the agent-fleet plugin (the relay answered itself, ' +
              'or the codex_ask.sh on PATH predates AGENT_FLEET_REPLY_DIR).',
      )
    }
    r.blocks += 1
    return { deny: r.pending ? PENDING : NO_OUTPUT }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'The agent-fleet relay check failed; hand back again.' }))

  on('classic.SubagentStop', async ($, e, next) => {
    const r = relays.get(e.agent_id)
    const text = e.last_assistant_message
    // Ended on its handback (judged above), or waiting on a background run: nothing to judge.
    if (!r || !text || e.background_tasks?.length) return next(e)
    const out = await newestOutput($, r)
    const ok = out !== null ? norm(text).includes(norm(out)) : !r.pending && failLine(text) === text.trim()
    if (ok || r.blocks >= MAX_BLOCKS) return next(e)
    r.blocks += 1
    const block = out !== null ? "Reply with codex_ask.sh's stdout verbatim, its `[codex_ask …]` line and everything after it." : NO_OUTPUT
    return { ...(await next(e)), block }
  })
}
