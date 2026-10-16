import type { EngineInterface, On } from 'claude-code'

// The relay agents (agents/astra.md, agents/sol.md) run a task through `codex_ask.sh` and must
// answer with its stdout, relayed verbatim, or with a `CODEX FAILED:` line. A Haiku relay that
// answers the task itself and labels it as the GPT model's is the failure this catches.
//
// Each relay is followed from its spawn: whether it ran codex_ask.sh, and every `[codex_ask …]`
// result it got back (a Bash result, or TaskOutput's when the call went to the background). Its
// answer is checked where it is given: a SubagentHandback call (how a subagent reports where that
// tool exists) is denied, so the relay reads why and goes on; a final text message is blocked at
// SubagentStop, which re-prompts it. (A SubagentStop block after a SubagentHandback is discarded:
// the turn ended on a tool result.) At most MAX_BLOCKS times per relay, so a stubborn one cannot
// loop. A relay whose spawn this load did not see (a hot reload mid-run) is let through: with
// its history unknown, a deny would be a guess.

const RELAY = /^agent-fleet:(astra|sol)$/
const MAX_BLOCKS = 3
const HEAD = 120 // chars of the codex answer that must appear in the relay's answer

type Relay = { asked: boolean; answers: string[]; blocks: number }

// Per load, by agent id.
const relays = new Map<string, Relay>()

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Why `answer` is not a relayed codex_ask.sh answer, or null when it is. */
function verdict(r: Relay, answer: string): string | null {
  const said = norm(answer)
  if (said.startsWith('CODEX FAILED:')) return null
  if (!r.asked) return "You never ran codex_ask.sh, so this cannot be the model's answer."
  if (!r.answers.length) return "Every codex_ask.sh call failed, so this cannot be the model's answer."
  if (r.answers.some(a => norm(a).slice(0, HEAD) && said.includes(norm(a).slice(0, HEAD)))) return null
  return 'codex_ask.sh succeeded but your answer does not contain its answer.'
}

/** The block or deny text for a relay whose answer failed `why`, counting it; null once the
 * relay has been sent back MAX_BLOCKS times. */
function sendBack(r: Relay, why: string | null): string | null {
  if (why === null || r.blocks >= MAX_BLOCKS) return null
  r.blocks += 1
  return (
    `${why} Reply with the codex_ask.sh stdout verbatim (starting at its \`[codex_ask ...]\` line), ` +
    'or with exactly one line `CODEX FAILED: <what went wrong>`. Never write your own answer to the task.'
  )
}

/** A tool result's text as the model read it; a large output is saved to a file and the result
 * only points at it. */
async function resultText($: EngineInterface, text: string): Promise<string> {
  const saved = /Full output saved to:\s*(\S+)/.exec(text)?.[1]
  return saved ? (await $.fs.read(saved)).toString() : text
}

export function relayGuard(on: On) {
  // The hud holds the unmatched agent.spawn and tool.call hooks (one per event per plugin), so
  // these match on the relay's type and the tools they follow.
  on('agent.spawn', { subagentType: RELAY }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && r.agentId) relays.set(r.agentId, { asked: false, answers: [], blocks: 0 })
    return r
  })

  on('tool.call', { tool: /^SubagentHandback$/ }, async ($, e, next) => {
    const r = e.agentId ? relays.get(e.agentId) : undefined
    if (!r) return next(e)
    const message = (e as unknown as { message?: unknown }).message
    const deny = sendBack(r, verdict(r, typeof message === 'string' ? message : ''))
    return deny === null ? next(e) : { deny }
  })

  on('tool.call', { tool: /^(Bash|TaskOutput)$/ }, async ($, e, next) => {
    const r = e.agentId ? relays.get(e.agentId) : undefined
    if (!r) return next(e)
    const command = (e as unknown as { command?: unknown }).command
    if (typeof command === 'string' && command.includes('codex_ask.sh')) r.asked = true
    const res = await next(e)
    if (typeof res.text === 'string') {
      const text = (await resultText($, res.text)).trimStart()
      if (text.startsWith('[codex_ask ')) r.answers.push(text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '')
    }
    return res
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const r = relays.get(e.agent_id)
    if (!r) return next(e)
    // Ended on a tool (its SubagentHandback, judged above): nothing left to judge.
    const block = e.last_assistant_message ? sendBack(r, verdict(r, e.last_assistant_message)) : null
    if (block === null) {
      relays.delete(e.agent_id)
      return next(e)
    }
    return { ...(await next(e)), block }
  })
}
