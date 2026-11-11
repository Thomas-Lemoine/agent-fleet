import type { EngineInterface, On } from 'claude-code'

// The relay agents (agents/astra.md, agents/sol.md) run a task through `codex_ask.sh` and hand
// back what it printed. A Haiku relay that answers the task itself and labels it as the GPT
// model's is the failure this prevents, so the relay's own words never reach its caller:
//
// - codex_ask.sh leaves its whole stdout (the answer, or its CODEX FAILED lines) next to its
//   prompt as PROMPT_FILE.out once it finishes, and removes an old one as it starts. The hook
//   reads PROMPT_FILE off the relay's Bash command and runs the command as written: auto mode's
//   review passes the command the model wrote and refuses one a hook rewrote. A codex_ask.sh
//   call whose PROMPT_FILE is not a literal absolute path (`$D/…`, `~/…`, relative after a `cd`)
//   is denied, so the hook always knows where its output lands. Any codex_ask.sh call, denied
//   or not, retires what the relay's earlier calls left.
// - A run that finishes inside its Bash call has its output read right then, before the relay
//   acts again, so a file the relay writes afterwards is never taken for it.
// - At the relay's SubagentHandback (how a subagent reports), the caller gets that output in
//   place of the relay's message. For a run moved to the background, it is the newest
//   PROMPT_FILE.out written since the relay started it; until one appears the handback is
//   denied, since ending the relay would end the run.
// - With no output, the relay's own one-line `CODEX FAILED:` goes through (its tool call was
//   refused, say); anything else is denied, and after MAX_BLOCKS denies the caller gets a
//   CODEX FAILED line instead.
// - Where a relay ends on text instead (a host without SubagentHandback), SubagentStop checks
//   that text holds the output whole, at most MAX_BLOCKS times.
//
// Left open: a relay could write PROMPT_FILE.out itself, after its run in the same command or
// over a backgrounded run's. That is forging a result on purpose, not the substitution this
// guards against, and a check on the file's content could be forged the same way. A run the
// relay backgrounds in the shell (`… &`) is read before it ends and comes to nothing: fail closed.
//
// A relay whose spawn this load did not see (a hot reload mid-run) is let through: with its
// history unknown, a deny would be a guess.

const RELAY = /^agent-fleet:(astra|sol)$/
const MAX_BLOCKS = 3

// A `codex_ask.sh MODEL EFFORT PROMPT_FILE` call where a command starts (after `;`, `&&`, `|`,
// `(`, a newline, `VAR=x`, `timeout N` …), so `ls codex_ask.sh a b c` is none; group 1 is
// PROMPT_FILE as written.
const CALL =
  /(?:^|[;&|(`\n])\s*(?:\w+=\S*\s+|(?:env|nohup|time|command|exec)\s+|timeout\s+\S+\s+)*['"]?(?:[^\s;&|()'"]*\/)?codex_ask\.sh['"]?[ \t]+[^\s;&|]+[ \t]+[^\s;&|]+[ \t]+([^\s;&|<>()]+)/g
// A literal absolute path, bare or quoted, with nothing the shell would expand.
const LITERAL = /^(?:'(\/[^']*)'|"(\/[^"$`\\]*)"|(\/[\w./@%+=:,-]*))$/

const badPrompt = (word: string) =>
  `agent-fleet needs codex_ask.sh's PROMPT_FILE as a literal absolute path, and \`${word}\` is not one. Write it ` +
  'out as `mktemp -d` printed it, with no $VARIABLE, ~ or cd: `codex_ask.sh MODEL EFFORT /tmp/tmp.Ab12/prompt.md`.'
const PENDING = 'codex_ask.sh is still running in the background. Wait for its completion notification, then hand back.'
const NO_OUTPUT =
  'No codex_ask.sh output reached the agent-fleet plugin, and your own answer is never passed on. Run codex_ask.sh ' +
  'and let it finish, then hand back its stdout. If it cannot run, hand back one line: `CODEX FAILED: <what went wrong>`.'

type Relay = {
  prompts: string[] // the PROMPT_FILEs of the codex_ask.sh call it made last
  since: number // when it made that call
  pending: boolean // that call went to the background
  output: string | null // what that call left, read as it finished; unread while pending
  blocks: number
}

// Per load, by agent id.
const relays = new Map<string, Relay>()

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const failLine = (s: string) => (s.trim().startsWith('CODEX FAILED:') ? (s.trim().split('\n')[0] ?? '') : null)
const literal = (word: string) => {
  const m = LITERAL.exec(word)
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null
}

/** The newest PROMPT_FILE.out of the relay's last codex_ask.sh call, written since it made it. */
async function newestOutput($: EngineInterface, r: Relay): Promise<string | null> {
  let best: { t: number; path: string } | null = null
  for (const p of r.prompts) {
    const path = `${p}.out`
    const t = (await $.fs.stat(path).catch(() => null))?.mtimeMs
    if (t !== undefined && t >= r.since && (!best || t > best.t)) best = { t, path }
  }
  return best && (await $.fs.read(best.path)).toString().trimEnd()
}

/** What the relay's last codex_ask.sh call left: as read when it finished, or, for a run in the
 * background, as it stands now. */
const outputOf = ($: EngineInterface, r: Relay) => (r.pending ? newestOutput($, r) : Promise.resolve(r.output))

export function relayGuard(on: On) {
  // The hud holds the unmatched agent.spawn and tool.call hooks (one per event per plugin), so
  // these match on the relay's type and the tools they follow.
  on('agent.spawn', { subagentType: RELAY }, async ($, e, next) => {
    const r = await next(e)
    // A resume (SendMessage) spawns the same id again; it keeps what the relay ran.
    if (r.deny === undefined && r.agentId && !relays.has(r.agentId)) {
      relays.set(r.agentId, { prompts: [], since: 0, pending: false, output: null, blocks: 0 })
    }
    return r
  })

  on('tool.call', { tool: /^Bash$/ }, async ($, e, next) => {
    const r = e.agentId ? relays.get(e.agentId) : undefined
    if (!r || e.tool !== 'Bash') return next(e)
    const words = [...e.command.matchAll(CALL)].map(m => m[1] ?? '')
    if (!words.length) return next(e)
    const bad = words.find(w => literal(w) === null)
    r.prompts = bad === undefined ? words.map(w => literal(w) ?? '') : []
    r.since = Date.now()
    r.pending = false
    r.output = null
    if (bad !== undefined) return { deny: badPrompt(bad) }
    r.blocks = 0
    const res = await next(e)
    r.pending = Boolean((res.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId)
    if (!r.pending) r.output = await newestOutput($, r)
    return res
  })

  on('tool.call', { tool: /^SubagentHandback$/ }, async ($, e, next) => {
    const r = e.agentId ? relays.get(e.agentId) : undefined
    if (!r) return next(e)
    const hand = (message: string) => next({ ...e, message } as typeof e)
    const out = await outputOf($, r)
    if (out !== null) return hand(out)
    const said = (e as unknown as { message?: unknown }).message
    const failed = typeof said === 'string' ? failLine(said) : null
    if (!r.pending && failed) return hand(failed)
    if (r.blocks >= MAX_BLOCKS) {
      return hand(
        r.pending
          ? 'CODEX FAILED: the relay stopped waiting for codex_ask.sh to finish.'
          : 'CODEX FAILED: no codex_ask.sh output reached the agent-fleet plugin (the relay answered itself, ' +
              'or the codex_ask.sh on PATH predates PROMPT_FILE.out).',
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
    const out = await outputOf($, r)
    const ok = out !== null ? norm(text).includes(norm(out)) : !r.pending && failLine(text) === text.trim()
    if (ok || r.blocks >= MAX_BLOCKS) return next(e)
    r.blocks += 1
    const block = out !== null ? "Reply with codex_ask.sh's stdout verbatim, its `[codex_ask …]` line and everything after it." : NO_OUTPUT
    return { ...(await next(e)), block }
  })
}
