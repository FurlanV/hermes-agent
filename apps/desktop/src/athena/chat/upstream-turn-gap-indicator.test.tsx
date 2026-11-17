// F15: upstream's `thread/turn-gap-indicator.test.tsx`, unchanged, against the Athena agent message (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/turn-gap-indicator.test'), {
  expects: ['assistant']
})
