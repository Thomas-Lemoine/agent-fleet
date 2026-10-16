import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The relay check on astra and sol: the caller gets codex_ask.sh's newest output from the
// relay's own folder in place of the relay's message; without one, only a one-line CODEX FAILED
// goes through, and anything else is sent back three times, then replaced by a CODEX FAILED line.

const REPLY = '[codex_ask model=gpt-6.1-sol effort=high]\nThe bug is in parse(): it drops the last line.'
const DIR = '/tmp/agent-fleet-relay/ag1'

// SubagentHandback is not among the typed built-in tools, so calls are spelled loosely.
const call = (c: Record<string, unknown>) => c as never
const spawn = (subagentType: string) => ({ subagentType, prompt: 'review parse()', description: 'review' }) as never
const ask = (agentId = 'ag1') => call({ tool: 'Bash', command: 'codex_ask.sh gpt-6.1-sol high /t/d/prompt.md', agentId })
const handback = (message: string, agentId = 'ag1') => call({ tool: 'SubagentHandback', message, agentId })

/** A session whose fs holds `files` (path → text and mtime), where a Bash call answers with its
 * command (backgrounded when `background`) and a handback with the message it reached. */
function setup(on: On, files: Record<string, { text: string; t: number }>, opts: { ids?: string[]; background?: boolean } = {}) {
  const ids = opts.ids ?? ['ag1']
  let n = 0
  mock.env(on, { TMPDIR: '/tmp/' })
  on('agent.spawn', () => ({ model: 'haiku', agentId: ids[Math.min(n++, ids.length - 1)] }))
  on('fs.exists', (_$, e) => ({ value: Object.keys(files).some(p => p.startsWith(e.path)) }))
  on('fs.list', (_$, e) => ({
    value: Object.keys(files).filter(p => p.startsWith(`${e.path}/`)).map(p => ({ name: p.split('/').pop()!, kind: 'file' as const })) as never,
  }))
  on('fs.stat', (_$, e) => ({ value: { kind: 'file', size: 1, mtimeMs: files[e.path]!.t, isLink: false } }))
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path]!.text } : { deny: `no ${e.path}` }))
  on('tool.call', (_$, e) => {
    const c = e as unknown as { command?: string; message?: string }
    return { result: (opts.background && c.command ? { backgroundTaskId: 'b1' } : {}) as never, text: c.message ?? c.command ?? 'ok' }
  })
}

test("the caller gets the run's output from the relay's folder, whatever the relay wrote", async ($, on) => {
  setup(on, { [`${DIR}/1.1.out`]: { text: `${REPLY}\n`, t: Date.now() + 60_000 } })
  await $.agent.spawn(spawn('agent-fleet:sol'))
  expect((await $.tool.call(ask())).text).toBe(`export AGENT_FLEET_REPLY_DIR='${DIR}'; codex_ask.sh gpt-6.1-sol high /t/d/prompt.md`)
  const r = await $.tool.call(handback('CODEX FAILED: timed out. My own analysis: fine.'))
  expect(r.deny).toBeUndefined()
  expect(r.text).toBe(REPLY)
})

test('without output, CODEX FAILED goes through as one line and anything else is sent back', async ($, on) => {
  setup(on, { [`${DIR}/0.1.out`]: { text: REPLY, t: 0 } }, { ids: ['ag1', 'ag2'] }) // an output from before this run
  await $.agent.spawn(spawn('agent-fleet:astra'))
  await $.agent.spawn(spawn('general-purpose'))
  await $.tool.call(ask())
  expect((await $.tool.call(handback('CODEX FAILED: exit 1\nHere is my take…'))).text).toBe('CODEX FAILED: exit 1')
  for (let i = 0; i < 3; i++) expect((await $.tool.call(handback('My proof.'))).deny).toContain('No codex_ask.sh output')
  expect((await $.tool.call(handback('My proof.'))).text).toStartWith('CODEX FAILED: no codex_ask.sh output reached')
  expect((await $.tool.call(handback('My proof.', 'ag2'))).text).toBe('My proof.')
})

test('a relay whose run went to the background waits for it, even to say CODEX FAILED', async ($, on) => {
  setup(on, {}, { background: true })
  await $.agent.spawn(spawn('agent-fleet:sol'))
  await $.tool.call(ask())
  expect((await $.tool.call(handback('CODEX FAILED: timed out'))).deny).toContain('still running')
})

test('a resumed relay keeps the runs it made', async ($, on) => {
  setup(on, { [`${DIR}/1.1.out`]: { text: REPLY, t: Date.now() + 60_000 } })
  await $.agent.spawn(spawn('agent-fleet:sol'))
  await $.tool.call(ask())
  await $.agent.spawn(spawn('agent-fleet:sol'))
  expect((await $.tool.call(handback('resent'))).text).toBe(REPLY)
})

test('a relay that ends on text must carry the output whole', async ($, on) => {
  setup(on, { [`${DIR}/1.1.out`]: { text: REPLY, t: Date.now() + 60_000 } })
  on('classic.SubagentStop', () => ({}))
  await $.agent.spawn(spawn('agent-fleet:sol'))
  await $.tool.call(ask())
  const stop = { agent_type: 'agent-fleet:sol', agent_id: 'ag1', agent_transcript_path: '/t/a.jsonl', stop_hook_active: false }
  expect((await $.classic.SubagentStop({ ...stop, last_assistant_message: REPLY.slice(0, 60) })).block).toContain('verbatim')
  expect((await $.classic.SubagentStop({ ...stop, last_assistant_message: REPLY })).block).toBeUndefined()
})
