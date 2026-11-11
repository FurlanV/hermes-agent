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

export interface CatalogCard {
  entry: CatalogEntry
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

/** One card per `tools.available` id this build's catalog has, in the config's order. Nothing else is shown. */
export function catalogCards(
  config: unknown,
  prefs: Record<string, boolean> = {},
  catalog: Catalog = currentCatalog().catalog
): CatalogCard[] {
  const tools = toolsSection(config)
  const cards: CatalogCard[] = []

  for (const id of new Set(tools.available)) {
    const entry = catalog.entries[id]

    if (entry) {
      cards.push({
        entry,
        experimental: entry.status === 'experimental',
        managed: tools.locked_on.includes(id) || !entry.user_toggle || entry.status === 'withdrawn',
        on: entryIsOn(entry, tools, prefs),
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

  return [entry.title, entry.summary, entry.group, entry.id, ...entry.provides.tools, ...entry.provides.toolsets].some(
    text => normalize(text).includes(q)
  )
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

/** The card's "Sends:" line: what leaves the laptop, from the entry's reviewed permissions. */
export function sendsLine(entry: CatalogEntry): string {
  const data = entry.permissions.data.filter(Boolean)

  return data.length ? `Sends: ${data.join('; ')}` : 'Sends: nothing beyond your chat'
}

/** The skill names the catalog itself installs (kind `skill`): not "learned", even though hermes lists them as local. */
export function catalogSkillIds(catalog: Catalog = currentCatalog().catalog): Set<string> {
  return new Set(Object.values(catalog.entries).filter(entry => entry.kind === 'skill').map(entry => entry.id))
}
