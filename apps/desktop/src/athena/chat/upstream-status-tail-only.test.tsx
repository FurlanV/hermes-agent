// F15: upstream's `thread/status-tail-only.test.tsx`, unchanged, against the Athena agent message (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/status-tail-only.test'), {
  expects: ['assistant']
})
