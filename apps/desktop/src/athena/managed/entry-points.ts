/**
 * Entry points outside Settings (F02 slice 16): shortcuts, in-app links,
 * status-bar items, palette rows, slash commands, chat error-card buttons,
 * app pages. Each asks the same feature filter as Settings, keyed by the
 * registry's entry ids (`keybind:`, `route:`, `palette:`, `statusbar:`,
 * `slash:`, `error-action:`, …; see electron/athena/feature-registry.ts), and
 * an in-app path is judged by `electron/athena/app-locations.ts`, the same
 * function main uses for OS deep links.
 */

import { appPathAllowed, appPathEntries } from '../../../electron/athena/app-locations'

import { decideUse } from './feature-use'
import { $featureFilter, allowedEntries, type FeatureFilter } from './features'

const current = (): FeatureFilter => $featureFilter.get()

export const keybindEntryId = (actionId: string) => `keybind:${actionId}`

/**
 * A shortcut (or a plugin's `runAction`) may run. A refused one drops out of the panel and does nothing. Without a
 * filter it is a use (the dispatch): decided under the master switch and recorded (feature-use.ts).
 */
export function isKeybindAllowed(actionId: string, filter?: FeatureFilter): boolean {
  return filter ? filter(keybindEntryId(actionId)) : decideUse([keybindEntryId(actionId)], 'keybind', actionId)
}

/** An in-app path (`/cron`, `/settings?tab=billing`, `/command-center?section=usage`) may be opened. */
export function isAppPathAllowed(path: string, filter: FeatureFilter = current()): boolean {
  return appPathAllowed(path, filter)
}

/** For in-app open targets: the path when allowed, else null with a log line (like main's deep-link refusal). */
export function allowedOpenPath(path: string | null): string | null {
  if (path === null || isAppPathAllowed(path)) {
    return path
  }

  console.info(`[athena] open target refused by policy: ${path}`)

  return null
}

export const SLASH_NOT_AVAILABLE = 'Not available in Athena.'

const slashEntries = (names: readonly (string | undefined)[]) =>
  names.filter((name): name is string => Boolean(name)).map(name => `slash:${name.replace(/^\//, '').toLowerCase()}`)

/**
 * A slash command (by its typed name or canonical name) may run. Without a filter it is a use (the composer sent
 * it): decided under the master switch and recorded.
 */
export function isSlashCommandAllowed(names: readonly (string | undefined)[], filter?: FeatureFilter) {
  const entries = slashEntries(names)

  return filter ? entries.every(filter) : decideUse(entries, 'slash', names.find(Boolean) ?? '')
}

/** A slash command may be suggested (a list, not a use: nothing is recorded). */
export function isSlashCommandOffered(names: readonly (string | undefined)[], filter: FeatureFilter = current()) {
  return slashEntries(names).every(filter)
}

export function isErrorActionAllowed(actionId: string, filter: FeatureFilter = current()): boolean {
  return filter(`error-action:${actionId}`)
}

interface PaletteItemLike {
  action?: string
  id: string
}

interface PaletteGroupLike<I extends PaletteItemLike> {
  items: I[]
}

/** Palette rows: the row's own id and the shortcut action it runs. Same arrays when nothing is refused. */
export function allowedPaletteGroups<I extends PaletteItemLike, G extends PaletteGroupLike<I>>(
  groups: G[],
  filter: FeatureFilter = current()
): G[] {
  const pruned = groups.map(group => {
    const items = allowedEntries(
      group.items,
      item => filter(`palette:${item.id}`) && (!item.action || isKeybindAllowed(item.action, filter))
    )

    return items === group.items ? group : { ...group, items }
  })

  const kept = allowedEntries(pruned, group => group.items.length > 0)

  return kept.length === groups.length && kept.every((group, index) => group === groups[index]) ? groups : kept
}

interface StatusbarItemLike {
  actionId?: string
  id: string
  to?: string
}

/** Status-bar items: the item's id, the page it links to and the shortcut it stands for. */
export function allowedStatusbarItems<I extends StatusbarItemLike>(
  items: readonly I[],
  filter: FeatureFilter = current()
): readonly I[] {
  return allowedEntries(
    items,
    item =>
      filter(`statusbar:${item.id}`) &&
      (!item.to || isAppPathAllowed(item.to, filter)) &&
      (!item.actionId || isKeybindAllowed(item.actionId, filter))
  )
}

/** App pages outside Settings (Settings has its own guard): refused → the new-chat route. */
export function appRouteVerdict(pathname: string, search: string, filter: FeatureFilter = current()): 'home' | 'ok' {
  if (pathname === '/settings' || pathname.startsWith('/settings/')) {
    return 'ok'
  }

  return appPathEntries(`${pathname}${search}`).every(filter) ? 'ok' : 'home'
}

// Toast buttons: a recovery action is tagged with what it opens, and a refused one is left off the toast.
const ACTION_ENTRIES = new WeakMap<object, readonly string[]>()

/** Tag a toast action with the in-app path it opens (`/settings?tab=keys&key=…`). */
export function routeAction<A extends object>(path: string, action: A): A {
  ACTION_ENTRIES.set(action, appPathEntries(path))

  return action
}

/** Tag a toast action with the entry it reaches when it opens no path (`command-center:update-hermes`). */
export function entryAction<A extends object>(entryId: string, action: A): A {
  ACTION_ENTRIES.set(action, [entryId])

  return action
}

/** The action, or undefined when it leads to a refused feature. */
export function allowedNotificationAction<A extends object>(
  action: A | undefined,
  filter: FeatureFilter = current()
): A | undefined {
  const entries = action ? ACTION_ENTRIES.get(action) : undefined

  return entries && !entries.every(filter) ? undefined : action
}
