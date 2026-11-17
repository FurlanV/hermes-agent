// F15: upstream's `thread/assistant-message.test.tsx`, unchanged, against the Athena agent message (upstream-suite.ts):
// its error-card cases (copy, actions, details, dismiss, scheduled retry) run in the Athena layout too (slice 12).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/assistant-message.test'), {
  expects: ['assistant']
})
