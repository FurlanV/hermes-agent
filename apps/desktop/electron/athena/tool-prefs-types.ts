// Athena tool-prefs types shared by main and the renderer (no runtime imports, so the renderer can use them).

/** `$HERMES_HOME/athena/tool-prefs.json`'s `enabled` map: the user's own catalog toggles, by entry id. */
export type ToolPrefs = Record<string, boolean>

/** What `athena:tool-prefs:set` answers. */
export interface ToolToggleResult {
  /** The toggle reached `tool-prefs.json` (false: nothing changed on disk). */
  ok: boolean
  /** `athena config apply` rewrote managed scope (false: the file was written, the next sync applies it). */
  applied: boolean
  /** The prefs after the call, as read back from disk. */
  enabled: ToolPrefs
  /** One line for the user (the CLI's answer, or why it could not run). */
  message: string
}
