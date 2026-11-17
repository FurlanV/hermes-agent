/**
 * F14 slice 09: Settings › About credits Hermes Agent. Athena is a fork of Hermes Agent by Nous Research, used under
 * the MIT License; this block names the maker, links the upstream project and shows the licence. Athena build only:
 * without a client-config snapshot (no bridge) or in the stock variant it renders nothing.
 */

import { useId, useState } from 'react'

import { ExternalLink } from '@/lib/external-link'

// The fork's licence file at the repo root, bundled as text at build time so the shown licence cannot drift.
import licenseText from '../../../../LICENSE?raw'

import branding from './branding.json'
import { useClientConfig } from './managed/client-config'
import { athenaStrings } from './strings'

/** The upstream project Athena is forked from. Opened in the system browser, never in the in-app pane. */
export const UPSTREAM_URL = 'https://github.com/NousResearch/hermes-agent'

/** The MIT licence text, exactly as in the fork's `LICENSE`. */
export const FORK_LICENSE_TEXT: string = licenseText

/** "Athena is made by SickKids. It is a fork of Hermes Agent by Nous Research, used under the MIT License." */
export const forkCreditSentence = (): string =>
  `${branding.display} is made by ${athenaStrings.organization}. ` +
  'It is a fork of Hermes Agent by Nous Research, used under the MIT License.'

export function AthenaAboutCredit() {
  const snapshot = useClientConfig()
  const [open, setOpen] = useState(false)
  const licenseId = useId()

  if (!snapshot || snapshot.variant === 'stock') {
    return null
  }

  return (
    <section
      aria-label="Credits"
      className="mx-auto mt-3 grid w-full max-w-2xl justify-items-center gap-1 text-center text-xs text-(--ui-text-tertiary)"
      data-athena-about-credit=""
    >
      <p>{forkCreditSentence()}</p>
      <ExternalLink className="break-all" href={UPSTREAM_URL} native showExternalIcon>
        {UPSTREAM_URL}
      </ExternalLink>
      <button
        aria-controls={licenseId}
        aria-expanded={open}
        className="text-(--ui-text-secondary) underline-offset-2 hover:text-foreground hover:underline"
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        {open ? 'Hide licence' : 'View licence'}
      </button>
      {open && (
        <pre
          className="mt-1 w-full overflow-x-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-muted/20 px-3 py-3 text-left font-mono text-xs text-foreground"
          data-athena-license=""
          id={licenseId}
        >
          {FORK_LICENSE_TEXT}
        </pre>
      )}
    </section>
  )
}
