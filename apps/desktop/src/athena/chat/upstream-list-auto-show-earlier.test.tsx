// F15 slice 14: upstream's `thread/list-auto-show-earlier.test.tsx` (a transcript over the DOM budget pages in at the top), unchanged, in the Athena layout (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/thread/list-auto-show-earlier.test'), {
  expects: ['assistant', 'user']
})
