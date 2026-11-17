// F15: upstream's `thread/signed-out-transcript.test.tsx`, unchanged, against the Athena agent message (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/signed-out-transcript.test'), {
  expects: ['assistant']
})
