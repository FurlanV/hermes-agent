// F15 slice 14: upstream's `thread-remount.test.tsx` (messages stay mounted across parent re-renders), unchanged, in the Athena layout (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread-remount.test'), {
  expects: ['assistant', 'user']
})
