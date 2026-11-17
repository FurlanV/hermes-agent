// F15: upstream's `thread/preview-embeds.test.tsx`, unchanged, against the Athena agent message (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/preview-embeds.test'), {
  expects: ['assistant']
})
