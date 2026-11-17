/**
 * The substitution table behind the Athena edits to upstream renderer code.
 * Each patched upstream line is a one-line lookup here, so a rebase conflict
 * is one line and the values live in branding.json. See nous-inventory.md.
 */

import branding from './branding.json'

export const athenaStrings = {
  /** The product and the agent, wherever upstream text says Hermes (F14). */
  product: branding.display,
  /** Who makes and publishes the app. */
  organization: branding.organization,
  /** Where docs, support and release-note links point instead of Nous / GitHub. */
  supportUrl: branding.supportUrl,
  /** About text: SickKids as the maker, Hermes Agent credited under MIT. */
  copyright: branding.copyright,
  /** Nous-hosted services (Nous Portal sign-in, credits, trial) are switched off. */
  hideNousServices: true,
  /** F15: who said it, above each message in the Athena chat layout (English only; plan open question 3). */
  chat: {
    userLabel: 'You',
    /** The agent is the product: its name from branding.json. */
    agentLabel: branding.display,
    /** A tool call's row (slice 10): its state chip and the headings of what it opens to; a group's count. */
    tools: {
      state: { running: 'Running', done: 'Done', error: 'Failed' },
      input: 'Input',
      output: 'Output',
      waiting: 'Waiting for the result',
      noOutput: 'No output',
      /** How many calls a group of consecutive tool calls holds (slice 11). */
      calls: (count: number) => (count === 1 ? '1 call' : `${count} calls`)
    }
  }
} as const

/** OAuth provider ids that are Nous-hosted services. */
const NOUS_PROVIDER_IDS = new Set(['nous'])

/** True when an OAuth provider row must not be offered. */
export const isHiddenProvider = (id: string): boolean => athenaStrings.hideNousServices && NOUS_PROVIDER_IDS.has(id)

/** True when an env-key provider group (by prefix) must not be listed. */
export const isHiddenProviderGroup = (prefix: string): boolean => athenaStrings.hideNousServices && prefix === 'NOUS_'
