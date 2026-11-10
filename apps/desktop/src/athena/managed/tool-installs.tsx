/**
 * The renderer's half of closing the tool install paths (F02 slice 29). Electron main refuses the REST calls, IPC
 * channels and OS deep links, and the JSON-RPC seam refuses the RPCs (electron/athena/tool-install-policy.ts, under
 * `managed.tools`). Here:
 * - install dialogs and lookups the renderer opens by itself (the plugin install dialog, the MCP and skill
 *   deep-link confirmations, the plugin catalog lookup) ask `toolInstallAllowed(…)`: a use, decided and recorded
 *   like a JSON-RPC call;
 * - the in-chat install cards (`manage_catalog`, `manage_connections`) and the setup chat's plugins and connectors
 *   beats are a list: not shown while `managed.tools` is `enforce` (`useToolInstallsVisible`);
 * - the desktop-plugin loader follows the same mode (desktop-plugin-gate.ts).
 * Every hook allows everything until `installToolInstallPolicy` runs (boot.ts), and in the stock variant.
 */

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { type ComponentType, type FC, useEffect, useRef } from 'react'

import { managedMode } from '../../../electron/athena/feature-registry'

import { $clientConfig } from './client-config'
import { setDesktopPluginMode } from './desktop-plugin-gate'
import { decideUse } from './feature-use'

/** Whether install cards and beats are shown (false only under `managed.tools: enforce` in the Athena variant). */
export const $toolInstallsVisible = atom(true)

/** Follow `$clientConfig`; returns the unsubscribe (which restores allow-everything). */
export function installToolInstallPolicy(): () => void {
  const off = $clientConfig.subscribe(snapshot => {
    const mode = snapshot?.variant === 'stock' ? null : managedMode(snapshot?.config ?? {}, 'tools')
    $toolInstallsVisible.set(mode !== 'enforce')
    setDesktopPluginMode(mode)
  })

  return () => {
    off()
    $toolInstallsVisible.set(true)
    setDesktopPluginMode(null)
  }
}

export function useToolInstallsVisible(): boolean {
  return useStore($toolInstallsVisible)
}

/**
 * A renderer-only install use (`ui:plugin-install`, `ui:mcp-install`, `ui:skill-install`,
 * `ui:plugin-catalog-lookup`): refused and recorded under `enforce`, recorded under `report`.
 */
export function toolInstallAllowed(entry: `ui:${string}`, target: string): boolean {
  if (decideUse([entry], 'ui', target)) {
    return true
  }

  console.info(`[athena] ${entry} refused by policy (managed.tools): ${target}`)

  return false
}

/**
 * In place of a setup-chat beat that offers installs (plugins, connectors) while they are not shown: no card, and
 * the beat is answered once with "nothing added", as if skipped, so the setup chat moves on instead of waiting.
 */
export function SkippedInstallBeat({ onSkip }: { onSkip: () => unknown }) {
  const skip = useRef(onSkip)

  useEffect(() => {
    skip.current()
  }, [])

  return null
}

/** An in-chat install card, or `Fallback` (the plain tool row) while install cards are not shown. */
export function gateInstallCard<P extends object>(Card: ComponentType<P>, Fallback: ComponentType<P>): FC<P> {
  const AthenaInstallCard: FC<P> = props => {
    const Shown = useToolInstallsVisible() ? Card : Fallback

    return <Shown {...props} />
  }

  AthenaInstallCard.displayName = 'AthenaInstallCard'

  return AthenaInstallCard
}
