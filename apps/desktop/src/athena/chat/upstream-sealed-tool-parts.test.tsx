// F15: upstream's `thread/sealed-tool-parts.test.tsx`, unchanged, against the Athena agent message (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/sealed-tool-parts.test'), {
  expects: ['assistant']
})
