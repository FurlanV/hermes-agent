/**
 * The Settings route guard (F02 slice 15). A route to a refused page, subpage
 * or sub-view lands on the Settings home with a quiet notice, like the
 * moved-tab redirects; an open page that becomes refused (a new config
 * arrived) closes the same way. A page whose default sub-view is refused while
 * another child is allowed (Providers with only Local models on) opens that
 * child instead, without a notice.
 */

import { useEffect } from 'react'

import type { OverlayNavGroup } from '@/app/overlays/overlay-split-layout'
import { notify } from '@/store/notifications'

import { settingsLocationEntries } from '../../../electron/athena/app-locations'

import type { FeatureFilter } from './features'
import {
  isSettingsLocationAllowed,
  isSettingsSubpageAllowed,
  SUB_VIEW_DEFAULTS,
  SUB_VIEW_PARAMS
} from './settings-entries'

export type SettingsRouteVerdict = 'first-child' | 'home' | 'ok'

export function settingsRouteVerdict(search: string, filter: FeatureFilter): SettingsRouteVerdict {
  const params = new URLSearchParams(search)
  const view = params.get('tab')

  if (!view) {
    return 'ok'
  }

  // The page, the child it names and any row it names (`field`, `setting`, `key`).
  if (!isSettingsLocationAllowed(params, filter) || !settingsLocationEntries(params).every(filter)) {
    return 'home'
  }

  const subViewParam = SUB_VIEW_PARAMS[view]

  if (subViewParam && !params.get('page') && !params.get(subViewParam)) {
    return isSettingsSubpageAllowed(view, SUB_VIEW_DEFAULTS[view], filter) ? 'ok' : 'first-child'
  }

  return 'ok'
}

export const FEATURE_UNAVAILABLE_NOTICE_ID = 'athena-feature-unavailable'

export function notifyFeatureUnavailable(): void {
  notify({
    durationMs: 3000,
    id: FEATURE_UNAVAILABLE_NOTICE_ID,
    kind: 'info',
    message: 'That page is not available in Athena.'
  })
}

interface SettingsRouteGuardOptions {
  filter: FeatureFilter
  /** The filtered nav (its first child of the active page is where `first-child` lands). */
  navGroups: readonly OverlayNavGroup[]
  /** Navigate to the Settings home (no query), replacing the refused entry. */
  openHome: () => void
  search: string
}

export function useSettingsRouteGuard({ filter, navGroups, openHome, search }: SettingsRouteGuardOptions): void {
  const verdict = settingsRouteVerdict(search, filter)
  const view = new URLSearchParams(search).get('tab')

  useEffect(() => {
    if (verdict === 'ok') {
      return
    }

    const firstChild =
      verdict === 'first-child' ? navGroups.find(group => group.id === view)?.children?.[0] : undefined

    if (firstChild?.onSelect) {
      firstChild.onSelect()

      return
    }

    openHome()
    notifyFeatureUnavailable()
  }, [navGroups, openHome, verdict, view])
}
