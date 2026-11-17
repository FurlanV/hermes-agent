// F15 slice 07: upstream's `components/chat/shiki-highlighter.test.tsx` (a failed highlighter chunk degrades one fence,
// not the reply), unchanged, with the Athena code block shell provided (upstream-code-shell-suite.tsx).
import { AthenaCodeBlock } from './athena-code-block'
import { runUpstreamSuiteWithCodeShell } from './upstream-code-shell-suite'

// The extension picks the component file: without it the pure-function sibling `shiki-highlighter.test.ts` resolves.
await runUpstreamSuiteWithCodeShell(
  // @ts-expect-error TS5097: the renderer tsconfig does not allow a .tsx import path; vitest resolves it.
  () => import('@/components/chat/shiki-highlighter.test.tsx'),
  AthenaCodeBlock
)
