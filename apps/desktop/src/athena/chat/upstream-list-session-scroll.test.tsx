// F15 slice 14: upstream's `thread/list-session-scroll.test.tsx` (session switch, scroll restore, stick-to-bottom while streaming), unchanged, in the Athena layout (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/list-session-scroll.test'), {
  expects: ['assistant', 'user']
})
