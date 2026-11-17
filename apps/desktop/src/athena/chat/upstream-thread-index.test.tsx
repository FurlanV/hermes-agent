// F15 slice 14: upstream's `thread/index.test.tsx` (the message map keeps its identity across a session switch), unchanged, in the Athena layout (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/index.test'), {
  expects: []
})
