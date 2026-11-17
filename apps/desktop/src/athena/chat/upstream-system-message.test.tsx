// F15: upstream's `thread/system-message.test.tsx`, unchanged, against the Athena note (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/system-message.test'), {
  expects: ['note']
})
