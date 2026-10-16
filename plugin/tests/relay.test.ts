import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// The relay check on astra and sol: the caller gets codex_ask.sh's reply file in place of the
// relay's message; without one, only a one-line CODEX FAILED goes through, and anything else is
// sent back three times, then replaced by a CODEX FAILED line.

const REPLY = '[codex_ask model=gpt-6.1-sol effort=high]\nThe bug is in parse(): it drops the last line.'

// SubagentHandback is not among the typed built-in tools, so calls are spelled loosely.
const call = (c: Record<string, unknown>) => c as never
const spawn = (subagentType: string) => ({ subagentType, prompt: 'review parse()', description: 'review' }) as never

/** A session where `files` exist, tool calls answer 'ok', and handbacks echo the message they
 * reached the engine with. */
function setup(on: On, files: Record<string, string>, ids = ['ag1']) {
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: ids[Math.min(n++, ids.length - 1)] }))
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path]! } : { deny: `no ${e.path}` }))
  on('tool.call', (_$, e) => ({ result: {} as never, text: (e as unknown as { message?: string }).message ?? 'ok' }))
}

test('the caller gets the reply file, whatever the relay wrote', async ($, on) => {
  setup(on, { '/t/d/prompt.md.reply': `${REPLY}\n` })
  await $.agent.spawn(spawn('agent-fleet:sol'))
  await $.tool.call(call({ tool: 'Bash', command: "codex_ask.sh gpt-6.1-sol high '/t/d/prompt.md'", agentId: 'ag1' }))
  const r = await $.tool.call(call({ tool: 'SubagentHandback', message: 'CODEX FAILED: timed out. My own analysis: fine.', agentId: 'ag1' }))
  expect(r.deny).toBeUndefined()
  expect(r.text).toBe(REPLY)
})

test('without a reply, CODEX FAILED goes through as one line and anything else is sent back', async ($, on) => {
  setup(on, {}, ['ag1', 'ag2'])
  await $.agent.spawn(spawn('agent-fleet:astra'))
  await $.agent.spawn(spawn('general-purpose'))
  await $.tool.call(call({ tool: 'Bash', command: 'codex_ask.sh gpt-6-astra high /t/d/prompt.md', agentId: 'ag1' }))
  expect((await $.tool.call(call({ tool: 'SubagentHandback', message: 'CODEX FAILED: exit 1\nHere is my take…', agentId: 'ag1' }))).text).toBe('CODEX FAILED: exit 1')
  const own = call({ tool: 'SubagentHandback', message: 'My proof.', agentId: 'ag1' })
  for (let i = 0; i < 3; i++) expect((await $.tool.call(own)).deny).toContain('No codex_ask.sh reply yet')
  expect((await $.tool.call(own)).text).toStartWith('CODEX FAILED: the relay handed back its own answer')
  expect((await $.tool.call(call({ tool: 'SubagentHandback', message: 'My proof.', agentId: 'ag2' }))).text).toBe('My proof.')
})

test('a resumed relay keeps the runs it made', async ($, on) => {
  setup(on, { '/t/d/prompt.md.reply': REPLY })
  await $.agent.spawn(spawn('agent-fleet:sol'))
  await $.tool.call(call({ tool: 'Bash', command: 'codex_ask.sh gpt-6.1-sol high /t/d/prompt.md', agentId: 'ag1' }))
  await $.agent.spawn(spawn('agent-fleet:sol'))
  expect((await $.tool.call(call({ tool: 'SubagentHandback', message: 'resent', agentId: 'ag1' }))).text).toBe(REPLY)
})
