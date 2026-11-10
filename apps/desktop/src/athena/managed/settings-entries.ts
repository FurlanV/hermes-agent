/**
 * Stable entry ids for everything Settings lists, and the helpers each list
 * calls to ask the feature filter (`features.ts`).
 *
 * Id scheme (the feature registry maps plan row IDs to these):
 * - `settings:<view>`: a Settings page, `<view>` as in `?tab=` (`settings:billing`,
 *   `settings:config:model`, `settings:web-access`).
 * - `settings:<view>/<page>`: a child of that page, either a subpage (`?page=`,
 *   `settings:config:model/moa`, `settings:about/updates`) or a sub-view
 *   (`?pview=` / `?kview=` / `?bview=`: `settings:providers/local`,
 *   `settings:keys/tools`, `settings:billing/plans`).
 * - `config-field:<key>`: a config-schema field row (`config-field:model_context_length`).
 * - The search catalog's own row ids, unchanged from upstream:
 *   `setting:<view>.<kebab>` (manifest rows), `config-field:<key>`,
 *   `credential:<ENV_KEY>`, `plugin:desktop:<id>`, `plugin:agent:<key>`,
 *   `settings-page:<view>:<page>`.
 *
 * Denial is hierarchical: a denied page takes its children, fields and search
 * rows with it, so one id removes an entry from nav, palette, search and
 * subpages at once.
 */

import type { OverlayNavGroup } from '@/app/overlays/overlay-split-layout'
import type { SettingsSearchEntry, SettingsSearchTarget } from '@/app/settings/settings-search'

import { SUB_VIEW_DEFAULTS, SUB_VIEW_PARAMS } from '../../../electron/athena/app-locations'

import { $featureFilter, allowedEntries, type FeatureFilter } from './features'

const current = (): FeatureFilter => $featureFilter.get()

export const settingsPageEntryId = (view: string): string => `settings:${view}`

export const settingsSubpageEntryId = (view: string, page: string): string => `settings:${view}/${page}`

export const configFieldEntryId = (key: string): string => `config-field:${key}`

/** Pages whose children are selected by their own query param rather than `page=`. */
// Shared with Electron main (deep links): electron/athena/app-locations.ts.
export { SUB_VIEW_DEFAULTS, SUB_VIEW_PARAMS }

export function isSettingsPageAllowed(view: string, filter: FeatureFilter = current()): boolean {
  return filter(settingsPageEntryId(view))
}

export function isSettingsSubpageAllowed(view: string, page: string, filter: FeatureFilter = current()): boolean {
  return isSettingsPageAllowed(view, filter) && filter(settingsSubpageEntryId(view, page))
}

/** A config field row: its section page and its own id. */
export function isConfigFieldAllowed(sectionId: string, key: string, filter: FeatureFilter = current()): boolean {
  return isSettingsPageAllowed(`config:${sectionId}`, filter) && filter(configFieldEntryId(key))
}

/** Subpage registries: drop the children the filter refuses (same array when none are). */
export function allowedSettingsSubpages<P extends { id: string }>(
  view: string,
  pages: readonly P[],
  filter: FeatureFilter = current()
): readonly P[] {
  return allowedEntries(pages, page => isSettingsSubpageAllowed(view, page.id, filter))
}

/**
 * A Settings location (`?tab=…&page=…|pview=…|kview=…|bview=…`). Used by the
 * palette rows now; the route guard and deep links reuse it later.
 */
export function isSettingsLocationAllowed(params: URLSearchParams, filter: FeatureFilter = current()): boolean {
  const view = params.get('tab')

  if (!view) {
    return true
  }

  const subViewParam = SUB_VIEW_PARAMS[view]
  const page = params.get('page') ?? (subViewParam ? params.get(subViewParam) : null)

  return page ? isSettingsSubpageAllowed(view, page, filter) : isSettingsPageAllowed(view, filter)
}

/** The palette's `tab` strings: `'gateway'`, `'providers&pview=keys'`. */
export function isSettingsTabAllowed(tab: string, filter: FeatureFilter = current()): boolean {
  return isSettingsLocationAllowed(new URLSearchParams(`tab=${tab}`), filter)
}

// Nav child ids are `<view>:<page>` for subpages (and plugin pages) and
// `<pview|kview|bview>:<value>` for sub-views.
function navChildPage(view: string, childId: string): string | undefined {
  for (const prefix of [view, SUB_VIEW_PARAMS[view]]) {
    if (prefix && childId.startsWith(`${prefix}:`)) {
      return childId.slice(prefix.length + 1)
    }
  }

  return undefined
}

/** The Settings nav: drop refused pages and their refused children. */
export function filterSettingsNav<G extends OverlayNavGroup>(groups: G[], filter: FeatureFilter = current()): G[] {
  const kept = allowedEntries(groups, group => isSettingsPageAllowed(group.id, filter))

  const pruned = kept.map(group => {
    if (!group.children) {
      return group
    }

    const children = allowedEntries(group.children, child => {
      const page = navChildPage(group.id, child.id)

      return page === undefined || isSettingsSubpageAllowed(group.id, page, filter)
    })

    return children === group.children ? group : { ...group, children }
  })

  return pruned.every((group, index) => group === kept[index]) ? kept : pruned
}

type SubpageOf = (view: SettingsSearchTarget['view'], field?: string, setting?: string) => string | undefined

function searchTargetAllowed(target: SettingsSearchTarget, subpageOf: SubpageOf, filter: FeatureFilter): boolean {
  const page =
    target.subpage ?? subpageOf(target.view, target.field, target.setting) ?? target.keysView ?? target.providerView

  return page ? isSettingsSubpageAllowed(target.view, page, filter) : isSettingsPageAllowed(target.view, filter)
}

/**
 * Settings search rows: the row's own id, and the page / child it lands on
 * (`subpageOf` is `settingsSubpageForTarget`, passed in to keep this module
 * free of upstream runtime imports).
 */
export function allowedSettingsSearchEntries<E extends SettingsSearchEntry>(
  entries: E[],
  subpageOf: SubpageOf,
  filter: FeatureFilter = current()
): E[] {
  return allowedEntries(entries, entry => filter(entry.id) && searchTargetAllowed(entry.target, subpageOf, filter))
}
