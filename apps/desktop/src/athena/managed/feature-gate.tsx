import type { ReactNode } from 'react'

import { useFeatureEntry } from './features'

/** Renders its children only while the feature filter allows `entry` (live). */
export function FeatureGate({ children, entry }: { children: ReactNode; entry: string }) {
  return useFeatureEntry(entry) ? <>{children}</> : null
}
