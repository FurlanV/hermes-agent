// F15: upstream's `thread/list-row-identity.test.tsx`, unchanged, against the Athena agent message (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/list-row-identity.test'), {
  expects: ['assistant']
})
