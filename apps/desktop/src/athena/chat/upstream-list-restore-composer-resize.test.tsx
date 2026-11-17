// F15 slice 14: upstream's `thread/list-restore-composer-resize.test.tsx` (scroll restore against layout growth), unchanged, in the Athena layout (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(
  () => import('@/components/assistant-ui/thread/list-restore-composer-resize.test'),
  {
    expects: ['assistant', 'user']
  }
)
