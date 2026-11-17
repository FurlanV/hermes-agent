// F15: upstream's `thread/reaction-picker-focus-follow.test.tsx`, unchanged, against the Athena agent message (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(
  () => import('@/components/assistant-ui/thread/reaction-picker-focus-follow.test'),
  { expects: ['assistant'] }
)
