// F15: upstream's `tool/inline-edit-persistence.test.tsx`, unchanged, against the Athena tool row (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/tool/inline-edit-persistence.test'), {
  expects: ['assistant']
})
