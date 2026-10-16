import { expect, test } from 'claude-code/testing'

// The relay check on astra and sol: an answer goes through only when it carries a codex_ask.sh
// answer the relay got back, or says CODEX FAILED; otherwise the relay is sent back, three times
// at most.

const ANSWER = 'The bug is in parse(): it drops the last line when the input has no trailing newline.'
const CODEX_OUT = `[codex_ask model=gpt-6.1-sol effort=high]\n${ANSWER}`

// SubagentHandback is not among the typed built-in tools, so calls are spelled loosely.
const call = (c: Record<string, unknown>) => c as never
const spawn = (subagentType: string) => ({ subagentType, prompt: 'review parse()', description: 'review' }) as never

test('a relay that hands back the codex answer, or CODEX FAILED, is let through', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'ag1' }))
  on('tool.call', (_$, e) => ({ result: {} as never, text: e.tool === 'Bash' ? CODEX_OUT : 'ok' }))
  await $.agent.spawn(spawn('agent-fleet:sol'))
  await $.tool.call(call({ tool: 'Bash', command: 'codex_ask.sh gpt-6.1-sol high /tmp/d/prompt.md', agentId: 'ag1' }))
  expect((await $.tool.call(call({ tool: 'SubagentHandback', message: CODEX_OUT, agentId: 'ag1' }))).deny).toBeUndefined()
  expect((await $.tool.call(call({ tool: 'SubagentHandback', message: 'CODEX FAILED: codex exited 1', agentId: 'ag1' }))).deny).toBeUndefined()
})

test('a relay that answers as itself is sent back three times, then let through', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'ag1' }))
  on('tool.call', (_$, e) => ({ result: {} as never, text: e.tool === 'Bash' ? CODEX_OUT : 'ok' }))
  await $.agent.spawn(spawn('agent-fleet:sol'))
  await $.tool.call(call({ tool: 'Bash', command: 'codex_ask.sh gpt-6.1-sol high /tmp/d/prompt.md', agentId: 'ag1' }))
  const own = call({ tool: 'SubagentHandback', message: 'Looks fine to me: parse() handles every case.', agentId: 'ag1' })
  for (let i = 0; i < 3; i++) expect((await $.tool.call(own)).deny).toContain('does not contain its answer')
  expect((await $.tool.call(own)).deny).toBeUndefined()
})

test('a relay that never ran codex_ask.sh is sent back; other agents are not checked', async ($, on) => {
  let next = 'ag1'
  on('agent.spawn', () => ({ model: 'haiku', agentId: next }))
  on('tool.call', () => ({ result: {} as never, text: 'ok' }))
  await $.agent.spawn(spawn('agent-fleet:astra'))
  next = 'ag2'
  await $.agent.spawn(spawn('general-purpose'))
  expect((await $.tool.call(call({ tool: 'SubagentHandback', message: 'My proof.', agentId: 'ag1' }))).deny).toContain('never ran codex_ask.sh')
  expect((await $.tool.call(call({ tool: 'SubagentHandback', message: 'My proof.', agentId: 'ag2' }))).deny).toBeUndefined()
})

test('a relay that ends on its own text is blocked at SubagentStop', async ($, on) => {
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'ag1' }))
  on('classic.SubagentStop', () => ({}))
  await $.agent.spawn(spawn('agent-fleet:sol'))
  const stop = { agent_type: 'agent-fleet:sol', agent_id: 'ag1', agent_transcript_path: '/t/a.jsonl', stop_hook_active: false }
  expect((await $.classic.SubagentStop({ ...stop, last_assistant_message: 'My own answer.' })).block).toContain('never ran codex_ask.sh')
  expect((await $.classic.SubagentStop({ ...stop, last_assistant_message: 'CODEX FAILED: no codex' })).block).toBeUndefined()
})
