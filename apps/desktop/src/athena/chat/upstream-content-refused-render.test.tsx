// F15: upstream's `thread/content-refused-render.test.tsx`, unchanged, against the Athena note (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/content-refused-render.test'), {
  expects: ['note']
})
