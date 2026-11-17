// F15: upstream's `thread/process-notification.test.tsx`, unchanged, against the Athena note (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/process-notification.test'), {
  expects: ['note']
})
