import type { On } from 'claude-code'

// The relay agents (agents/astra.md, agents/sol.md) run a task through `codex_ask.sh` and hand
// back what it printed. A Haiku relay that answers the task itself and labels it as the GPT
// model's is the failure this prevents, so the relay's own words never reach its caller:
//
// - Every `codex_ask.sh MODEL EFFORT PROMPT_FILE` a relay runs is noted. On success the script
//   leaves its exact stdout in PROMPT_FILE.reply.
// - At the relay's SubagentHandback (how a subagent reports), the caller gets those reply files
//   in place of the relay's message. That holds however the relay waited (a run past the Bash
//   timeout moves to the background) and however much of a long output it read.
// - With no reply file, a `CODEX FAILED:` message goes through as its first line alone. Any
//   other message is denied, so the relay reads why and goes on; after MAX_BLOCKS denies the
//   caller gets a CODEX FAILED line saying so.
//
// A relay that ends on text is sent back to SubagentHandback by the engine itself. A relay whose
// spawn this load did not see (a hot reload mid-run) is let through: with its history unknown, a
// deny would be a guess.

const RELAY = /^agent-fleet:(astra|sol)$/
const MAX_BLOCKS = 3
// The PROMPT_FILE argument of a codex_ask.sh call, quoted or bare.
const PROMPT_ARG = /codex_ask\.sh\s+\S+\s+\S+\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|)]+))/g

type Relay = { prompts: Set<string>; blocks: number }

// Per load, by agent id.
const relays = new Map<string, Relay>()

export function relayGuard(on: On) {
  // The hud holds the unmatched agent.spawn and tool.call hooks (one per event per plugin), so
  // these match on the relay's type and the tools they follow.
  on('agent.spawn', { subagentType: RELAY }, async ($, e, next) => {
    const r = await next(e)
    // A resume (SendMessage) spawns the same id again; it keeps what the relay ran.
    if (r.deny === undefined && r.agentId && !relays.has(r.agentId)) relays.set(r.agentId, { prompts: new Set(), blocks: 0 })
    return r
  })

  on('tool.call', { tool: /^Bash$/ }, async ($, e, next) => {
    const r = e.agentId ? relays.get(e.agentId) : undefined
    const command = (e as unknown as { command?: unknown }).command
    if (r && typeof command === 'string') {
      for (const m of command.matchAll(PROMPT_ARG)) {
        const p = m[1] ?? m[2] ?? m[3]
        if (p) r.prompts.add(p)
      }
    }
    return next(e)
  })

  on('tool.call', { tool: /^SubagentHandback$/ }, async ($, e, next) => {
    const r = e.agentId ? relays.get(e.agentId) : undefined
    if (!r) return next(e)
    const replies: string[] = []
    for (const p of r.prompts) if (await $.fs.exists(`${p}.reply`)) replies.push((await $.fs.read(`${p}.reply`)).toString().trimEnd())
    const hand = (message: string) => next({ ...e, message } as typeof e)
    if (replies.length) return hand(replies.join('\n\n'))
    const said = (e as unknown as { message?: unknown }).message
    const first = typeof said === 'string' ? (said.trim().split('\n')[0] ?? '') : ''
    if (first.startsWith('CODEX FAILED:')) return hand(first)
    if (r.blocks >= MAX_BLOCKS) return hand(`CODEX FAILED: the relay handed back its own answer ${MAX_BLOCKS + 1} times without a codex_ask.sh reply.`)
    r.blocks += 1
    return {
      deny:
        'No codex_ask.sh reply yet, and your own answer is never passed on. Run `codex_ask.sh MODEL EFFORT PROMPT_FILE` ' +
        'with the prompt file\'s full path and let it finish (a run moved to the background ends with a notification), ' +
        'then hand back its stdout. If it failed, hand back one line: `CODEX FAILED: <what went wrong>`.',
    }
  })
}
