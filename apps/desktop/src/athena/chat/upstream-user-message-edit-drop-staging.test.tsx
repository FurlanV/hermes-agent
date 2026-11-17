// F15: upstream's `thread/user-message-edit-drop-staging.test.tsx`, unchanged, against the Athena user message (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(
  () => import('@/components/assistant-ui/thread/user-message-edit-drop-staging.test')
)
