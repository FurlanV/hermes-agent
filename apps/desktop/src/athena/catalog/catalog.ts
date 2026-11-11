/**
 * The curated tool catalog on the Capabilities page (F02 slice 28, plan section D "What users see").
 *
 * The catalog comes from `currentCatalog()` (`catalog-source.ts`, F03 slice 02): today the bundled `catalog.json`,
 * a byte copy of the athena repo's `client/catalog/catalog.json` (built by `athena-build-catalog`;
 * `catalog-bundle.test.ts` fails when they drift). The role's client config says which
 * entries the user sees (`tools.available`) and which are locked; `tool-prefs.json` holds the user's own toggles.
 * Whether a card is on mirrors the applier (`athena_shipper.tool_pins.is_on`), so the page shows what the next
 * new chat gets.
 */

import type { PackageAccess } from '../../../electron/athena/tool-prefs-types'

import { BUNDLED_CATALOG, currentCatalog } from './catalog-source'

export { BUNDLED_CATALOG }

/** A remote package's tool group (F03): what an admin grants, with its data classification. */
export interface CatalogScope {
  classification: 'confidential' | 'internal' | 'public' | 'restricted'
  id: string
  title: string
  tools: string[]
}

/** One setting a package declares (F03); the page does not render settings yet. */
export interface CatalogSetting {
  choices?: string[]
  default?: boolean | null | number | string
  description?: null | string
  id: string
  maximum?: null | number
  minimum?: null | number
  title: string
  type: 'choice' | 'number' | 'text' | 'toggle'
}

/**
 * One `catalog.json` entry. The F03 package fields are optional: `catalog.json` leaves them out while unset, and a
 * newer catalog may carry fields this build does not know, which the page ignores.
 */
export interface CatalogEntry {
  category?: 'agent' | 'built-in' | 'database' | 'skill'
  default_on: boolean
  /** Example prompts for the detail view (F03 slice 20). */
  examples?: string[]
  group: string
  icon: string
  id: string
  kind: 'gateway' | 'mcp' | 'plugin' | 'skill' | 'toolset'
  owner: string
  permissions: {
    data: string[]
    executes_code: boolean
    filesystem: 'none' | 'read' | 'write'
    network: string[]
  }
  provides: { tools: string[]; toolsets: string[] }
  publisher?: { contact: string; name: string; team: string }
  requires_athena?: string
  requires_hermes: string
  results?: 'live-only'
  review: { at: string; by: string; notes: string }
  roles: string[]
  scopes?: CatalogScope[]
  settings?: CatalogSetting[]
  sha256: string
  skill?: { path: string; sha256: string }
  source: Record<string, unknown>
  /** `withdrawn`: listed, never on (as the applier and the guard decide). */
  status: 'deprecated' | 'experimental' | 'stable' | 'withdrawn'
  status_note?: { by: string; ends?: null | string; reason: string }
  summary: string
  title: string
  user_toggle: boolean
  version: string
  /** Entries this one needs to be useful (F03 slice 05): the card says so while one is off; nothing forces it on. */
  works_best_with?: string[]
}

export interface Catalog {
  catalog_version: string
  entries: Record<string, CatalogEntry>
  hermes_commit: string
}

export type ToolsMode = 'enforce' | 'off' | 'report'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** The master switch for tools (`managed.tools`); missing or unknown reads as `enforce`, never a silent opening. */
export function toolsMode(config: unknown): ToolsMode {
  const mode = isRecord(config) && isRecord(config.managed) ? config.managed.tools : undefined

  return mode === 'off' || mode === 'report' ? mode : 'enforce'
}

export interface ToolsSection {
  available: string[]
  default_on: string[]
  experimental: string[]
  locked_on: string[]
}

export function toolsSection(config: unknown): ToolsSection {
  const tools = isRecord(config) && isRecord(config.tools) ? config.tools : {}

  return {
    available: ids(tools.available),
    default_on: ids(tools.default_on),
    experimental: ids(tools.experimental),
    locked_on: ids(tools.locked_on)
  }
}

/**
 * "Need another tool? Ask Research IT": `tools.request_url` when the config has one (http, https or mailto),
 * else null and the link is hidden.
 */
export function requestToolsUrl(config: unknown): null | string {
  const tools = isRecord(config) && isRecord(config.tools) ? config.tools : {}
  const url = typeof tools.request_url === 'string' ? tools.request_url.trim() : ''

  return /^(https?:\/\/|mailto:)\S+$/i.test(url) ? url : null
}

export type CatalogCategory = NonNullable<CatalogEntry['category']>

export const CATEGORY_LABELS: Readonly<Record<CatalogCategory, string>> = Object.freeze({
  'built-in': 'Built-in',
  agent: 'Agents',
  database: 'Databases',
  skill: 'Skills'
})

export const CATEGORY_ORDER: readonly CatalogCategory[] = ['built-in', 'agent', 'database', 'skill']

const CLASSIFICATIONS: readonly CatalogScope['classification'][] = ['public', 'internal', 'confidential', 'restricted']

/** Built-in packages are installed for everyone: no Install, no Remove (F03 decision 1). */
export const isBuiltIn = (entry: CatalogEntry): boolean => (entry.category ?? 'built-in') === 'built-in'

export const categoryOf = (entry: CatalogEntry): CatalogCategory => entry.category ?? 'built-in'

/** The highest data classification of the package's scopes (the card's badge), or null without scopes. */
export function classificationOf(entry: CatalogEntry): CatalogScope['classification'] | null {
  const levels = (entry.scopes ?? []).map(scope => CLASSIFICATIONS.indexOf(scope.classification)).filter(i => i >= 0)

  return levels.length ? CLASSIFICATIONS[Math.max(...levels)] : null
}

/** The tools a package brings: a gateway package's remote tools, else the hermes tools it provides. */
export function packageTools(entry: CatalogEntry): string[] {
  const gateway = isRecord(entry.source) && isRecord(entry.source.gateway) ? entry.source.gateway : null

  return gateway ? ids(gateway.tools) : entry.provides.tools
}

/**
 * Whether the user has the package (the Installed view), as `athena_shipper.tool_pins.is_installed`: a built-in; one
 * the admin put in `locked_on` or `default_on`; one installed here (`tool-prefs.json` `installed`); or one with a
 * switch of its own. Anything else is in Browse only, with Install.
 */
export function entryIsInstalled(
  entry: CatalogEntry,
  tools: ToolsSection,
  prefs: Record<string, boolean>,
  installed: Record<string, unknown>
): boolean {
  return (
    isBuiltIn(entry) ||
    tools.locked_on.includes(entry.id) ||
    tools.default_on.includes(entry.id) ||
    entry.id in installed ||
    typeof prefs[entry.id] === 'boolean'
  )
}

/** What the installed record says about the listed version (F03 slice 22). */
export type PackageUpdate =
  | { changes: string[]; kind: 'review'; version: string }
  | { from: string; kind: 'updated' }
  | { kind: 'held'; reason: string }

const UPDATED_SHOWN_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The card's update line from the installed record: a major update waiting for review (left out of new chats until
 * accepted), a version this client cannot run (held, with why), or a recent minor/patch update ("Updated").
 */
export function packageUpdate(entry: CatalogEntry, record: unknown, now = Date.now()): null | PackageUpdate {
  if (!isRecord(record)) {
    return null
  }

  const held = isRecord(record.held) ? record.held : null
  const pending = isRecord(record.pending) ? record.pending : null

  if (held && held.version === entry.version) {
    return { kind: 'held', reason: String(held.reason ?? '') }
  }

  if (pending && pending.version === entry.version) {
    return { changes: ids(pending.changes), kind: 'review', version: entry.version }
  }

  const at = Date.parse(String(record.updated_at ?? ''))

  if (typeof record.updated_from === 'string' && record.version === entry.version && now - at < UPDATED_SHOWN_MS) {
    return { from: record.updated_from, kind: 'updated' }
  }

  return null
}

/**
 * What the user holds of a gateway package (F03 slice 26), from `package-access.json`: scope titles not granted yet,
 * split into requested and not. `blocked`: no scope granted (or the package is suspended), so new chats leave it out
 * (as `athena_shipper.package_access.withheld`) and the card offers Request access in place of the switch. The
 * capability gateway decides every call whatever this says.
 */
export interface CardAccess {
  blocked: boolean
  missing: string[]
  pending: string[]
  suspended: boolean
}

export function cardAccess(entry: CatalogEntry, access: null | PackageAccess): CardAccess | null {
  const held = access?.packages?.[entry.id]
  const scopes = entry.scopes ?? []

  if (!held || !isRecord(held.scopes) || scopes.length === 0) {
    return null
  }

  const state = (id: string) => held.scopes[id] ?? 'none'
  const suspended = held.state === 'suspended'

  return {
    blocked: suspended || !scopes.some(scope => state(scope.id) === 'granted'),
    missing: scopes.filter(scope => state(scope.id) === 'none').map(scope => scope.title),
    pending: scopes.filter(scope => state(scope.id) === 'requested').map(scope => scope.title),
    suspended
  }
}

export interface CatalogCard {
  /** Slice 26: what the user holds of a gateway package; null without scopes or without word from the platform. */
  access: CardAccess | null
  entry: CatalogEntry
  /** Slice 22: the update line, from the installed record. */
  update: null | PackageUpdate
  /** Installed for this user (built-ins always): in the Installed view; else in Browse with Install. */
  installed: boolean
  /** Installed by the user (not a built-in, not installed for the role by the admin): the card offers Remove. */
  removable: boolean
  /** `status: experimental`: the card shows a badge. */
  experimental: boolean
  /** No switch: `locked_on` in the config, `user_toggle: false` in the catalog (the admin decides), or withdrawn. */
  managed: boolean
  /** On for the next new chat. */
  on: boolean
  /** Titles of the `works_best_with` entries that are off for the next new chat (or not offered to the role). */
  worksBestWith: string[]
}

/**
 * On for new chats: withdrawn → off; locked → on; managed → whether the admin turned it on; else the user's toggle,
 * else default.
 */
export function entryIsOn(entry: CatalogEntry, tools: ToolsSection, prefs: Record<string, boolean>): boolean {
  if (entry.status === 'withdrawn') {
    return false
  }

  if (tools.locked_on.includes(entry.id)) {
    return true
  }

  const fallback = tools.default_on.includes(entry.id)

  if (!entry.user_toggle) {
    return fallback
  }

  return typeof prefs[entry.id] === 'boolean' ? prefs[entry.id] : fallback
}

/**
 * One card per `tools.available` id the catalog has (and, when the role is known, whose `roles` include it), in the
 * config's order. Nothing else is shown: a package the role may not see is not on the page at all.
 */
export function catalogCards(
  config: unknown,
  prefs: Record<string, boolean> = {},
  catalog: Catalog = currentCatalog().catalog,
  installed: Record<string, unknown> = {},
  role: null | string = null,
  access: null | PackageAccess = null
): CatalogCard[] {
  const tools = toolsSection(config)
  const cards: CatalogCard[] = []

  for (const id of new Set(tools.available)) {
    const entry = catalog.entries[id]

    if (entry && (!role || !Array.isArray(entry.roles) || entry.roles.includes(role))) {
      const held = cardAccess(entry, access)

      cards.push({
        access: held,
        entry,
        installed: entryIsInstalled(entry, tools, prefs, installed),
        update: packageUpdate(entry, installed[id]),
        removable:
          !isBuiltIn(entry) &&
          !tools.locked_on.includes(id) &&
          !tools.default_on.includes(id) &&
          entryIsInstalled(entry, tools, prefs, installed),
        experimental: entry.status === 'experimental',
        managed: tools.locked_on.includes(id) || !entry.user_toggle || entry.status === 'withdrawn',
        on: entryIsOn(entry, tools, prefs) && !held?.blocked,
        worksBestWith: missingCompanions(entry, tools, prefs, catalog)
      })
    }
  }

  return cards
}

/** The titles of `entry.works_best_with` entries that are not on for new chats; ids the catalog lacks are ignored. */
function missingCompanions(
  entry: CatalogEntry,
  tools: ToolsSection,
  prefs: Record<string, boolean>,
  catalog: Catalog
): string[] {
  return ids(entry.works_best_with).flatMap(id => {
    const other = catalog.entries[id]

    return other && !(tools.available.includes(id) && entryIsOn(other, tools, prefs)) ? [other.title] : []
  })
}

/** The card's note while a companion is off: "Works best with Files". */
export function worksBestWithLine(card: CatalogCard): null | string {
  return card.worksBestWith.length ? `Works best with ${card.worksBestWith.join(' and ')}` : null
}

const normalize = (text: string) => text.toLocaleLowerCase().trim()

export function cardMatches(card: CatalogCard, query: string): boolean {
  const q = normalize(query)

  if (!q) {
    return true
  }

  const { entry } = card

  const publisher = entry.publisher ? [entry.publisher.name, entry.publisher.team] : []

  return [
    entry.title,
    entry.summary,
    entry.group,
    entry.id,
    ...publisher,
    ...packageTools(entry),
    ...entry.provides.toolsets
  ].some(text => normalize(String(text)).includes(q))
}

/** Browse: cards matching `query` (and `category`, when set), grouped Built-in, Agents, Databases, Skills. */
export function groupByCategory(cards: CatalogCard[], query = '', category: CatalogCategory | null = null): CardGroup[] {
  return CATEGORY_ORDER.filter(c => !category || c === category)
    .map(c => ({
      cards: cards.filter(card => categoryOf(card.entry) === c && cardMatches(card, query)),
      group: CATEGORY_LABELS[c]
    }))
    .filter(group => group.cards.length > 0)
}

export interface CardGroup {
  cards: CatalogCard[]
  group: string
}

/** Cards matching `query`, grouped by the entry's `group` (groups A–Z, cards in the config's order). */
export function groupCards(cards: CatalogCard[], query = ''): CardGroup[] {
  const groups = new Map<string, CatalogCard[]>()

  for (const card of cards) {
    if (cardMatches(card, query)) {
      const group = card.entry.group || 'Other'
      groups.set(group, [...(groups.get(group) ?? []), card])
    }
  }

  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, items]) => ({ cards: items, group }))
}

/**
 * The card's status banner (F03 slice 21): deprecated with its end date, or withdrawn with who withdrew it and why.
 * Null for stable and experimental entries. A withdrawn package stays listed; it is never on.
 */
export function statusBanner(entry: CatalogEntry): null | { kind: 'deprecated' | 'withdrawn'; text: string } {
  const note = entry.status_note

  if (entry.status === 'deprecated') {
    const ends = note?.ends ? ` It will be withdrawn on ${note.ends}.` : ''

    return { kind: 'deprecated', text: `Deprecated by ${note?.by ?? 'its publisher'}: ${note?.reason ?? ''}${ends}`.trim() }
  }

  if (entry.status === 'withdrawn') {
    return { kind: 'withdrawn', text: `Withdrawn by ${note?.by ?? 'its publisher'}: ${note?.reason ?? ''}`.trim() }
  }

  return null
}

/** The card's "Sends:" line: what leaves the laptop, from the entry's reviewed permissions. */
export function sendsLine(entry: CatalogEntry): string {
  const data = entry.permissions.data.filter(Boolean)

  return data.length ? `Sends: ${data.join('; ')}` : 'Sends: nothing beyond your chat'
}

/** The skill names the catalog itself installs (kind `skill`): not "learned", even though hermes lists them as local. */
export function catalogSkillIds(catalog: Catalog = currentCatalog().catalog): Set<string> {
  return new Set(Object.values(catalog.entries).filter(entry => entry.kind === 'skill').map(entry => entry.id))
}
