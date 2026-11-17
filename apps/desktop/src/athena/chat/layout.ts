/**
 * F15: the Athena chat layout switch. The thread (`src/components/assistant-ui/thread/index.tsx`, the one choke
 * point) asks it which message components to use and whether to mark its root.
 *
 * Active when the build is the Athena variant (the same reading as the brand pass, `athenaBrandActive`) and feature
 * row `F15` is on (entry `chat:athena-layout`, a `keep` row: on by default, an admin turns it off per role). The row
 * is read live from the feature filter, so a new client config flips the layout without a rebuild. In a stock build,
 * or with the row off, the thread is upstream's: the upstream components and no marker on the root.
 */
import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'

import { athenaBrandActive } from '../brand-text'
import { $featureFilter, isFeatureAllowed } from '../managed/features'

/** The feature-registry entry behind row F15. */
export const ATHENA_CHAT_ENTRY = 'chat:athena-layout'

/** The marker on the thread root while the Athena layout is active; Athena chat CSS is scoped under it. */
export const ATHENA_CHAT_ATTR = 'data-athena-chat'

// A boolean, not the filter: the thread re-renders only when the row's answer changes, not on every new filter.
const $athenaChatRow = computed($featureFilter, filter => isFeatureAllowed(ATHENA_CHAT_ENTRY, filter))

/** True while the Athena chat layout is active (Athena variant and row F15 on). */
export function useAthenaChatLayout(): boolean {
  const rowOn = useStore($athenaChatRow)

  return rowOn && athenaBrandActive()
}

/**
 * The message components the thread hands its list. `upstream` is the thread's own memoized map; the result must
 * keep its identity for as long as `upstream` and `active` do (the values are component types: a new map remounts
 * every visible message). Today both sides return the upstream map; later F15 slices return Athena components when
 * `active`.
 */
export function athenaMessageComponents<M>(active: boolean, upstream: M): M {
  void active

  return upstream
}

export type AthenaThreadRootProps = Readonly<{ [ATHENA_CHAT_ATTR]?: '' }>

const NO_ROOT_PROPS: AthenaThreadRootProps = Object.freeze({})
const ACTIVE_ROOT_PROPS: AthenaThreadRootProps = Object.freeze({ [ATHENA_CHAT_ATTR]: '' })

/** Props to spread on the thread root: the marker attribute while active, nothing otherwise. */
export function useAthenaThreadRootProps(active: boolean): AthenaThreadRootProps {
  return active ? ACTIVE_ROOT_PROPS : NO_ROOT_PROPS
}
