// F15: upstream's `tool/hide-code-diffs.test.tsx`, unchanged, against the Athena tool row (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/tool/hide-code-diffs.test'), {
  expects: ['assistant']
})
