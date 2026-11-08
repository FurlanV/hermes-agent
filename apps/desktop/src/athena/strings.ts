/**
 * The substitution table behind the Athena edits to upstream renderer code.
 * Each patched upstream line is a one-line lookup here, so a rebase conflict
 * is one line and the values live in branding.json. See nous-inventory.md.
 */

import branding from './branding.json'

export const athenaStrings = {
  /** Who makes and publishes the app. */
  organization: branding.organization,
  /** Where docs, support and release-note links point instead of Nous / GitHub. */
  supportUrl: branding.supportUrl,
  /** About text: SickKids as the maker, Hermes Agent credited under MIT. */
  copyright: branding.copyright,
  /** Nous-hosted services (Nous Portal sign-in, credits, trial) are switched off. */
  hideNousServices: true
} as const

/** OAuth provider ids that are Nous-hosted services. */
const NOUS_PROVIDER_IDS = new Set(['nous'])

/** True when an OAuth provider row must not be offered. */
export const isHiddenProvider = (id: string): boolean => athenaStrings.hideNousServices && NOUS_PROVIDER_IDS.has(id)

/** True when an env-key provider group (by prefix) must not be listed. */
export const isHiddenProviderGroup = (prefix: string): boolean => athenaStrings.hideNousServices && prefix === 'NOUS_'
