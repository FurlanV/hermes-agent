/**
 * The Athena feature filter: one answer to "may this entry be shown?" for
 * every list the renderer builds (Settings nav, subpages, config fields,
 * command palette, settings search).
 *
 * An entry is named by a stable entry id (see `settings-entries.ts` for the
 * Settings scheme). Today the filter allows everything, so the app looks and
 * behaves exactly like the branded D05 build. A later slice installs a filter
 * built from the feature registry (plan row IDs S01…S124 → entry ids) and the
 * signed client config; every list then narrows at once because they all ask
 * this one atom.
 */

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'

/** True when the entry may be offered. Must be pure and cheap: lists call it per row. */
export type FeatureFilter = (entryId: string) => boolean

export const ALLOW_ALL_FEATURES: FeatureFilter = () => true

/** The live filter. Components subscribe through `useFeatureFilter` so a config change re-renders them. */
export const $featureFilter = atom<FeatureFilter>(ALLOW_ALL_FEATURES)

/** Install a filter (`null` restores allow-everything). */
export function setFeatureFilter(filter: FeatureFilter | null): void {
  $featureFilter.set(filter ?? ALLOW_ALL_FEATURES)
}

export function isFeatureAllowed(entryId: string, filter: FeatureFilter = $featureFilter.get()): boolean {
  return filter(entryId)
}

/** Subscribe a component to filter changes; pass the result to the list helpers and into memo deps. */
export function useFeatureFilter(): FeatureFilter {
  return useStore($featureFilter)
}

/** Keep the allowed entries. Returns the same array when nothing is removed, so memo identity survives. */
export function allowedEntries<A extends readonly unknown[]>(entries: A, allowed: (entry: A[number]) => boolean): A {
  const kept = entries.filter(allowed)

  return kept.length === entries.length ? entries : (kept as unknown as A)
}
