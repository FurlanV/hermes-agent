// F15: upstream's `thread/inter-agent-collapse.test.tsx`, unchanged, against the Athena agent message (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/inter-agent-collapse.test'), {
  expects: ['assistant']
})
