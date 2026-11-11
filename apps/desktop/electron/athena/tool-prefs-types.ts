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

/** What `athena:tool-prefs:package` does to one package (`request`: ask the admins for access, F03 slice 26). */
export type PackageAction = 'accept' | 'install' | 'remove' | 'request'

/** `request`'s optional fields: why the user needs it (shown to the admins), at most 500 characters. */
export interface PackageActionOptions {
  reason?: string
}

/** One scope of a gateway package for this user, as the platform last said (`GET /me/packages`). */
export type ScopeAccess = 'granted' | 'none' | 'requested'

/**
 * `$HERMES_HOME/athena/package-access.json` (F03 slice 26), written by the CLI and the shipper at each sync: what
 * the user holds of each gateway package. A convenience for the page; the capability gateway decides every call.
 */
export interface PackageAccess {
  fetched_at?: string
  packages: Record<string, { scopes: Record<string, ScopeAccess>; state?: 'active' | 'suspended' }>
}

/** What `athena:tool-prefs:package` answers. */
export interface PackageActionResult extends ToolToggleResult {
  installed: InstalledPackages
  /** Slice 26: the access file after the call (older mains leave it out). */
  access?: PackageAccess
}

/** One package's settings value (F03 slice 27): text, a choice, a toggle or a number. */
export type SettingValue = boolean | number | string

/** `tool-prefs.json` `settings`: the user's values per package (`athena config settings <id>` writes them). */
export type PackageSettings = Record<string, Record<string, SettingValue>>

/** What `athena:tool-prefs:set-settings` answers. */
export interface SettingsResult {
  ok: boolean
  /** Managed scope was re-applied (the next new chat sends the values). */
  applied: boolean
  /** One line for the user: the CLI's answer, or why the values were refused. */
  message: string
  settings: PackageSettings
}
