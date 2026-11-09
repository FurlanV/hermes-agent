// Athena: the local policy-decisions file (F02 slices 17 and 19).
//
// Electron main appends one JSON object per line to
// `$HERMES_HOME/athena/policy-decisions.jsonl` for each decision worth
// recording: a refusal in `enforce` mode, and each use of a disabled feature
// in `report` mode. The Athena Shipper tails the file (it keeps an offset and
// starts over when the file shrinks) and turns every line into one
// `athena:policy_decision` synthetic event; nothing in the app writes the
// capture queue itself. `athena_guard` appends to the same file with
// `source: "guard"`.
//
// Line contract (shared with the other writers):
//   {"ts": ISO-8601, "source": "desktop"|"guard", "kind": "feature"|"model"|"tool",
//    "id": <row id / model alias / tool name>, "action": "allowed_in_report"|"refused"|…,
//    "mode": "enforce"|"report"|"off", "surface": <entry kind, or rest/rpc/ipc>,
//    "target"?: <what was called, optional>}
//
// The same decision repeated within `coalesceMs` (a page polling a refused
// endpoint) is written once. Past `maxBytes` the file is started over; the
// Shipper notices the truncation.

import fs from 'node:fs'
import path from 'node:path'

export const POLICY_DECISIONS_FILE = 'policy-decisions.jsonl'

export type PolicyDecisionKind = 'feature' | 'model' | 'tool'
export type PolicyDecisionMode = 'enforce' | 'off' | 'report'

export interface PolicyDecisionLine {
  action: string
  id: string
  kind: PolicyDecisionKind
  mode: PolicyDecisionMode
  source: 'desktop' | 'guard'
  surface: string
  target?: string
  ts: string
}

export type PolicyDecisionInput = Omit<PolicyDecisionLine, 'source' | 'ts'>

export interface PolicyDecisionLogOptions {
  /** Default 5 s. */
  coalesceMs?: number
  file: string
  log?: (line: string) => void
  /** Default 1 MiB. */
  maxBytes?: number
  now?: () => number
}

const KINDS = new Set(['feature', 'model', 'tool'])
const MODES = new Set(['enforce', 'off', 'report'])
const clip = (value: unknown, max = 200) => String(value ?? '').slice(0, max)

/** A decision from an untrusted sender (the renderer), or null when it is malformed. */
export function parsePolicyDecision(value: unknown): null | PolicyDecisionInput {
  if (!value || typeof value !== 'object') {
    return null
  }

  const raw = value as Record<string, unknown>

  if (
    typeof raw.id !== 'string' ||
    !raw.id ||
    typeof raw.action !== 'string' ||
    !raw.action ||
    typeof raw.surface !== 'string' ||
    !KINDS.has(String(raw.kind ?? 'feature')) ||
    !MODES.has(String(raw.mode))
  ) {
    return null
  }

  return {
    action: clip(raw.action, 40),
    id: clip(raw.id, 120),
    kind: String(raw.kind ?? 'feature') as PolicyDecisionKind,
    mode: raw.mode as PolicyDecisionMode,
    surface: clip(raw.surface, 40),
    ...(raw.target === undefined ? {} : { target: clip(raw.target) })
  }
}

export class PolicyDecisionLog {
  private readonly coalesceMs: number
  private readonly lastWritten = new Map<string, number>()
  private readonly maxBytes: number
  private readonly now: () => number

  constructor(private readonly options: PolicyDecisionLogOptions) {
    this.coalesceMs = options.coalesceMs ?? 5000
    this.maxBytes = options.maxBytes ?? 1024 * 1024
    this.now = options.now ?? Date.now
  }

  get file(): string {
    return this.options.file
  }

  /** Append one decision (from main, or a renderer record that `parsePolicyDecision` accepted). Never throws. */
  record(decision: PolicyDecisionInput): boolean {
    const now = this.now()
    const key = [decision.kind, decision.id, decision.action, decision.mode, decision.surface, decision.target].join('\u0000')
    const last = this.lastWritten.get(key)

    if (last !== undefined && now - last < this.coalesceMs) {
      return false
    }

    const line: PolicyDecisionLine = { ts: new Date(now).toISOString(), source: 'desktop', ...decision }

    try {
      fs.mkdirSync(path.dirname(this.options.file), { recursive: true })

      try {
        if (fs.statSync(this.options.file).size > this.maxBytes) {
          fs.truncateSync(this.options.file, 0)
        }
      } catch {
        // no file yet
      }

      fs.appendFileSync(this.options.file, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 })
      this.lastWritten.set(key, now)

      if (this.lastWritten.size > 500) {
        for (const [entry, at] of this.lastWritten) {
          if (now - at >= this.coalesceMs) {
            this.lastWritten.delete(entry)
          }
        }
      }

      return true
    } catch (error) {
      this.options.log?.(`[athena] policy decision not recorded: ${error instanceof Error ? error.message : String(error)}`)

      return false
    }
  }
}
