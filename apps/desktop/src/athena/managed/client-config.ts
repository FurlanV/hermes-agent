/**
 * The renderer's copy of the verified client config (F02 slice 14).
 *
 * Electron main is the authority: it re-verifies the signed config, applies the
 * fallback ladder and the dev override, and pushes each new snapshot over
 * `window.athenaDesktop.clientConfig` (electron/athena/preload-bridge.ts). This
 * store only caches the latest snapshot; nothing here verifies or trusts disk.
 */

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'

import type { ClientConfigSnapshot } from '../../../electron/athena/client-config-types'
import branding from '../branding.json'

export type { ClientConfigSnapshot }

export interface AthenaClientConfigBridge {
  get: () => Promise<unknown>
  onChanged: (callback: (snapshot: unknown) => void) => () => void
  snapshot: unknown
}

declare global {
  interface Window {
    athenaDesktop?: { clientConfig?: AthenaClientConfigBridge }
  }
}

/** Null until a snapshot arrives (and outside Electron, where there is no bridge). */
export const $clientConfig = atom<ClientConfigSnapshot | null>(null)

const isSnapshot = (value: unknown): value is ClientConfigSnapshot =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as ClientConfigSnapshot).source === 'string' &&
  Boolean((value as ClientConfigSnapshot).config) &&
  typeof (value as ClientConfigSnapshot).config === 'object'

export function setClientConfigSnapshot(snapshot: unknown): void {
  if (isSnapshot(snapshot)) {
    $clientConfig.set(snapshot)
  }
}

/** Follow main's snapshots. Returns the unsubscribe; a no-op without the bridge. */
export function connectClientConfig(bridge: AthenaClientConfigBridge | undefined = window.athenaDesktop?.clientConfig) {
  if (!bridge) {
    return () => {}
  }

  setClientConfigSnapshot(bridge.snapshot)
  const off = bridge.onChanged(setClientConfigSnapshot)
  // The preload snapshot can predate a change that landed while the window loaded.
  void bridge.get().then(setClientConfigSnapshot, () => {})

  return off
}

export function useClientConfig(): ClientConfigSnapshot | null {
  return useStore($clientConfig)
}

const SOURCE_LABEL: Record<ClientConfigSnapshot['source'], string> = {
  bundled: 'built-in defaults',
  'last-good': 'last good',
  server: 'server'
}

/** "Managed by SickKids · role researcher · config v118 (server)". */
export function managedByLine(snapshot: ClientConfigSnapshot | null): string {
  const parts = [`Managed by ${branding.organization}`]

  if (!snapshot) {
    return `${parts[0]} · config not loaded`
  }

  parts.push(snapshot.role ? `role ${snapshot.role}` : 'no role')
  parts.push(
    snapshot.configVersion === null
      ? `config ${SOURCE_LABEL[snapshot.source]}`
      : `config v${snapshot.configVersion} (${SOURCE_LABEL[snapshot.source]})`
  )

  if (snapshot.devOverridesActive) {
    parts.push('dev overrides')
  }

  return parts.join(' · ')
}
