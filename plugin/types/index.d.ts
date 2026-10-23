// What collect.py writes to ~/.cache/hud/snapshot-v3.json, and the session's own subagents.

export type HudPool = {
  pid: number
  kind: 'codex' | 'claude'
  name: string
  model: string
  total: number
  /** Ids already ok when this run started (a resumed pool). */
  base: number
  done: number
  failed: number
  /** In flight per codex account letter, or one count where the account is picked per job. */
  inflight: Record<string, number> | number
  started: number
  t: number
}

export type HudMachineStats = {
  t: number
  ncpu: number
  load: number
  /** Busy %, all cores. */
  cpu: number
  /** Used %, as the memory brake counts it. */
  mem: number
  mem_total: number
  swap: number
  agents_gb: number
  /** [free GB, total GB] of the volume holding the user's files. */
  disk: [number, number]
  /** Claude processes per account: interactive sessions and headless `-p` runs, less a claude
   * pool's workers (its `inflight` counts those). */
  claude: Record<string, { live: number; headless: number }>
  /** Codex processes per account. */
  codex: Record<string, number>
  pools: HudPool[]
}

/** A machine with no reading: the remote's ssh failed, or this machine's own reading did (its
 * pools are still read, as they need no ps). */
export type HudMachine = HudMachineStats | { error: string; pools?: HudPool[] }

/** One account's 5-hour and weekly windows: used %, and resets as epoch s (null while a window
 * has not started). */
export type HudLimits = {
  t: number
  five: number
  five_reset: number | null
  week: number
  week_reset: number | null
}

/** The newest reading of an account: a session's measured limits, or claude-usage's probe,
 * which alone has the Fable week. */
export type HudClaudeUsage = HudLimits & { fable?: number | null }

export type HudCodexUsage = { t: number; week: number; week_reset: number }

/** One live Claude session's beat, written by its hud mod; a headless one only once it starts agents. */
export type HudSessionBeat = {
  id: string
  acct: string
  cwd: string
  running: number
  t: number
  headless?: boolean
  /** The terminal's height: of the sessions sharing a Ghostty tab the tallest keeps the hud. */
  rows?: number
  /** The rate limits this session last measured, for its account. */
  limits?: HudLimits | null
}

/** The rclone remote named by the `archive` option, read hourly. */
export type HudArchive = { t: number; name: string; free: number; total: number } | { t: number; error: string }

export type HudSnapshot = {
  t: number
  machines: Record<string, HudMachine>
  claude: Record<string, HudClaudeUsage>
  codex: Record<string, HudCodexUsage>
  /** The last codex-usage run: when, and why it failed (`codex` then keeps the accounts before). */
  codex_read: { t: number; error?: string } | null
  sessions: HudSessionBeat[]
  /** Null without the `archive` option. */
  archive: HudArchive | null
  /** Ghostty's split tabs as terminal titles (read every 30 s), or why the AppleScript failed. */
  ghostty: { t: number; tabs: string[][] } | { t: number; error: string } | null
  /** Sessions sharing a Ghostty tab with one that shows the hud: they draw none. */
  muted: string[]
  /** Per machine: [epoch s, cpu %, mem used %], oldest first. */
  hist: Record<string, [number, number, number][]>
  cost: { wall_ms: number; cpu_ms: number }
}

/** One subagent of this session (or a workflow's agent, which only its tool calls name). */
export type HudAgent = {
  id: string
  label: string
  type: string
  started: number
  /** The latest tool call's time: an agent nothing lists is done once this is old. */
  seen: number
  tools: number
  /** The latest tool call, short: `Bash pytest -x`. */
  last: string
  status: 'running' | 'done' | 'failed'
  ended?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-fleet': {
      /** Shaped: a hot reload of a mod whose snapshot format changed reads none, not the old one. */
      snap: Shaped<HudSnapshot | null>
      agents: HudAgent[]
      /** When each machine alert last toasted, so a flapping one does not repeat. */
      alerts: Record<string, number>
      /** Bumped when the pane opens or closes, so the band redraws to yield to it or take over. */
      paneRev: number
      /** The person opened the pane with /hud: it stays wherever the surface seats it, muted or
       * not. In state, so a hot reload keeps it. */
      asked: boolean
    }
  }
}
