// F15 slice 07: upstream's `markdown-text.artifacts.test.tsx`, unchanged, with the Athena code block shell provided
// (upstream-code-shell-suite.tsx).
import { AthenaCodeBlock } from './athena-code-block'
import { runUpstreamSuiteWithCodeShell } from './upstream-code-shell-suite'

await runUpstreamSuiteWithCodeShell(
  () => import('@/components/assistant-ui/markdown-text.artifacts.test'),
  AthenaCodeBlock
)
