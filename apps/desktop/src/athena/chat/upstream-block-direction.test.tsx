// F15: upstream's `thread/block-direction.test.tsx`, unchanged, against the Athena agent message (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/block-direction.test'), {
  expects: ['assistant']
})
