/**
 * In-page hiding for Settings rows that live on a page rather than in a list
 * (F02 slice 15). Hand-built rows carry `id="setting-field-<view>.<kebab>"`
 * and env-credential cards `id="credential-key-<KEY>"`; a refused
 * `setting:` / `credential:` entry gets a `display: none` rule, so the row
 * leaves its page without a hook in each upstream component. Their search
 * rows and pages are filtered by the feature filter as usual.
 */

import { registeredEntries } from '../../../electron/athena/feature-registry'

import { $featureFilter, type FeatureFilter } from './features'

const DOM_IDS: readonly (readonly [entryPrefix: string, domPrefix: string])[] = [
  ['setting:', 'setting-field-'],
  ['credential:', 'credential-key-']
]

const STYLE_ID = 'athena-hidden-settings-rows'

const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`

/** CSS hiding every registered in-page row the filter refuses ('' when none). */
export function hiddenRowsCss(filter: FeatureFilter): string {
  const selectors: string[] = []

  for (const entry of registeredEntries()) {
    const mapping = DOM_IDS.find(([prefix]) => entry.startsWith(prefix))

    if (!mapping || filter(entry)) {
      continue
    }

    const rest = entry.slice(mapping[0].length)

    selectors.push(
      rest.endsWith('*') ? `[id^=${quote(mapping[1] + rest.slice(0, -1))}]` : `[id=${quote(mapping[1] + rest)}]`
    )
  }

  return selectors.length ? `${selectors.join(',\n')} { display: none !important; }\n` : ''
}

/** Keep a `<style>` in sync with the live filter; returns the uninstall. */
export function installHiddenRowsStyle(doc: Document = document): () => void {
  const style = doc.createElement('style')
  style.id = STYLE_ID
  doc.head.append(style)

  const off = $featureFilter.subscribe(filter => {
    style.textContent = hiddenRowsCss(filter)
  })

  return () => {
    off()
    style.remove()
  }
}
