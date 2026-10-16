import { expect, mock, test } from 'claude-code/testing'

import type { HudSnapshot } from '../types'

// A snapshot as collect.py writes it: account A hot on its 5h window, codex nearly dry, the
// box unreachable, one codex pool halfway and a claude pool with 4 jobs in flight.
const now = Date.now() / 1000
const SNAP: HudSnapshot = {
  t: now,
  machines: {
    mac: {
      t: now, ncpu: 8, load: 3.6, cpu: 46, mem: 69, mem_total: 16, swap: 5.1, agents_gb: 3.4, disk: [51.5, 460],
      claude: { A: { live: 2, headless: 6 }, B: { live: 1, headless: 0 } },
      codex: { a: 1 },
      pools: [{ pid: 1, kind: 'codex', name: 'gaps', model: 'gpt-6-sol', total: 200, base: 0, done: 100,
                failed: 2, inflight: { a: 30, b: 20 }, started: now - 600, t: now },
              { pid: 2, kind: 'claude', name: 'audit', model: 'haiku', total: 40, base: 0, done: 10,
                failed: 0, inflight: 4, started: now - 60, t: now }],
    },
    box: { error: 'ssh: connect to host box port 22: Operation timed out' },
  },
  claude: {
    A: { t: now, five: 80, five_reset: now + 3600, week: 19, week_reset: now + 86400 * 3, fable: 11 },
    B: { t: now, five: 2, five_reset: now + 7200, week: 1, week_reset: now + 86400 * 5, fable: 0 },
  },
  codex: { a: { t: now, week: 100, week_reset: now + 86400 }, b: { t: now, week: 97, week_reset: now + 86400 * 4 } },
  codex_read: { t: now },
  sessions: [],
  archive: { t: now, name: 'archive', free: 1006, total: 1024 },
  ghostty: null,
  muted: [],
  hist: { mac: [[now - 20, 40, 60], [now - 10, 95, 66], [now, 46, 69]] },
  cost: { wall_ms: 400, cpu_ms: 90 },
}

const paneAt = (surface: 'terminal' | 'desktop', bodyColumns: number, bodyRows: number) => ({
  plugin: 'agent-fleet', surface, component: 'Pane' as const, requestId: 'hud',
  props: { title: 'hud', isFocused: false, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows }, view: {} },
})

type Mounted = {
  findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown>; text: string }[]>
  unmount: () => Promise<void>
}

/** A drawing's rows as text (draw makes each row one truncating Text around its spans), unmounted after. */
const rowsOf = async (view: Mounted) => {
  const rows = (await view.findAll({ type: 'Text' })).filter(t => t.props.wrap === 'truncate').map(t => t.text)
  await view.unmount()
  return rows
}

const band = (bodyColumns: number) => ({
  plugin: 'agent-fleet',
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
})

test('the band fits its width and the pane shows every section', { timeoutMs: 30_000 }, async ($, on) => {
  mock.env(on, { HOME: '/h' })
  mock.store(on)
  const clock = mock.clock(on, { now: Date.now() })
  on('command.register', () => ({ value: { command: 'hud' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.cwd', () => ({ value: '/h/dotfiles' }))
  on('settings.read', () => ({ value: {} }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: Date.now(), isLink: false } }))
  on('fs.read', () => ({ value: JSON.stringify(SNAP) }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: '/h/dotfiles', surface: 'terminal', isInteractive: true })
  await clock.settle() // the first poll reads the snapshot

  const wide = await $.ui.mount(band(200))
  const wideText = (await wide.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(wideText).toContain('claude A')
  expect(wideText).toContain('codex a 100 b 97')
  expect(wideText).toContain('box ✕')
  expect(wideText).toContain('⇶ 60 agents') // 6 headless + 50 codex pool turns + 4 claude pool jobs
  await wide.unmount()

  const narrow = await $.ui.mount(band(40))
  const narrowText = (await narrow.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(narrowText).not.toContain('claude')
  expect(narrowText).toContain('cx97') // tight tiers show the codex account with the most room
  await narrow.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const text = (await rowsOf(await $.ui.mount(paneAt(surface, 52, 60)))).join('\n')
    for (const part of ['Claude', 'Codex', 'mac', 'Fan-out', '100/200', 'disk 52G', 'archive 1006G free of 1024G', 'unreachable']) {
      expect(text).toContain(part)
    }
    expect(text).toContain('gpt-6-sol · in flight a 30 b 20') // room for each pool's detail row
  }

  // A 12-row pane (a short split) keeps quota, both machines and the fan-out, in the rows it has.
  const short = await rowsOf(await $.ui.mount(paneAt('terminal', 60, 12)))
  expect(short.length).toBeLessThanOrEqual(12)
  for (const part of ['A●', 'Codex', 'mac', 'box', '⇶ 60', 'gaps']) expect(short.join('\n')).toContain(part)

  // Short and wide (inline above the prompt): two columns side by side.
  const wide2 = await rowsOf(await $.ui.mount(paneAt('terminal', 180, 14)))
  expect(wide2.length).toBeLessThanOrEqual(14)
  expect(wide2.some(r => r.includes('Claude') && r.includes('Fan-out'))).toBe(true)
})

test('a session the snapshot mutes (another in its Ghostty tab shows the hud) draws no band', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  mock.store(on)
  const clock = mock.clock(on, { now: Date.now() })
  on('command.register', () => ({ value: { command: 'hud' } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', $ => { const { Text } = $.ui.resolve({ surface: 'terminal', component: 'AbovePrompt' }); return <Text>engine</Text> })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.cwd', () => ({ value: '/h/dotfiles' }))
  on('settings.read', () => ({ value: {} }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: Date.now(), isLink: false } }))
  on('fs.read', () => ({ value: JSON.stringify({ ...SNAP, muted: ['sid-1'] }) }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: '/h/dotfiles', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const view = await $.ui.mount(band(200))
  const text = (await view.findAll({ type: 'Text' })).map(t => t.text).join('')
  expect(text).toBe('engine') // the hook stood aside for the engine's own band
  await view.unmount()
})
