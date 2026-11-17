/**
 * F15 test fixtures: the message builders the Athena chat tests share, and the fixed acceptance transcript (slice
 * 15, plan: Acceptance) that holds one of every element the Athena layout draws.
 *
 * The transcript's settled history is: user text; an agent reply with text, a code fence, a table, a group of two
 * tool calls, a finished call and a failed call; a system note (a background result); a user retry; a failed turn
 * (the error); and the user's next prompt. Its tail is the live turn, given at two moments, because upstream's rule
 * is that a running tool narrates its own wait and the status line steps aside while it does: `'tool'`, the agent
 * running a tool; `'text'`, the agent streaming its reply (the status line and the caret). Both moments carry the
 * whole history, so either one alone shows every settled element.
 *
 * Test-only: nothing in the app imports this module.
 */
import type { ThreadMessage } from '@assistant-ui/react'

import { createdAt, userMessage } from '@/components/assistant-ui/test-utils'

import type { ClientConfigSnapshot } from '../../managed/client-config'
import { $clientConfig } from '../../managed/client-config'

export type Part = ThreadMessage['content'][number]

// ---- builders ----

const metadata = () => ({ unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} })

export const text = (value: string) => ({ type: 'text', text: value }) as Part

/** An agent message; complete unless `status` says otherwise; `custom` is its metadata's (an error surface, …). */
export const agent = (
  id: string,
  content: Part[],
  status: ThreadMessage['status'] = { type: 'complete', reason: 'stop' },
  custom: Record<string, unknown> = {}
) =>
  ({
    id,
    role: 'assistant',
    content,
    status,
    createdAt,
    metadata: { ...metadata(), custom }
  }) as unknown as ThreadMessage

/** A tool call; without `result` it is pending (running while its message runs). */
export const call = (toolCallId: string, toolName: string, args: Record<string, unknown>, result?: unknown) =>
  ({
    type: 'tool-call',
    toolCallId,
    toolName,
    args,
    argsText: JSON.stringify(args),
    ...(result === undefined ? {} : { result })
  }) as Part

/** A background-result system message ("1 background agent finished", with its report). */
export const backgroundNote = (id: string, line = '1 background agent finished', report = 'the report') =>
  ({
    id,
    role: 'system',
    content: [text(line)],
    createdAt,
    metadata: { custom: { asyncResult: report } }
  }) as unknown as ThreadMessage

export { userMessage }

// ---- the build ----

export type Variant = 'athena' | 'stock'

export const clientConfigSnapshot = (
  variant: Variant,
  features: Record<string, string> = {}
): ClientConfigSnapshot => ({
  config: { features },
  configVersion: 1,
  devOverridesActive: false,
  error: null,
  role: 'researcher',
  source: 'server',
  variant,
  verifiedAt: '2026-11-17T00:00:00Z'
})

type Bridge = { athenaDesktop?: unknown }

/**
 * The build the renderer sees: the preload's snapshot (read for the variant) and the live client config (read for
 * the rows). `null` is a stock build with no snapshot at all.
 */
export function selectBuild(variant: null | Variant, features: Record<string, string> = {}) {
  if (variant) {
    ;(window as Bridge).athenaDesktop = { clientConfig: { snapshot: clientConfigSnapshot(variant, features) } }
  } else {
    delete (window as Bridge).athenaDesktop
  }

  $clientConfig.set(variant ? clientConfigSnapshot(variant, features) : null)
}

/** Undo `selectBuild`. */
export function clearBuild() {
  $clientConfig.set(null)
  delete (window as Bridge).athenaDesktop
}

// ---- the acceptance transcript ----

/** A hard fault (upstream's "blocking" card): the model the turn asked for does not exist. */
export const ACCEPTANCE_ERROR = {
  error: 'HTTP 404: model not found',
  errorSurface: { code: 'model_not_found', layer: 'provider', provider: 'openai', retryable: false }
} as const

const REPLY = [
  'The build is green. The entry point:',
  '',
  '```ts',
  "export const main = () => console.log('ready')",
  '```',
  '',
  '| Step | Time |',
  '| --- | --- |',
  '| install | 12s |',
  '| test | 48s |',
  '',
  'Reading the two config files.'
].join('\n')

/** The settled history (the same objects on every call). */
export const ACCEPTANCE_HISTORY: readonly ThreadMessage[] = Object.freeze([
  userMessage('u1', 'Is the build green?'),
  agent('a1', [
    text(REPLY),
    // A group: two consecutive calls.
    call('g1', 'read_file', { path: '/repo/package.json' }, { content: '{}' }),
    call('g2', 'read_file', { path: '/repo/tsconfig.json' }, { content: '{}' }),
    text('Now the tests.'),
    // A finished call on its own.
    call('t1', 'terminal', { command: 'pnpm test' }, { exit_code: 0, output: 'ok' }),
    text('And the lint.'),
    // A failed call on its own.
    call('t2', 'terminal', { command: 'pnpm lint' }, { exit_code: 1, stderr: 'boom' })
  ]),
  backgroundNote('s1'),
  userMessage('u2', 'Try again'),
  agent(
    'a2',
    [],
    { type: 'incomplete', reason: 'error', error: ACCEPTANCE_ERROR.error },
    { errorSurface: ACCEPTANCE_ERROR.errorSurface }
  ),
  userMessage('u3', 'Run the suite and sum it up')
])

export type LiveMoment = 'text' | 'tool'

const LIVE: Readonly<Record<LiveMoment, ThreadMessage>> = Object.freeze({
  tool: agent('a3', [text('Running the suite.'), call('w1', 'terminal', { command: 'pnpm test --all' })], {
    type: 'running'
  }),
  text: agent(
    'a3',
    [
      text('Running the suite.'),
      call('w1', 'terminal', { command: 'pnpm test --all' }, { exit_code: 0, output: 'ok' }),
      text('All **412** tests pass')
    ],
    { type: 'running' }
  )
})

/** The acceptance transcript with its live turn at `moment`. */
export const acceptanceTranscript = (moment: LiveMoment): ThreadMessage[] => [...ACCEPTANCE_HISTORY, LIVE[moment]]
