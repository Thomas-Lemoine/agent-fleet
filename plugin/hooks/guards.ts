import type { On } from 'claude-code'

// pkillGuard denies a shell command (Bash, or a Monitor's) that runs `pkill -f`, in every session
// and subagent.
//
// `pkill -f PATTERN` matches whole command lines. The shell running it has PATTERN in its own, and
// so does any other session's process that mentions it, so it kills its own shell and processes it
// never started. A command is denied when the word pkill appears in it anywhere (bare, as a path,
// quoted, behind sudo -u, xargs, ssh, if, …) with a -f flag among the words after it, up to the
// next ; & | or newline: -f, a cluster holding f like -9f, or --full and its abbreviations. Only
// an argument of a command that searches or edits text (grep, rg, sed, git, gh) is let through,
// so `grep -rn "pkill -f"` and a commit message that mentions it run. Everything else fails
// closed: a heredoc body or an echo that only mentions it is denied too, and costs a retry.
// `pgrep -f` only reads and `pkill name` matches process names, so both pass.

// group 1: the words after pkill, up to the end of its command (a backslash-newline is joined first).
const PKILL = /(?<![\w.-])pkill(?=[\s'"\\]|$)([^;&|\n]*)/g
const FULL = /^(?:-[A-Za-z0-9]*f[A-Za-z0-9]*|--f(?:u(?:ll?)?)?)$/
// The command a position sits in: its first word, past reserved words and VAR=x.
const FIRST = /\s*(?:(?:then|do|else|elif|if|while|until|!|\{|\w+=[^\s;&|]*)\s+)*([^\s;&|'"()]*)/y
// Commands that search or edit the text they are given, never run it.
const MENTIONS = /^(?:\S*\/)?(?:grep|egrep|fgrep|rg|ag|ack|sed|git|gh)$/

const DENY = "`pkill -f` matches its own shell and other sessions' processes; record `$!` or a pidfile at launch and kill that PID."

/** Whether `cmd` runs pkill with -f anywhere. One pass over it, so a long command stays cheap. */
export function runsPkillFull(command: string) {
  if (!command.includes('pkill')) return false // every Bash call comes through here
  const cmd = command.replace(/\\\n/g, ' ')
  // Quote state, the start of the current command and whether it only mentions text, carried
  // forward from one match to the next.
  let at = 0
  let quote = ''
  let start = 0
  let mentions: boolean | null = null
  for (const m of cmd.matchAll(PKILL)) {
    for (; at < m.index; at++) {
      const c = cmd[at]
      if (quote === "'") quote = c === "'" ? '' : quote
      else if (c === '\\') at++
      else if (quote === '"') quote = c === '"' ? '' : quote
      else if (c === "'" || c === '"') quote = c
      else if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(') [start, mentions] = [at + 1, null]
    }
    if (mentions === null) {
      FIRST.lastIndex = start
      mentions = MENTIONS.test(FIRST.exec(cmd)?.[1] ?? '')
    }
    if (mentions) continue
    for (const word of (m[1] ?? '').trim().split(/\s+/)) {
      const w = word.replace(/['"\\,()[\]{}]/g, '')
      if (w === '--') break
      if (FULL.test(w)) return true
    }
  }
  return false
}

export function pkillGuard(on: On) {
  on('tool.call', { tool: /^(Bash|Monitor)$/ }, ($, e, next) => {
    const command = e.tool === 'Bash' || e.tool === 'Monitor' ? e.command : undefined
    return command && runsPkillFull(command) ? { deny: DENY } : next(e)
  })
}
