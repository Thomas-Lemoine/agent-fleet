import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, FsStat, Register, RenderSurface, SessionRateLimit } from 'claude-code'

import type { HudAgent, HudLimits, HudMachineStats, HudPool, HudSnapshot } from '../types'
import { relayGuard } from './relay'

// The agent-fleet plugin: the hud below, and relayGuard (relay.ts) for the astra and sol agents.
//
// The hud is a heads-up display of quota and machines. collect.py writes one shared snapshot file
// for every session (a flock and a TTL make N sessions cost one collection per TTL); each
// session's hud stats that file every POLL_MS, reads it when it changed, and runs the collector
// when it is stale. The snapshot draws as a one-line band above the prompt, or as a pane docked
// beside the transcript once the terminal is wide enough (144 columns unasked, any width after
// /hud). Sessions split into one Ghostty tab show it once: the snapshot mutes all but the tallest.
// A headless run (`claude -p`) draws nothing; one that starts agents (a Workflow fleet) beats
// them, so they count in every session's fan-out. Each session also puts the rate limits it
// measures in its beat, which is how the collector reads Claude quota in near real time.
// Options (userConfig): `remote`, an ssh host shown as a second machine; `archive`, an sftp
// rclone remote whose free space is shown.

const PANE = 'hud'
const POLL_MS = 2_000
const TTL_MS = 10_000
const BEAT_MS = 30_000
const KEEP_DONE_MS = 10 * 60_000
const MAX_AGENTS = 40
// An agent $.agent.list() does not name (a workflow's, or an engine fork's) with no tool call for
// this long is taken as done: nothing else says when those end.
const STALE_MS = 3 * 60_000
const RETRY_MS = 60_000 // between collector runs while it is failing
const TOAST_EVERY_MS = 15 * 60_000 // one toast per alert per this long, however it flaps

const snap = atom({ plugin: 'agent-fleet', key: 'snap' } as const, null, { shape: 'v3' })
const agents = atom({ plugin: 'agent-fleet', key: 'agents' } as const, [])
const alerts = atom({ plugin: 'agent-fleet', key: 'alerts' } as const, {})
const paneRev = atom({ plugin: 'agent-fleet', key: 'paneRev' } as const, 0)
const asked = atom({ plugin: 'agent-fleet', key: 'asked' } as const, false)

// Higher is worse everywhere: quota used, cpu busy, memory used. [warn, hot] per meter; the
// 5h hot line is the fan-out cutoff (quota skill), memory's 20% free.
const LIMITS = { five: [50, 75], week: [85, 95], cpu: [70, 90], mem: [60, 80] } as const
const COLOR = { bar: '#58a6ff', warn: '#d29922', hot: '#f85149', good: '#3fb950' } as const
// Disk is free GB, lower is worse: a job writing a few GB fails under the hot line.
const DISK = { warn: 20, hot: 5 } as const
const diskTone = (free: number) => (free < DISK.hot ? COLOR.hot : free < DISK.warn ? COLOR.warn : undefined)

type Meter = keyof typeof LIMITS
type Span = { t: string; c?: string; dim?: boolean; bold?: boolean }
type Line = Span[]

const tone = (meter: Meter, v: number) =>
  v >= LIMITS[meter][1] ? COLOR.hot : v >= LIMITS[meter][0] ? COLOR.warn : undefined

const num = (meter: Meter, v: number, pad = 0): Span => ({
  t: String(Math.round(v)).padStart(pad),
  c: tone(meter, v),
})

const dim = (t: string): Span => ({ t, dim: true })

/** `━━━━────` filled to `v` percent, `width` cells. */
const bar = (meter: Meter, v: number, width: number): Span[] => {
  const full = Math.max(0, Math.min(width, Math.round((v / 100) * width)))
  return [
    { t: '━'.repeat(full), c: tone(meter, v) ?? COLOR.bar },
    { t: '─'.repeat(width - full), dim: true },
  ]
}

const SPARK = '▁▂▃▄▅▆▇█'

/** The last `width` values (0-100) as block heights, one color run per tone. */
const spark = (meter: Meter, values: number[], width: number): Span[] => {
  const spans: Span[] = []
  for (const v of values.slice(-width)) {
    const ch = SPARK.charAt(Math.max(0, Math.min(7, Math.round((v / 100) * 7))))
    const c = tone(meter, v) ?? COLOR.bar
    const prev = spans[spans.length - 1]
    if (prev && prev.c === c) prev.t += ch
    else spans.push({ t: ch, c })
  }
  const used = values.slice(-width).length
  return used < width ? [dim(' '.repeat(width - used)), ...spans] : spans
}

/** 45s, 12m, 3h12, 2d4h */
const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`
}

const width = (line: Line) => line.reduce((n, s) => n + s.t.length, 0)

const isUp = (m: HudSnapshot['machines'][string]): m is HudMachineStats => !('error' in m)

const poolInflight = (p: HudPool) =>
  typeof p.inflight === 'number' ? p.inflight : Object.values(p.inflight).reduce((a, b) => a + b, 0)

/** Agents working right now, across machines: headless Claude runs, pool jobs, and subagents
 * of every live session, headless fleets included (this one's live, the others' from beats). */
const fanout = (s: HudSnapshot, mine: HudAgent[], sid: string) => {
  let n = mine.filter(a => a.status === 'running').length
  for (const b of s.sessions) if (b.id !== sid) n += b.running
  for (const m of Object.values(s.machines)) {
    if (!isUp(m)) continue
    for (const a of Object.values(m.claude)) n += a.headless
    for (const p of m.pools) n += poolInflight(p)
  }
  return n
}

// ---- the band: one line, tighter tiers as the width shrinks ----

const SEP = dim(' │ ')

function bandLine(s: HudSnapshot, me: string, n: number, tier: number): Line {
  const out: Line = []
  const machines = Object.entries(s.machines)
  for (const [name, m] of machines) {
    if (isUp(m) && (m.mem >= LIMITS.mem[1] || m.cpu >= LIMITS.cpu[1] || m.disk[0] < DISK.hot)) {
      out.push({ t: `⚠ ${name}${m.disk[0] < DISK.hot ? ` disk ${m.disk[0]}G` : ''} `, c: COLOR.hot, bold: true })
    }
  }
  const claude = Object.entries(s.claude)
  if (claude.length) {
    if (tier === 0) out.push(dim('claude '))
    for (const [acct, u] of claude) {
      out.push({ t: acct, bold: acct === me, dim: acct !== me })
      if (tier < 3) out.push(dim(tier < 2 ? ' ' : ''), num('five', u.five), dim('·'))
      out.push(num('week', u.week), dim(' '))
    }
    out.pop()
  }
  const codex = Object.entries(s.codex)
  if (codex.length) {
    out.push(SEP)
    if (tier === 0) {
      out.push(dim('codex '))
      for (const [acct, u] of codex) out.push(dim(`${acct} `), num('week', u.week), dim(' '))
      out.pop()
    } else if (tier === 1) {
      out.push(dim('cx '))
      for (const [, u] of codex) out.push(num('week', u.week), dim('·'))
      out.pop()
    } else {
      // Tight: only the account with the most room matters for routing.
      out.push(dim('cx'), num('week', Math.min(...codex.map(([, u]) => u.week))))
    }
  }
  for (const [name, m] of machines) {
    out.push(tier < 2 || name === machines[0]?.[0] ? SEP : dim(' '))
    const label = tier < 3 ? name : name.charAt(0)
    if (!isUp(m)) {
      out.push({ t: `${label} ✕`, c: COLOR.hot })
    } else if (tier < 2) {
      out.push(dim(`${label} `), num('cpu', m.cpu), dim('·'), num('mem', m.mem))
    } else {
      out.push(dim(label), num('mem', m.mem))
    }
  }
  if (n > 0) out.push(SEP, { t: tier === 0 ? `⇶ ${n} agents` : `⇶${n}`, bold: true })
  const age = Date.now() / 1000 - s.t
  if (age > 60) out.push(dim(` (${dur(age * 1000)} old)`))
  return out
}

// ---- the pane: one layout that fits whatever room the surface gives it ----
// Docked beside the transcript it is thin and as tall as the terminal; inline above the prompt it
// is as wide as the terminal and short. The roomiest tier that fits wins, each dropping the next
// least useful rows: 0 is everything, sparklines on rows of their own when the pane is too thin
// for them beside the numbers; 1 keeps sparklines only beside; 2 drops each pool's model and load,
// finished subagents and the footer; 3 drops the blank rows between sections; 4 folds the
// machines and the fan-out extras to a row each and keeps quota, fan-out and the running agent.
// Widths scale the bars and sparklines between floors and caps, and a pane wide enough for two
// columns (quota and machines beside fan-out and this session) uses them, which about halves its
// height; each column takes its own tier. This session comes last and takes the rows left, so a
// long agent list never forces a tighter tier.

type Tier = 0 | 1 | 2 | 3 | 4
const TIERS = [0, 1, 2, 3, 4] as const
const COL_MIN = 56 // narrower than this, a column of two would lose its bars
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(v)))

/** `3d8h` until `at` (epoch s), or `—` once it has passed or before the window started. */
const resetIn = (at: number | null, now: number) => (at !== null && at * 1000 > now ? dur(at * 1000 - now) : '—')

function claudeRows(s: HudSnapshot, me: string, w: number): Line[] {
  const now = Date.now()
  const accts = Object.entries(s.claude)
  if (!accts.length) return []
  // Row: label 4, two bars with 4-wide numbers, the two resets (8, 7), fable (7).
  const resets = w >= 37
  const fable = w >= 52 && accts.some(([, u]) => u.fable != null)
  const bw = clamp((w - 14 - (resets ? 15 : 0) - (fable ? 7 : 0)) / 2, 4, 16)
  // Each label ends over the column it names.
  const out: Line[] = [
    [
      { t: 'Claude', bold: true },
      dim(
        `${'5h'.padStart(bw + 2)}${'week'.padStart(bw + 6)}${resets ? `${'⟳5h'.padStart(8)}${'⟳wk'.padStart(7)}` : ''}${fable ? '  fable' : ''}`,
      ),
    ],
  ]
  for (const [acct, u] of accts) {
    const mine = acct === me
    const row: Line = [
      { t: (mine ? `${acct}●` : acct).padEnd(4), bold: mine },
      ...bar('five', u.five, bw),
      num('five', u.five, 4),
      dim('  '),
      ...bar('week', u.week, bw),
      num('week', u.week, 4),
    ]
    if (resets) row.push(dim(`${resetIn(u.five_reset, now).padStart(8)}${resetIn(u.week_reset, now).padStart(7)}`))
    if (fable) row.push(dim(u.fable == null ? '       ' : String(Math.round(u.fable)).padStart(7)))
    out.push(row)
    // The row fills the width, so a stale reading says so on a row of its own.
    if (now / 1000 - u.t > 1800) out.push([dim(`    └ read ${dur(now - u.t * 1000)} ago`)])
  }
  return out
}

function codexRows(s: HudSnapshot, w: number): Line[] {
  const failed: Line[] = s.codex_read?.error
    ? [[{ t: 'Codex ', bold: true }, { t: `codex-usage failed: ${s.codex_read.error}`, c: COLOR.hot }]]
    : []
  return [...codexQuota(s, w), ...failed]
}

function codexQuota(s: HudSnapshot, w: number): Line[] {
  const codex = Object.entries(s.codex)
  if (!codex.length) return []
  const reset = dim(`  ⟳ ${resetIn(Math.min(...codex.map(([, u]) => u.week_reset)), Date.now())}`)
  // Row: `Codex ` 6, per account `a ` + bar + 4-wide number + 2, the reset ~9.
  const mb = clamp((w - 15 - 8 * codex.length) / codex.length, 0, 8)
  if (mb < 3) {
    const row: Line = [{ t: 'Codex', bold: true }, dim(' wk')]
    for (const [a, u] of codex) row.push(dim(`  ${a} `), num('week', u.week))
    return [[...row, reset]]
  }
  const row: Line = [{ t: 'Codex ', bold: true }]
  for (const [a, u] of codex) row.push(dim(`${a} `), ...bar('week', u.week, mb), num('week', u.week, 4), dim('  '))
  return [[...row, reset]]
}

const diskSpan = (free: number): Span => ({ t: `${Math.round(free)}G`, c: diskTone(free) })

/** Facts joined by ` · ` under a machine's name: wrapped to rows of `w` cells, or one row the
 * frame cuts. */
function factRows(facts: Line[], w: number, wrap: boolean): Line[] {
  const rows: Line[] = []
  for (const f of facts) {
    const last = rows.at(-1)
    if (last && (!wrap || width(last) + 3 + width(f) <= w)) last.push(dim(' · '), ...f)
    else rows.push([dim('     '), ...f])
  }
  return rows
}

function machineRows(s: HudSnapshot, w: number, tier: Tier): Line[] {
  const machines = Object.entries(s.machines)
  const name5 = (name: string): Span => ({ t: name.padEnd(5), bold: true })
  if (tier === 4) {
    const cells: Line[] = machines.map(([name, m]) =>
      isUp(m)
        ? [{ t: `${name} `, bold: true }, dim('cpu '), num('cpu', m.cpu), dim(' mem '), num('mem', m.mem), dim(' disk '), diskSpan(m.disk[0])]
        : [{ t: `${name} `, bold: true }, { t: '✕ unreachable', c: COLOR.hot }],
    )
    const joined = cells.flatMap((c, i) => (i ? [dim('   '), ...c] : c))
    return width(joined) <= w ? [joined] : cells
  }
  // Sparklines beside the numbers: name 5, `cpu ` + spark + 4, `   mem ` + spark + 4, `   disk ` + ~4.
  const sw = clamp((w - 36) / 2, 0, 30)
  const stacked = sw < 6 && tier === 0 // too thin for that: on rows of their own
  const out: Line[] = []
  for (const [name, m] of machines) {
    if (!isUp(m)) {
      out.push([name5(name), { t: `unreachable: ${m.error}`, c: COLOR.hot }])
      continue
    }
    const hist = s.hist[name] ?? []
    // Most telling first: an unwrapped row is cut at the frame. Swap goes last, as macOS keeps
    // gigabytes of it for days.
    const facts: Line[] = [[dim(`load ${m.load}/${m.ncpu}`)], [dim(`agents ${m.agents_gb}G`)]]
    const procs = Object.entries(m.claude)
      .sort()
      .map(([a, c]) => `${a}${c.live}${c.headless ? `+${c.headless}` : ''}`)
      .join(' ')
    if (procs) facts.push([dim(procs)])
    const cx = Object.values(m.codex).reduce((a, b) => a + b, 0)
    if (cx) facts.push([dim(`cx ${cx}`)])
    if (m.swap >= 0.1) facts.push([dim(`swap ${m.swap}G`)])
    if (sw >= 6) {
      out.push([
        name5(name),
        dim('cpu '),
        ...spark('cpu', hist.map(h => h[1]), sw),
        num('cpu', m.cpu, 4),
        dim('   mem '),
        ...spark('mem', hist.map(h => h[2]), sw),
        num('mem', m.mem, 4),
        dim('   disk '),
        diskSpan(m.disk[0]),
      ])
    } else if (stacked) {
      const sp = clamp(w - 14, 4, 60)
      out.push([name5(name), dim('cpu  '), ...spark('cpu', hist.map(h => h[1]), sp), num('cpu', m.cpu, 4)])
      out.push([dim('     mem  '), ...spark('mem', hist.map(h => h[2]), sp), num('mem', m.mem, 4)])
      facts.unshift([dim('disk '), diskSpan(m.disk[0])])
    } else {
      out.push([name5(name), dim('cpu '), num('cpu', m.cpu), dim('  mem '), num('mem', m.mem), dim('  disk '), diskSpan(m.disk[0])])
    }
    out.push(...factRows(facts, w, tier <= 1))
  }
  return out
}

/** The archive remote (option `archive`); tier 4 shows it only when it needs a look. */
function archiveRows(s: HudSnapshot, tier: Tier): Line[] {
  const a = s.archive
  if (!a) return []
  if ('error' in a) return [[{ t: 'arch ', bold: true }, { t: `unreachable: ${a.error}`, c: COLOR.hot }]]
  if (tier === 4 && a.free >= DISK.warn) return []
  return [[{ t: 'arch ', bold: true }, dim(`${a.name} `), diskSpan(a.free), dim(` free of ${a.total}G`)]]
}

type PoolOn = HudPool & { on: string }

const inflightText = (p: HudPool) =>
  typeof p.inflight === 'number'
    ? `${p.inflight}`
    : Object.entries(p.inflight)
        .filter(([, n]) => n > 0)
        .map(([a, n]) => `${a} ${n}`)
        .join(' ')

/** `cx  solve_sol   ━━━━──── 295/442  25✕   1m`: kind, name, progress, failures, eta. */
function poolRow(p: PoolOn, local: string, w: number): Line {
  const namew = clamp(w - 31, 6, 14)
  const name = `${p.on === local ? '' : `${p.on}:`}${p.name.replace(/\.prompts$/, '')}`
  const label = name.length > namew ? `${name.slice(0, namew - 1)}… ` : name.padEnd(namew + 1)
  const rate = (p.done - p.base) / Math.max(1, p.t - p.started)
  const eta = rate > 0 && p.done < p.total ? dur(((p.total - p.done) / rate) * 1000) : ''
  const pbw = clamp(w - 24 - namew, 4, 40)
  const full = Math.round((p.done / Math.max(1, p.total)) * pbw)
  return [
    dim(p.kind === 'codex' ? 'cx  ' : 'cl  '),
    { t: label },
    { t: '━'.repeat(full), c: COLOR.good },
    dim('─'.repeat(pbw - full)),
    { t: ` ${`${p.done}/${p.total}`.padEnd(9)}` },
    p.failed ? { t: `${String(p.failed).padStart(3)}✕`, c: COLOR.hot } : dim('    '),
    dim(eta.padStart(5)),
  ]
}

/** Pools, headless runs and other sessions' agents. Tier 4 leads with the total and, when the
 * rows do not all fit in `room`, shows the pools that do and folds the rest into one row. */
function fanoutRows(s: HudSnapshot, mine: HudAgent[], sid: string, w: number, tier: Tier, room: number): Line[] {
  const local = Object.keys(s.machines)[0] ?? ''
  const pools: PoolOn[] = Object.entries(s.machines).flatMap(([on, m]) => (isUp(m) ? m.pools.map(p => ({ ...p, on })) : []))
  const headless = Object.values(s.machines)
    .filter(isUp)
    .flatMap(m => Object.entries(m.claude))
    .reduce<Record<string, number>>((acc, [a, c]) => ({ ...acc, [a]: (acc[a] ?? 0) + c.headless }), {})
  const nHeadless = Object.values(headless).reduce((a, b) => a + b, 0)
  const others = s.sessions.filter(b => b.id !== sid && b.running > 0)
  if (!pools.length && !nHeadless && !others.length) return []
  const n = fanout(s, mine, sid)
  const by = Object.entries(headless)
    .filter(([, k]) => k > 0)
    .sort()
    .map(([a, k]) => `${a} ${k}`)
    .join(' · ')
  const extras: Line[] = [
    ...(nHeadless ? [[{ t: 'claude -p ' }, dim(`${nHeadless} running  ${by}`)]] : []),
    ...others.map(
      (b): Line =>
        b.headless
          ? [{ t: 'headless ' }, dim(`${b.cwd} (${b.acct}) · ${b.running} agents`)]
          : [{ t: 'session ' }, dim(`${b.cwd} (${b.acct}) · ${b.running} subagent${b.running === 1 ? '' : 's'}`)],
    ),
  ]
  if (tier < 4) {
    const out: Line[] = [[{ t: 'Fan-out', bold: true }, dim('  ⇶ '), { t: String(n), bold: true }, dim(' agents')]]
    for (const p of pools) {
      out.push(poolRow(p, local, w))
      if (tier <= 1) out.push([dim(`    ${p.model} · in flight ${inflightText(p) || 0} · ${dur((p.t - p.started) * 1000)}`)])
    }
    return [...out, ...extras]
  }
  const lead = (i: number): Span => (i === 0 ? { t: `⇶ ${n}`.padEnd(7), bold: true } : dim(' '.repeat(7)))
  if (pools.length + extras.length <= room) {
    return [...pools.map(p => poolRow(p, local, w - 7)), ...extras].map((row, i) => [lead(i), ...row])
  }
  const brief = [
    ...(nHeadless ? [`claude -p ${nHeadless}`] : []),
    ...others.map(b => `${b.headless ? 'headless' : 'session'} ${b.cwd} ${b.running}`),
  ]
  // Not all fit: the pools that leave a row for the rest, folded.
  const shown = pools.slice(0, Math.max(1, room) - 1)
  const tail = [...(pools.length > shown.length ? [`+${pools.length - shown.length} pools`] : []), ...brief].join(' · ')
  return [...shown.map(p => poolRow(p, local, w - 7)), [dim(tail)]].map((row, i) => [lead(i), ...row])
}

/** This session's subagents in at most `room` rows: all of them at tiers 0 and 1, the running
 * ones at tiers 2 and 3, the newest running one at tier 4. */
function sessionRows(mine: HudAgent[], tier: Tier, room: number): Line[] {
  const now = Date.now()
  const newest = [...mine].reverse()
  const running = newest.filter(a => a.status === 'running')
  const took = (a: HudAgent) => dur((a.ended ?? now) - a.started)
  let out: Line[]
  if (tier === 4) {
    const a = running[0]
    if (!a) return []
    const more = running.length > 1 ? ` +${running.length - 1}` : ''
    out = [[{ t: '● ', c: COLOR.bar }, { t: a.label || a.type }, dim(`  ${took(a)}${more}${a.last ? ` ▸ ${a.last}` : ''}`)]]
  } else if (tier >= 2) {
    const done = mine.length - running.length
    const failed = mine.filter(a => a.status === 'failed').length
    const summary = dim([...(done > failed ? [`✓ ${done - failed} done`] : []), ...(failed ? [`✕ ${failed} failed`] : [])].join(' · '))
    out = running.map((a, i): Line => [
      i === 0 ? { t: 'This session  ', bold: true } : dim('  '),
      { t: '● ', c: COLOR.bar },
      { t: a.label || a.type },
      dim(`  ${took(a)} · ${a.tools} tools`),
    ])
    if (running[0]?.last) out.splice(1, 0, [dim('  ▸ '), { t: running[0].last }])
    if (done) out.push(out.length ? [dim('  '), summary] : [{ t: 'This session  ', bold: true }, summary])
  } else {
    out = [[{ t: 'This session', bold: true }, dim(`   ${running.length} running`)]]
    for (const a of newest) {
      const isRunning = a.status === 'running'
      const mark: Span = isRunning ? { t: '● ', c: COLOR.bar } : a.status === 'done' ? { t: '✓ ', c: COLOR.good } : { t: '✕ ', c: COLOR.hot }
      out.push([mark, { t: a.type, bold: isRunning, dim: !isRunning }, dim(`  ${took(a)} · ${a.tools} tools`)])
      if (a.label) out.push([dim(`  ${a.label}`)])
      if (isRunning && a.last) out.push([dim('  ▸ '), { t: a.last }])
    }
  }
  if (out.length <= room) return out
  const cut = out.slice(0, Math.max(0, room - 1))
  return room > 0 ? [...cut, [dim(`  +${out.length - cut.length} more rows`)]] : []
}

type Part = 'all' | 'quota' | 'activity'

/** One column of the pane at `tier`, or null when a tier before 4 does not fit `rows` (tier 4
 * always lays out, cut at the bottom if even it is too tall). `quota` is Claude, Codex and
 * machines, `activity` the fan-out and this session; a single column is `all`. */
function column(s: HudSnapshot, me: string, mine: HudAgent[], sid: string, w: number, rows: number, tier: Tier, part: Part): Line[] | null {
  const gap: Line[] = tier < 3 ? [[]] : []
  const tight = tier === 4
  const join = (secs: Line[][]) => secs.filter(x => x.length).flatMap((x, i) => (i ? [...gap, ...x] : x))
  const quota =
    part === 'activity'
      ? []
      : [claudeRows(s, me, w), codexRows(s, w), [...machineRows(s, w, tier), ...archiveRows(s, tier)]]
  const withSession = part !== 'quota' && mine.length > 0
  const minSession = !withSession ? 0 : tight ? (mine.some(a => a.status === 'running') ? 1 : 0) : 2
  const reserve = minSession ? minSession + gap.length : 0
  let head = join(quota)
  if (part !== 'quota') {
    const room = rows - head.length - (head.length ? gap.length : 0) - reserve
    head = join([head, fanoutRows(s, mine, sid, w, tier, room)])
  }
  if (!tight && head.length + reserve > rows) return null
  const out = withSession ? join([head, sessionRows(mine, tier, rows - head.length - (head.length ? gap.length : 0))]) : head
  if (tier <= 1 && part !== 'quota' && rows - out.length >= 2) {
    out.push([], [dim(`${dur(Date.now() - s.t * 1000)} ago · collector ${s.cost.cpu_ms}ms cpu, ${s.cost.wall_ms}ms wall`)])
  }
  return out
}

/** `line` cut or padded to exactly `n` cells. */
function fitTo(line: Line, n: number): Line {
  const out: Line = []
  let left = n
  for (const sp of line) {
    if (left <= 0) break
    out.push(sp.t.length > left ? { ...sp, t: sp.t.slice(0, left) } : sp)
    left -= Math.min(left, sp.t.length)
  }
  return left > 0 ? [...out, { t: ' '.repeat(left) }] : out
}

/** `part` at the roomiest tier that fits `rows`. */
function roomiest(s: HudSnapshot, me: string, mine: HudAgent[], sid: string, w: number, rows: number, part: Part): Line[] {
  for (const tier of TIERS) {
    const lines = column(s, me, mine, sid, w, rows, tier, part)
    if (lines) return lines
  }
  throw new Error('hud: tier 4 always lays out')
}

function paneLines(s: HudSnapshot, me: string, mine: HudAgent[], sid: string, w: number, rows: number): Line[] {
  if (w < 2 * COL_MIN + 3) return roomiest(s, me, mine, sid, w, rows, 'all')
  const cw = Math.floor((w - 3) / 2)
  const left = roomiest(s, me, mine, sid, cw, rows, 'quota')
  const right = roomiest(s, me, mine, sid, cw, rows, 'activity')
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => [
    ...fitTo(left[i] ?? [], cw),
    dim(' │ '),
    ...(right[i] ?? []),
  ])
}

// ---- subagent bookkeeping ----

/** `Bash pytest -x`, `Read register.tsx`: what a tool call is doing, short. */
function describe(e: { tool: string }): string {
  const a = e as unknown as Record<string, unknown>
  const arg = [a.command, a.file_path, a.pattern, a.query, a.url, a.description, a.skill].find(
    (v): v is string => typeof v === 'string',
  )
  const short = arg === undefined ? '' : arg === a.file_path ? arg.split('/').pop()! : arg
  return `${e.tool.replace(/^mcp__[^_]+__/, '')} ${short.replace(/\s+/g, ' ')}`.slice(0, 80)
}

/** Every running agent, then the most recent finished ones while there is room. */
const prune = (list: HudAgent[]) => {
  const now = Date.now()
  const running = list.filter(a => a.status === 'running').length
  const done = list.filter(a => a.status !== 'running' && now - (a.ended ?? now) < KEEP_DONE_MS)
  const keep = new Set(done.slice(-Math.max(0, MAX_AGENTS - running)))
  return list.filter(a => a.status === 'running' || keep.has(a))
}

const upsert = (list: HudAgent[], id: string, patch: (a: HudAgent) => HudAgent) => {
  const i = list.findIndex(a => a.id === id)
  if (i >= 0) return list.map((a, j) => (j === i ? patch(a) : a))
  // An agent that never passed agent.spawn (an engine fork) is first heard of by its tool calls.
  const now = Date.now()
  const fresh: HudAgent = { id, label: '', type: 'workflow agent', started: now, seen: now, tools: 0, last: '', status: 'running' }
  return prune([...list, patch(fresh)])
}

// ---- the session's loop: poll the snapshot, run the collector when stale, beat ----

// Per load: a hot reload starts the module over and session.start fills them again.
const self = {
  home: '', sid: '', me: 'A', cwd: '', lastMtime: 0, collecting: false, lastBeat: 0, lastError: '', lastRun: 0,
  parking: false,
  /** A `claude -p` run: it tracks and beats its agents, and draws and polls nothing. */
  headless: false,
  /** The terminal's height as of the last drawing, for the Ghostty tab's pick. */
  rows: 0,
  /** The snapshot mutes this session (another in its Ghostty tab shows the hud). */
  muted: false,
  fullscreen: false,
  /** collect.py's arguments for the `remote` and `archive` options. */
  collectArgs: [] as string[],
  /** This account's rate limits as this session last measured them, carried in its beat. */
  limits: null as HudLimits | null,
}
// Spreads the sessions' collector runs so the first one's fresh snapshot stops the rest. Drawn
// anew each tick, so every session gets turns: only one Ghostty launched reads Ghostty's tabs.
const jitter = () => Math.floor(Math.random() * 3_000)

const snapshotPath = () => `${self.home}/.cache/hud/snapshot-v3.json` // collect.py's SNAPSHOT

/** This session's line in ~/.cache/hud/sessions, which other sessions' fan-out counts and the
 * collector's Claude quota read. */
async function beat($: EngineInterface) {
  self.lastBeat = Date.now()
  const running = (await read($, agents)).filter(a => a.status === 'running').length
  const { sid, me, cwd, headless, rows, limits } = self
  await $.fs.write(
    `${self.home}/.cache/hud/sessions/${sid}.json`,
    JSON.stringify({ id: sid, acct: me, cwd, running, t: Date.now() / 1000, headless, rows, limits }),
  )
}

/** The 5-hour and weekly windows of a measurement as the snapshot spells a reading, or null
 * when either is missing (off a subscription, before the first response). */
function toLimits(rateLimits: SessionRateLimit[]): HudLimits | null {
  const five = rateLimits.find(r => r.kind === 'five_hour')
  const week = rateLimits.find(r => r.kind === 'seven_day')
  if (!five || !week) return null
  const at = (iso?: string) => (iso ? Date.parse(iso) / 1000 : null)
  return { t: Date.now() / 1000, five: five.percentUsed, five_reset: at(five.resetsAt), week: week.percentUsed, week_reset: at(week.resetsAt) }
}

/** Hides the unasked pane while another session in the Ghostty tab shows the hud, and brings
 * it back when this one is the tab's again (the band follows the snapshot by itself). */
async function mute($: EngineInterface, muted: boolean) {
  self.muted = muted
  if (!(await read($, asked))) {
    if (muted) await $.ui.close({ id: PANE })
    else if (self.fullscreen && (await $.store.get('closed')) !== true) await $.ui.open(OPEN)
  }
  await update($, paneRev, n => n + 1)
}

/** Toasts a machine alert: memory past its hot line, cpu pinned for three samples, the remote
 * unreachable; each at most every TOAST_EVERY_MS. Quota needs no toast: the band colors it. */
async function warn($: EngineInterface, s: HudSnapshot) {
  const found: Record<string, string> = {}
  for (const [name, m] of Object.entries(s.machines)) {
    if (!isUp(m)) {
      found[`${name}:down`] = `${name} unreachable: ${m.error}`
      continue
    }
    if (m.mem >= LIMITS.mem[1]) found[`${name}:mem`] = `${name} memory ${Math.round(m.mem)}% used`
    const recent = (s.hist[name] ?? []).slice(-3)
    if (recent.length === 3 && recent.every(h => h[1] >= LIMITS.cpu[1])) {
      found[`${name}:cpu`] = `${name} cpu pinned at ${Math.round(m.cpu)}% for 30s+`
    }
  }
  const now = Date.now()
  const last = await read($, alerts)
  const due = Object.keys(found).filter(key => now - (last[key] ?? 0) > TOAST_EVERY_MS)
  for (const key of due) $.ui.toast(`⚠ ${found[key]}`, { timeoutMs: 10_000 })
  if (due.length) await update($, alerts, prev => ({ ...prev, ...Object.fromEntries(due.map(key => [key, now])) }))
}

async function tick($: EngineInterface) {
  let st: FsStat | null = null
  try {
    st = await $.fs.stat(snapshotPath())
  } catch {
    st = null // first run on this machine: the collector below makes it
  }
  if (st && st.mtimeMs !== self.lastMtime) {
    self.lastMtime = st.mtimeMs
    const s = JSON.parse(await $.fs.read(snapshotPath())) as HudSnapshot
    await update($, snap, () => s)
    await warn($, s)
    if (s.muted.includes(self.sid) !== self.muted) await mute($, !self.muted)
  }
  const now = Date.now()
  const stale = !st || now - st.mtimeMs > TTL_MS + jitter()
  if (stale && !self.collecting && now - self.lastRun > (self.lastError ? RETRY_MS : TTL_MS)) {
    self.collecting = true
    self.lastRun = now
    void collect($)
  }
  if (Date.now() - self.lastBeat > BEAT_MS) await beat($)
  await reconcile($)
}

/** A subagent stopped without a turn.complete (killed, crashed) still reads `running`: take the
 * engine's own status for the ones it lists. The ones it does not list go stale instead. */
async function reconcile($: EngineInterface) {
  if (!self.sid) return
  const mine = await read($, agents)
  if (!mine.some(a => a.status === 'running')) return
  const status = new Map((await $.agent.list()).map(a => [a.id, a.status]))
  const now = Date.now()
  const settled = (a: HudAgent): HudAgent['status'] | null => {
    const s = status.get(a.id)
    if (s === undefined) return now - a.seen > STALE_MS ? 'done' : null
    return s === 'completed' ? 'done' : s === 'failed' || s === 'killed' ? 'failed' : null
  }
  if (mine.some(a => a.status === 'running' && settled(a) !== null)) {
    await update($, agents, list =>
      list.map(a => {
        const s = a.status === 'running' ? settled(a) : null
        return s === null ? a : { ...a, status: s, ended: now }
      }),
    )
  }
}

/** Runs collect.py once (it waits out another session's run, then finds its snapshot fresh).
 * A failure goes to the transcript once per distinct error and slows retries to RETRY_MS. */
async function collect($: EngineInterface) {
  let err = ''
  try {
    const r = await $.process.run(
      ['python3', `${$.plugin.root}/collect.py`, '--ttl', String(TTL_MS / 1000 - 2), ...self.collectArgs],
      { timeoutMs: 60_000 },
    )
    if (r.exitCode !== 0) err = `collect.py failed: ${r.stderr.trim().split('\n').pop() ?? `exit ${r.exitCode}`}`
  } catch (e) {
    err = `collect.py did not run: ${String(e)}`
  } finally {
    self.collecting = false
  }
  if (err && err !== self.lastError) $.ui.log(`hud: ${err}`)
  self.lastError = err
}

const OPEN = { id: PANE, title: 'hud', columns: 52 } as const

/** A docked pane the terminal grew too narrow for is moved inline above the prompt, a third of
 * the screen. Unless the person asked for it there, close it and open it again unasked: it then
 * waits undrawn, the band shows instead, and the surface docks it again once the terminal is
 * wide enough (144 columns; 110 once the person has opened it by hand). */
async function park($: EngineInterface) {
  if (self.parking) return
  self.parking = true
  try {
    await $.ui.close({ id: PANE })
    if (!self.muted) await $.ui.open(OPEN) // muted, the unmute opens it
  } finally {
    self.parking = false
  }
}

// ---- the module ----

export const register: Register = (on, options) => {
  relayGuard(on)
  const { remote, archive } = options
  self.collectArgs = [
    ...(typeof remote === 'string' && remote ? ['--remote', remote] : []),
    ...(typeof archive === 'string' && archive ? ['--archive', archive] : []),
  ]

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const home = (await $.env.get('HOME')) ?? ''
    const dir = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? '').replace(/\/$/, '')
    self.home = home
    // As collect.py's claude_acct: by the home's basename, ~/.claude being A.
    const base = (dir || '.claude').split('/').pop() ?? '.claude'
    self.me = base === '.claude' ? 'A' : base.slice(-1).toUpperCase()
    self.sid = await $.session.id()
    self.cwd = (await $.session.cwd()).split('/').pop() ?? ''
    if (!e.isInteractive) {
      // Headless runs (pool jobs, fleets: dozens at once) poll nothing. The agent hooks beat a
      // fleet's agents as they start and end; this keeps the beat fresh while they run.
      self.headless = true
      $.clock.every(BEAT_MS, () => void (self.lastBeat && reconcile($).then(() => beat($))))
      return started
    }
    await $.command.register({ name: 'hud', description: 'Toggle the hud pane: quota, machines, fan-outs, subagents' })
    const settings = (await $.settings.read()) as { tui?: string }
    self.fullscreen = settings.tui === 'fullscreen'
    if (self.fullscreen && (await $.store.get('closed')) !== true) {
      void $.ui.open(OPEN)
    }
    void tick($)
    $.clock.every(POLL_MS, () => void tick($))
    return started
  })

  // A window moved a whole point, or a turn ended: beat when the account's reading changed. A
  // headless run beats only once it has agents (dozens of pool jobs would churn files).
  on('session.measure', async ($, e, next) => {
    const limits = toLimits(e.rateLimits)
    const moved = limits && (limits.five !== self.limits?.five || limits.week !== self.limits?.week)
    if (limits) self.limits = limits
    if (moved && self.sid && (!self.headless || self.lastBeat)) await beat($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const { sid, me, cwd } = self
    if (!sid || (self.headless && !self.lastBeat)) return next(e) // a headless run with no agents never beat
    await $.fs.write(
      `${self.home}/.cache/hud/sessions/${sid}.json`,
      JSON.stringify({ id: sid, acct: me, cwd, running: 0, t: 0 }),
    )
    return next(e)
  })

  on('command.run', { command: 'hud' }, async $ => {
    // An open pane still waiting undrawn counts as closed: /hud is how to see it now.
    const isShown = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
    if (isShown) {
      await update($, asked, () => false)
      await $.ui.close({ id: PANE })
      await $.store.set('closed', true)
    } else {
      await update($, asked, () => true)
      await $.store.set('closed', false)
      await $.ui.open(OPEN)
    }
    await update($, paneRev, n => n + 1)
    return { text: isShown ? 'hud pane closed; the band shows instead.' : 'hud pane open.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await update($, asked, () => false)
      await $.store.set('closed', true)
    }
    const done = await next(e)
    if (e.id === PANE) await update($, paneRev, n => n + 1)
    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (self.sid && r.deny === undefined && r.agentId) {
      const id = r.agentId
      await update($, agents, list =>
        upsert(prune(list), id, a => ({ ...a, label: e.name ?? e.description, type: e.subagentType })),
      )
      await beat($)
    }
    return r
  })

  on('tool.call', ($, e, next) => {
    const id = e.agentId
    if (self.sid && id) {
      void update($, agents, list =>
        upsert(list, id, a => ({ ...a, tools: a.tools + 1, last: describe(e), seen: Date.now(), status: 'running', ended: undefined })),
      )
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (self.sid && id) {
      const status = e.reason === 'answer' ? 'done' : 'failed'
      await update($, agents, list => upsert(list, id, a => ({ ...a, status, ended: Date.now() })))
      await beat($)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, paneRev)
    if (e.viewport) self.rows = e.viewport.rows
    const s = await read($, snap)
    if (e.props.hasSurvey || s === null || self.muted) return next(e)
    const docked = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced && p.isShown)
    if (docked) return next(e)
    const n = fanout(s, await read($, agents), self.sid)
    const room = e.props.bodyColumns - 1
    let line = bandLine(s, self.me, n, 3)
    for (const tier of [0, 1, 2]) {
      const candidate = bandLine(s, self.me, n, tier)
      if (width(candidate) <= room) {
        line = candidate
        break
      }
    }
    return draw($.ui.resolve(e), [line])
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.viewport) self.rows = e.viewport.rows
    const s = await read($, snap)
    const mine = prune(await read($, agents))
    // Only fullscreen docks; on the main screen every pane is inline, and parking would loop.
    if (e.props.placement === 'inline' && !(await read($, asked)) && e.viewport?.isFullscreen === true) {
      $.clock.after(0, () => void park($))
      return draw($.ui.resolve(e), [[dim('…')]])
    }
    if (s === null) return draw($.ui.resolve(e), [[dim('collecting…')]])
    return draw($.ui.resolve(e), paneLines(s, self.me, mine, self.sid, e.props.bodyColumns, e.props.scroll.bodyRows))
  })
}

/** Lines of styled spans as a column of one-row Texts, on any surface. */
function draw({ Box, Text }: Elements[RenderSurface], lines: Line[]) {
  return (
    <Box flexDirection="column">
      {lines.map(line => (
        <Text wrap="truncate">
          {line.length === 0
            ? ' '
            : line.map(s => (
                <Text color={s.c} dimColor={s.dim} bold={s.bold}>
                  {s.t}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  )
}
