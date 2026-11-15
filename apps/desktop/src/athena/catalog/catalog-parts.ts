/**
 * A package's sources on the Capabilities page (F11): the parts a catalog entry declares, each with the switch state
 * the applier would pin for the next new chat (athena: `athena_shipper.tool_pins.part_on`).
 *
 * A part's switch is `tool-prefs.json` `enabled["<id>/<part>"]`, beside the package's own. A part is on only while
 * its package is on; then, for a package with a user switch, the user's part switch decides, else the role default:
 * `tools.parts.default_on` in the client config (an entry none of whose parts it names starts with every part on).
 * A package without a user switch (`user_toggle: false`) follows the role defaults for its parts.
 */

import type { CatalogEntry, CatalogPart } from './catalog'

export interface PartCard {
  part: CatalogPart
  /** `<entry id>/<part id>`: the key in `tool-prefs.json` and the CLI's argument. */
  ref: string
  /** The part's own state: what it is once its package is on. */
  on: boolean
  /** The package is off: the part is off too, and its switch waits for the package. */
  packageOff: boolean
  /** No user switch here: the package is admin-decided (`user_toggle: false`). */
  managed: boolean
}

export interface PartLists {
  default_on: string[]
  locked_off: string[]
  locked_on: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export const partRef = (entryId: string, partId: string): string => `${entryId}/${partId}`

/** The client config's `tools.parts` (empty lists when it has none, as every config from before F11). */
export function partLists(config: unknown): PartLists {
  const tools = isRecord(config) && isRecord(config.tools) ? config.tools : {}
  const parts = isRecord(tools.parts) ? tools.parts : {}

  return { default_on: ids(parts.default_on), locked_off: ids(parts.locked_off), locked_on: ids(parts.locked_on) }
}

/** The role default of one part: on, unless `default_on` names another part of the same entry and not this one. */
export function partDefault(entryId: string, partId: string, lists: PartLists): boolean {
  const ref = partRef(entryId, partId)

  return lists.default_on.includes(ref) || !lists.default_on.some(id => id.startsWith(`${entryId}/`))
}

/** The parts an entry declares that are well formed (a newer catalog may carry fields this build ignores). */
export function entryParts(entry: CatalogEntry): CatalogPart[] {
  return (Array.isArray(entry.parts) ? entry.parts : []).filter(
    (part): part is CatalogPart => isRecord(part) && typeof part.id === 'string' && typeof part.label === 'string'
  )
}

/** One row per part of `entry`, for a package whose own state for the next new chat is `packageOn`. */
export function partCards(
  entry: CatalogEntry,
  config: unknown,
  prefs: Record<string, boolean>,
  packageOn: boolean
): PartCard[] {
  const lists = partLists(config)

  return entryParts(entry).map(part => {
    const ref = partRef(entry.id, part.id)
    const fallback = partDefault(entry.id, part.id, lists)
    const own = entry.user_toggle && typeof prefs[ref] === 'boolean' ? prefs[ref] : fallback

    return { managed: !entry.user_toggle, on: own, packageOff: !packageOn, part, ref }
  })
}
