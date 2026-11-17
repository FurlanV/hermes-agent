// F15: upstream's `tool/tool-feed-chrome.test.tsx`, unchanged, against the Athena tool row (upstream-suite.ts).
import { runUpstreamSuiteInAthenaLayout } from './upstream-suite'

await runUpstreamSuiteInAthenaLayout(() => import('@/components/assistant-ui/tool/tool-feed-chrome.test'), {
  expects: ['assistant']
})
