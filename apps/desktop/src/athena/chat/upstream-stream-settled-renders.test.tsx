// F15: upstream's `thread/stream-settled-renders.test.tsx`, unchanged, against the Athena agent message (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/stream-settled-renders.test'), {
  expects: ['assistant']
})
