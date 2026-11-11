import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// The relay check on astra and sol: the relay's Bash command runs as written, and the caller gets
// the PROMPT_FILE.out that codex_ask.sh left in place of the relay's message; without one, only a
// one-line CODEX FAILED goes through, and anything else is sent back three times, then replaced
// by a CODEX FAILED line.

const REPLY = '[codex_ask model=gpt-6.1-sol effort=high]\nThe bug is in parse(): it drops the last line.'
const PROMPT = '/t/d/prompt.md'
const OUT = `${PROMPT}.out`
const LATER = () => Date.now() + 60_000

// SubagentHandback is not among the typed built-in tools, so calls are spelled loosely.
const call = (c: Record<string, unknown>) => c as never
const spawn = (subagentType: string) => ({ subagentType, prompt: 'review parse()', description: 'review' }) as never
const bash = (command: string, agentId = 'ag1') => call({ tool: 'Bash', command, agentId })
const ask = (agentId = 'ag1') => bash(`codex_ask.sh gpt-6.1-sol high ${PROMPT}`, agentId)
const handback = (message: string, agentId = 'ag1') => call({ tool: 'SubagentHandback', message, agentId })

type Files = Record<string, { text: string; t: number }>

/** A session whose fs holds `files` (path → text and mtime; the test may change it as it goes),
 * where a Bash call answers with its command (backgrounded when `background`), after `onRun`
 * (what the command leaves behind), and a handback with the message it reached. */
function setup(on: On, files: Files, opts: { ids?: string[]; background?: boolean; onRun?: () => void } = {}) {
  const ids = opts.ids ?? ['ag1']
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: ids[Math.min(n++, ids.length - 1)] }))
  on('fs.stat', (_$, e) =>
    e.path in files ? { value: { kind: 'file', size: 1, mtimeMs: files[e.path]!.t, isLink: false } } : { deny: `ENOENT ${e.path}` },
  )
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path]!.text } : { deny: `ENOENT ${e.path}` }))
  on('tool.call', (_$, e) => {
    const c = e as unknown as { command?: string; message?: string }
    if (c.command) opts.onRun?.()
    return { result: (opts.background && c.command ? { backgroundTaskId: 'b1' } : {}) as never, text: c.message ?? c.command ?? 'ok' }
  })
}

test("the command runs as written, and the caller gets the run's output whatever the relay wrote", async ($, on) => {
  const files: Files = {}
  setup(on, files, { onRun: () => (files[OUT] = { text: `${REPLY}\n`, t: LATER() }) })
  await $.agent.spawn(spawn('agent-fleet:sol'))
  expect((await $.tool.call(ask())).text).toBe(`codex_ask.sh gpt-6.1-sol high ${PROMPT}`)
  await $.tool.call(bash(`ls -l ~/.local/bin/codex_ask.sh ${PROMPT} ${OUT} ${PROMPT}.answer`)) // names it, runs nothing
  const r = await $.tool.call(handback('CODEX FAILED: timed out. My own analysis: fine.'))
  expect(r.deny).toBeUndefined()
  expect(r.text).toBe(REPLY)
})

test('a codex_ask.sh call whose prompt path is not literal and absolute is denied before it runs', async ($, on) => {
  let runs = 0
  setup(on, {}, { onRun: () => runs++ })
  await $.agent.spawn(spawn('agent-fleet:astra'))
  for (const p of ['"$D/prompt.md"', '$D/prompt.md', '~/d/prompt.md', 'prompt.md', '"/t/a b/prompt.md"']) {
    expect((await $.tool.call(bash(`cd /t/d && codex_ask.sh gpt-6-astra high ${p}`))).deny).toContain(`\`${p.split(' ')[0]}\` is not one`)
  }
  expect(runs).toBe(0)
  for (const c of [
    `codex_ask.sh gpt-6-astra high '${PROMPT}' 2>&1 | tail -5`,
    `timeout 900 ~/.local/bin/codex_ask.sh gpt-6-astra high "${PROMPT}"`,
    'which codex_ask.sh',
  ]) {
    expect((await $.tool.call(bash(c))).text).toBe(c)
  }
  expect(runs).toBe(3)
})

test('without output, CODEX FAILED goes through as one line and anything else is sent back', async ($, on) => {
  setup(on, { [OUT]: { text: REPLY, t: 0 } }, { ids: ['ag1', 'ag2'] }) // an output from before this run
  await $.agent.spawn(spawn('agent-fleet:astra'))
  await $.agent.spawn(spawn('general-purpose'))
  await $.tool.call(ask())
  expect((await $.tool.call(handback('CODEX FAILED: exit 1\nHere is my take…'))).text).toBe('CODEX FAILED: exit 1')
  for (let i = 0; i < 3; i++) expect((await $.tool.call(handback('My proof.'))).deny).toContain('No codex_ask.sh output')
  expect((await $.tool.call(handback('My proof.'))).text).toStartWith('CODEX FAILED: no codex_ask.sh output reached')
  expect((await $.tool.call(handback('My proof.', 'ag2'))).text).toBe('My proof.')
})

test('a file written after a finished run is never taken for its output', async ($, on) => {
  const files: Files = {}
  setup(on, files)
  await $.agent.spawn(spawn('agent-fleet:sol'))
  await $.tool.call(ask()) // codex_ask.sh left nothing (killed, say)
  files[OUT] = { text: REPLY, t: LATER() } // the relay's own Write
  expect((await $.tool.call(handback(REPLY))).deny).toContain('No codex_ask.sh output')
})

test('a relay whose run went to the background waits for it, then gets its output', async ($, on) => {
  const files: Files = {}
  setup(on, files, { background: true })
  await $.agent.spawn(spawn('agent-fleet:sol'))
  await $.tool.call(ask())
  expect((await $.tool.call(handback('CODEX FAILED: timed out'))).deny).toContain('still running')
  files[OUT] = { text: REPLY, t: LATER() }
  expect((await $.tool.call(handback('done'))).text).toBe(REPLY)
})

test('a resumed relay keeps the run it made, until its next codex_ask.sh call, even a denied one', async ($, on) => {
  const files: Files = {}
  setup(on, files, { onRun: () => (files[OUT] = { text: REPLY, t: LATER() }) })
  await $.agent.spawn(spawn('agent-fleet:sol'))
  await $.tool.call(ask())
  await $.agent.spawn(spawn('agent-fleet:sol'))
  expect((await $.tool.call(handback('resent'))).text).toBe(REPLY)
  expect((await $.tool.call(bash('codex_ask.sh gpt-6.1-sol high $D/prompt.md'))).deny).toBeDefined()
  expect((await $.tool.call(handback('CODEX FAILED: refused'))).text).toBe('CODEX FAILED: refused')
})

test('a relay that ends on text must carry the output whole', async ($, on) => {
  const files: Files = {}
  setup(on, files, { onRun: () => (files[OUT] = { text: REPLY, t: LATER() }) })
  on('classic.SubagentStop', () => ({}))
  await $.agent.spawn(spawn('agent-fleet:sol'))
  await $.tool.call(ask())
  const stop = { agent_type: 'agent-fleet:sol', agent_id: 'ag1', agent_transcript_path: '/t/a.jsonl', stop_hook_active: false }
  expect((await $.classic.SubagentStop({ ...stop, last_assistant_message: REPLY.slice(0, 60) })).block).toContain('verbatim')
  expect((await $.classic.SubagentStop({ ...stop, last_assistant_message: REPLY })).block).toBeUndefined()
})
