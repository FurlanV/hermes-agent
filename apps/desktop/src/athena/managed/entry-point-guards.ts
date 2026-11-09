/**
 * Live policies for surfaces outside Settings (F02 slice 16) that have no
 * single list to filter: the sidebar nav rows (through core's own
 * `sidebarNav.prefs` area), the terminal pane, bundled plugins (Bot Mode), and
 * the app route guard.
 */

import { useEffect } from 'react'

import { isPaneVisible, togglePaneVisible } from '@/components/pane-shell/tree/store'
import { $pluginRecords, patchPlugin, pluginActive, pluginPolicyHandle } from '@/contrib/plugins-store'
import { registry } from '@/contrib/registry'
import { SIDEBAR_NAV_PREFS_AREA, type SidebarNavPrefsContribution } from '@/store/sidebar-nav'

import { appRouteVerdict } from './entry-points'
import { $featureFilter, type FeatureFilter, useFeatureFilter } from './features'
import { notifyFeatureUnavailable } from './settings-route-guard'

/** Core sidebar nav rows the registry may hide (`nav:<id>`). */
const SIDEBAR_ROWS = ['messaging', 'artifacts', 'cron'] as const

/** Bundled plugins under a flag (`plugin:<id>`), with the plugin's own default. */
const POLICY_PLUGINS: Readonly<Record<string, boolean>> = { 'hermes-bots': true }

const SIDEBAR_CONTRIBUTION_ID = 'athena-managed'

export function sidebarRowsToHide(filter: FeatureFilter): string[] {
  return SIDEBAR_ROWS.filter(id => !filter(`nav:${id}`))
}

/** Turn a flagged bundled plugin off (it stays listed) or back on (unless the user switched it off). */
export function applyPluginPolicy(id: string, allowed: boolean): void {
  const handle = pluginPolicyHandle(id)
  const loaded = $pluginRecords.get()[id]?.status === 'loaded'

  if (!handle) {
    return
  }

  if (!allowed && loaded) {
    handle.deactivate()
    patchPlugin(id, { status: 'disabled' })
  } else if (allowed && !loaded && pluginActive(id, POLICY_PLUGINS[id] ?? true)) {
    void handle.activate()
  }
}

function apply(filter: FeatureFilter): void {
  const data: SidebarNavPrefsContribution = { hide: sidebarRowsToHide(filter) }
  registry.register({ area: SIDEBAR_NAV_PREFS_AREA, data, id: SIDEBAR_CONTRIBUTION_ID, source: 'athena' })

  if (!filter('pane:terminal') && isPaneVisible('terminal')) {
    togglePaneVisible('terminal')
  }

  for (const id of Object.keys(POLICY_PLUGINS)) {
    applyPluginPolicy(id, filter(`plugin:${id}`))
  }
}

/** Follow the feature filter; returns the uninstall. */
export function installEntryPointPolicies(): () => void {
  const off = $featureFilter.subscribe(apply)

  return () => {
    off()
    registry.register({ area: SIDEBAR_NAV_PREFS_AREA, data: { hide: [] }, id: SIDEBAR_CONTRIBUTION_ID, source: 'athena' })
  }
}

/** App pages outside Settings: a refused one (typed, linked or open when the config changed) goes to a new chat. */
export function useAppRouteGuard(pathname: string, search: string, goHome: () => void): void {
  const verdict = appRouteVerdict(pathname, search, useFeatureFilter())

  useEffect(() => {
    if (verdict === 'home') {
      goHome()
      notifyFeatureUnavailable()
    }
  }, [goHome, verdict])
}
