// F15 slice 07: upstream's `thread/user-message-text.test.tsx`, unchanged, with the user bubble's Athena code block
// shell provided (upstream-code-shell-suite.tsx).
import { AthenaUserCodeBlock } from './athena-code-block'
import { runUpstreamSuiteWithCodeShell } from './upstream-code-shell-suite'

await runUpstreamSuiteWithCodeShell(
  () => import('@/components/assistant-ui/thread/user-message-text.test'),
  AthenaUserCodeBlock
)
