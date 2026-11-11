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

/** One installed package (`tool-prefs.json` `installed.<id>`, written by `athena config tool <id> install`). */
export interface InstalledPackage {
  version: string
  sha256: string
  installed_at?: string
  scopes?: string[]
  tools?: string[]
  sends?: string[]
  /** Slice 22: the version a minor or patch update replaced, and when. */
  updated_from?: string
  updated_at?: string
  /** Slice 22: the listed version cannot run here (e.g. it needs a newer Athena): left out of new chats. */
  held?: { reason: string; version: string }
  /** Slice 22: a major update waits for the user to accept these changes: left out of new chats until then. */
  pending?: { changes: string[]; version: string }
}

export type InstalledPackages = Record<string, InstalledPackage>

/** What `athena:tool-prefs:package` does to one package. */
export type PackageAction = 'accept' | 'install' | 'remove'

/** What `athena:tool-prefs:package` answers. */
export interface PackageActionResult extends ToolToggleResult {
  installed: InstalledPackages
}
