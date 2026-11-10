/**
 * Which `$HERMES_HOME/desktop-plugins/<folder>/plugin.js` files the disk loader may evaluate (F02 slice 29).
 *
 * Bundled plugins are part of the build and never come through here. A disk plugin is evaluated only when the
 * sha256 of its source is on the build's list (`desktop-plugins.json`: the Athena plugin built from athena's
 * `client/desktop-plugins/athena`), and it registers only when its default export declares the id listed with
 * that hash. Anything else (a `plugin.js` dropped into the folder, an agent plugin's desktop half copied there, an
 * edited Athena plugin) follows `managed.tools`:
 * - `enforce`: ignored, with a `[athena] desktop plugin … ignored` log line, and the refusal recorded;
 * - `report`: loaded, and the load recorded as `allowed_in_report` (a developer's rebuilt plugin loads this way);
 * - `off`: stock behaviour.
 * The hash is taken over the UTF-8 bytes of the source the loader is about to evaluate, so what is checked is what
 * runs. With no policy installed (tests, hosts without the Athena boot) every plugin loads, as upstream.
 */

import { atom } from 'nanostores'

import type { FeatureMode } from '../../../electron/athena/feature-registry'

import allowlist from './desktop-plugins.json'
import { decideUse } from './feature-use'

/** `null`: no policy installed (allow everything, decide nothing). */
export const $desktopPluginMode = atom<FeatureMode | null>(null)

/** Install the mode the gate follows (`null` restores allow-everything). Loaded plugins are re-checked on a change. */
export function setDesktopPluginMode(mode: FeatureMode | null): void {
  if ($desktopPluginMode.get() !== mode) {
    $desktopPluginMode.set(mode)
  }
}

/** Run `listener` when the gate's mode changes (the loader re-scans). Returns the unsubscribe. */
export function onDesktopPluginModeChanged(listener: () => void): () => void {
  return $desktopPluginMode.listen(() => listener())
}

const ALLOWED_IDS: ReadonlyMap<string, string> = new Map(
  allowlist.plugins.flatMap(plugin => plugin.sha256.map(hash => [hash.toLowerCase(), plugin.id] as const))
)

export async function sha256Hex(source: string): Promise<null | string> {
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))

    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

export interface DesktopPluginVerdict {
  allowed: boolean
  /** The id the plugin must declare (a listed hash); absent when any id may load. */
  id?: string
}

/** Whether the disk loader may evaluate `source` (from folder `origin`). Never throws. */
export async function desktopPluginVerdict(source: string, origin: string): Promise<DesktopPluginVerdict> {
  if ($desktopPluginMode.get() === null) {
    return { allowed: true }
  }

  const hash = await sha256Hex(source)
  const id = hash ? ALLOWED_IDS.get(hash) : undefined

  if (id) {
    return { allowed: true, id }
  }

  if (decideUse([`desktop-plugin:${origin}`], 'desktop-plugin', `${origin}/plugin.js`)) {
    return { allowed: true }
  }

  console.warn(
    `[athena] desktop plugin ${origin}/plugin.js ignored: sha256 ${hash ?? 'unavailable'} is not in this build's allowlist (managed.tools)`
  )

  return { allowed: false }
}
