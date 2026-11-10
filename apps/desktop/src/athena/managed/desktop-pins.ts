/**
 * Desktop settings pinned by a disabled row (F02 slice 17). Most pins are
 * hermes config keys held in managed scope by `athena config apply`; these few
 * live in the renderer, so the renderer holds them:
 * - S36 inline embeds, "pinned off": while the row is off the embed mode is
 *   `off` (a plain link, nothing fetched from the third party) and standing
 *   per-service grants are cleared. Turning the row on leaves the mode where
 *   it is; the user picks again.
 * DevTools (S65) and keychain encryption (S87) are held in Electron main
 * (main-policy.ts, the `hermes:secret-storage:set` channel).
 */

import { $embedAllowed, $embedMode, clearEmbedAllowed, setEmbedMode } from '@/store/embed-consent'

import { $featureFilter, type FeatureFilter } from './features'

export const EMBEDS_ENTRY = 'setting:appearance.embeds'

export function applyDesktopPins(filter: FeatureFilter = $featureFilter.get()): void {
  if (filter(EMBEDS_ENTRY)) {
    return
  }

  if ($embedMode.get() !== 'off') {
    setEmbedMode('off')
  }

  if ($embedAllowed.get().length) {
    clearEmbedAllowed()
  }
}

/** Hold the pins while the filter refuses their row, also against a write from elsewhere. Returns the uninstall. */
export function installDesktopPins(): () => void {
  const offFilter = $featureFilter.subscribe(filter => applyDesktopPins(filter))
  const offMode = $embedMode.listen(() => applyDesktopPins())
  const offAllowed = $embedAllowed.listen(() => applyDesktopPins())

  return () => {
    offFilter()
    offMode()
    offAllowed()
  }
}
