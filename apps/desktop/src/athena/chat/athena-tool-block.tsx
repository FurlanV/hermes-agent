/**
 * F15 slice 10: a tool call in the Athena chat layout. One collapsed row per call: the tool's icon, its plain name, a
 * short summary of its arguments and a state chip (running, done, failed). The row is a button that opens to the
 * call's input and output.
 *
 * Only the generic row is Athena's. The Athena agent message provides `ATHENA_TOOL_LAYOUT` through upstream's
 * `ToolLayoutContext` (`tool/fallback.tsx`, a module constant, so the provider never re-renders what it wraps), and
 * upstream's `ToolFallback` renders this row in place of its own `ToolEntry`. Everything in front of that leaf stays
 * upstream's: the card tools (approval sits outside the parts altogether; clarify, delegate, image generation, theme,
 * setup, connections, package install), todo, delivery notices, reactions and the `display.tool_progress` gate.
 *
 * What the row says comes from upstream's tool model, imported: the name, the summary (the error summary on a failed
 * call), the icon, the image preview and the inline diff (`buildToolView`), the copy payload (`toolCopyPayload`) and
 * the raw payload (`prettyTechnicalValue`). Failure is upstream's rule for a call the user must see
 * (`failedCallNeedsUser`: `toolCallFailed` or a non-zero `exit_code`). The row keeps upstream's row behaviour that is
 * not looks: the open state lives in upstream's persisted disclosure store under the same id (it survives the list
 * virtualising the row away); a settled row can be dismissed and stays dismissed; a settled file edit with no diff is
 * not shown; a diff row starts open and shows its +/− counts; with code diffs hidden a file edit is a summary only
 * (no code, nothing to open) unless it failed; the call's times show when timeline timestamps are on; and a
 * previewable artifact reaches the composer (`useRecordToolPreview`).
 *
 * The chip says its state in text and with its own icon (spinner, check, alert), never in colour alone; its colours
 * are the state tokens (`tokens.ts`, checked in `branding.test.ts`).
 */
import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type FC, type PropsWithChildren, useId, useMemo } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { AnsiText } from '@/components/assistant-ui/ansi-text'
import { MarkdownImage } from '@/components/assistant-ui/markdown-text'
import { failedCallNeedsUser } from '@/components/assistant-ui/thread/message-parts'
import { TimelineTimestamp } from '@/components/assistant-ui/thread/timeline-timestamp'
import { isApprovalActivity, isCurrentTurnMessage } from '@/components/assistant-ui/tool/approval-activity'
import { prettyTechnicalValue, type ToolLayout, useRecordToolPreview } from '@/components/assistant-ui/tool/fallback'
import {
  buildToolView,
  clampForDisplay,
  countDiffLineStats,
  inlineDiffFromResult,
  isFileEditTool,
  selectMessageRunning,
  toolCopyPayload,
  toolEntryDisclosureId,
  type ToolPart,
  type ToolView
} from '@/components/assistant-ui/tool/fallback-model'
import { isToolCallPart, summarizeToolRun } from '@/components/assistant-ui/tool/run-summary'
import { FileDiffPanel } from '@/components/chat/diff-lines'
import { Codicon } from '@/components/ui/codicon'
import { CopyButton } from '@/components/ui/copy-button'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { FileTypeIcon } from '@/components/ui/file-type-icon'
import { ToolIcon } from '@/components/ui/tool-icon'
import { useI18n } from '@/i18n'
import { AlertCircle, CheckCircle2, Loader2 } from '@/lib/icons'
import { toolResultRecord } from '@/lib/tool-result-metadata'
import { cn } from '@/lib/utils'
import { sessionApprovalRequest } from '@/store/prompts'
import { $toolRowDismissed, dismissToolRow } from '@/store/tool-dismiss'
import { $anyToolDisclosureOpen, $hideCodeDiffs, $toolDisclosureOpen, setToolDisclosureOpen } from '@/store/tool-view'

import { athenaStrings } from '../strings'

import type { ChatState } from './tokens'

const copy = athenaStrings.chat.tools

type ToolCallState = Pick<ToolPart, 'completedAt' | 'isError' | 'result' | 'toolName'>

/**
 * A call's state for its chip: running while its message runs and it has neither a result nor a completion mark
 * (upstream's pending rule), failed by upstream's rule for a failure the user must see, otherwise done. A call sealed
 * without a result (a stopped turn) is done here; its name says "Interrupted" or "Result unavailable".
 */
export function athenaToolState(part: ToolCallState, messageRunning: boolean): ChatState {
  if (messageRunning && part.result === undefined && part.completedAt === undefined) {
    return 'running'
  }

  // Upstream's rule reads only `isError`, `result` and `toolName`.
  return failedCallNeedsUser(part as Parameters<typeof failedCallNeedsUser>[0]) ? 'error' : 'done'
}

const STATE_ICON = { done: CheckCircle2, error: AlertCircle, running: Loader2 } as const

/** The state chip: an icon and a word, on the state's fill with its edge (chat.css). */
export const AthenaToolStateChip: FC<{ className?: string; state: ChatState }> = ({ className, state }) => {
  const Icon = STATE_ICON[state]

  return (
    <span className={className} data-athena-tool-state={state} data-slot="athena_tool-chip">
      <Icon aria-hidden="true" className={cn('size-3 shrink-0', state === 'running' && 'motion-safe:animate-spin')} />
      <span>{copy.state[state]}</span>
    </span>
  )
}

const SECTION_LABEL_CLASS = 'm-0 text-[0.6875rem] font-medium uppercase tracking-[0.06em]'
const HEADER_CLASS = 'flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-start'

const PRE_CLASS =
  'm-0 max-h-56 overflow-auto whitespace-pre-wrap wrap-anywhere font-mono text-[0.75rem] leading-relaxed'

/** One generic tool call, in the Athena layout (`ToolLayoutContext.Row`). */
export const AthenaToolRow: FC<{ part: ToolPart }> = ({ part }) => {
  const messageId = useAuiState(s => s.message.id)
  const messageRunning = useAuiState(selectMessageRunning)
  const hideCodeDiffs = useStore($hideCodeDiffs)
  const bodyId = useId()
  const { t } = useI18n()

  const {
    args,
    completedAt,
    innerToolName,
    interrupted,
    isError,
    result,
    timestamp,
    toolCallId,
    toolName,
    toolResultMetadata
  } = part

  // ToolFallback builds a new part on every render; hold one per change of its fields so the view below is not
  // rebuilt (a full read of the result) on every stream delta.
  const stablePart = useMemo<ToolPart>(
    () => ({
      args,
      completedAt,
      innerToolName,
      interrupted,
      isError,
      result,
      timestamp,
      toolCallId,
      toolName,
      toolResultMetadata,
      type: 'tool-call'
    }),
    [
      args,
      completedAt,
      innerToolName,
      interrupted,
      isError,
      result,
      timestamp,
      toolCallId,
      toolName,
      toolResultMetadata
    ]
  )

  const state = athenaToolState(stablePart, messageRunning)
  const pending = state === 'running'
  const disclosureId = toolEntryDisclosureId(messageId, stablePart)
  const dismissed = useStore($toolRowDismissed(disclosureId))
  const persistedOpen = useStore($toolDisclosureOpen(disclosureId))
  const inlineDiff = inlineDiffFromResult(toolResultRecord(stablePart))
  const isFileEdit = isFileEditTool(toolName)

  // A stopped turn is not evidence that an unobserved call succeeded: upstream's presentation-only completion mark.
  const view = useMemo(
    () =>
      buildToolView(
        !pending && result === undefined ? { ...stablePart, completedAt: stablePart.completedAt ?? 0 } : stablePart,
        inlineDiff
      ),
    [inlineDiff, pending, result, stablePart]
  )

  // Upstream's rules: a diff is the deliverable and starts open; with code diffs hidden a file edit is a summary only
  // (its counts, never its code, and nothing to open) unless it failed.
  const summaryOnly = hideCodeDiffs && isFileEdit && view.status !== 'error'
  const open = !summaryOnly && (persistedOpen ?? (Boolean(inlineDiff) && !hideCodeDiffs))

  const diffStats = useMemo(
    () => (isFileEdit && view.inlineDiff ? countDiffLineStats(view.inlineDiff) : null),
    [isFileEdit, view.inlineDiff]
  )

  useRecordToolPreview(messageId, view.status, view.previewTarget)

  // Upstream hides a dismissed row, and a settled file edit with no diff to review (a reloaded create).
  if (dismissed || (isFileEdit && !pending && view.status !== 'error' && !view.inlineDiff)) {
    return null
  }

  const header = (
    <>
      <span aria-hidden="true" className="flex shrink-0 items-center" data-slot="athena_tool-icon">
        {isFileEdit && view.subtitle ? (
          <FileTypeIcon path={view.subtitle} size="0.875rem" />
        ) : (
          <ToolIcon name={view.icon ?? 'tools'} size="0.875rem" />
        )}
      </span>
      <span className="min-w-0 shrink-0 truncate font-medium" data-slot="athena_tool-name">
        {view.title}
      </span>
      {/* On a failed call the summary is the error, which an open row shows in full as its output. */}
      {view.subtitle && !(open && view.status === 'error') && (
        <span className="min-w-0 flex-1 truncate" data-slot="athena_tool-summary" title={view.subtitle}>
          {view.subtitle}
        </span>
      )}
      {!pending && diffStats && (diffStats.added > 0 || diffStats.removed > 0) && (
        <span className="flex shrink-0 gap-1 font-mono tabular-nums" data-slot="athena_tool-diff-stats">
          {diffStats.added > 0 && <span>+{diffStats.added}</span>}
          {diffStats.removed > 0 && <span>−{diffStats.removed}</span>}
        </span>
      )}
      <TimelineTimestamp className="ms-auto shrink-0" completedAt={completedAt} timestamp={timestamp} />
      <AthenaToolStateChip className="ms-auto" state={state} />
    </>
  )

  return (
    <div
      className="min-w-0 max-w-full overflow-hidden"
      data-athena-tool-row=""
      data-file-edit={isFileEdit && open ? '' : undefined}
      data-slot="tool-block"
      data-tool-open={open ? '' : undefined}
      data-tool-row=""
    >
      <div className="flex min-w-0 items-center" data-slot="athena_tool-header">
        {summaryOnly ? (
          <div className={HEADER_CLASS}>{header}</div>
        ) : (
          <button
            aria-controls={bodyId}
            aria-expanded={open}
            className={HEADER_CLASS}
            data-slot="athena_tool-toggle"
            onClick={() => setToolDisclosureOpen(disclosureId, !open)}
            type="button"
          >
            {header}
            <DisclosureCaret aria-hidden="true" className="shrink-0" open={open} size="0.625rem" />
          </button>
        )}
        {/* Upstream's dismiss: a settled row can be cleared (it stays cleared across remounts). */}
        {!pending && (
          <button
            aria-label={t.statusStack.dismiss}
            className="me-1 flex size-5 shrink-0 items-center justify-center rounded-md"
            data-slot="athena_tool-dismiss"
            onClick={() => dismissToolRow(disclosureId)}
            type="button"
          >
            <Codicon name="close" size="0.75rem" />
          </button>
        )}
      </div>
      {!summaryOnly && (
        <div data-slot="athena_tool-body" hidden={!open} id={bodyId}>
          {open && (
            <AthenaToolDetails
              hideCodeDiffs={hideCodeDiffs}
              isFileEdit={isFileEdit}
              part={stablePart}
              state={state}
              view={view}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** What a row opens to: the call's input, then its output. Mounted only while open. */
const AthenaToolDetails: FC<{
  hideCodeDiffs: boolean
  isFileEdit: boolean
  part: ToolPart
  state: ChatState
  view: ToolView
}> = ({ hideCodeDiffs, isFileEdit, part, state, view }) => {
  const { t } = useI18n()

  // A shell command reads as its prompt line (upstream's terminal transcript); anything else as its arguments.
  const input = useMemo(
    () =>
      view.terminalCommand
        ? `$ ${view.terminalCommand}`
        : part.args === undefined
          ? ''
          : clampForDisplay(prettyTechnicalValue(part.args)),
    [part.args, view.terminalCommand]
  )

  const copyAction = useMemo(() => toolCopyPayload(part, view), [part, view])
  const streams = Boolean(view.stdout || view.stderr)

  // The model's reading of the result (an error first on a failed call), else the raw result.
  const output = useMemo(
    () => (streams ? '' : view.detail || (part.result === undefined ? '' : prettyTechnicalValue(part.result))),
    [part.result, streams, view.detail]
  )

  const text = (value: string) =>
    view.rendersAnsi ? <AnsiText text={clampForDisplay(value)} /> : clampForDisplay(value)

  const diff = Boolean(view.inlineDiff) && !hideCodeDiffs
  const empty = !output && !streams && !view.imageUrl && !diff

  return (
    <div className="relative grid min-w-0 gap-2 px-2 py-2" data-slot="athena_tool-details">
      {copyAction.text && (
        <CopyButton
          appearance="inline"
          className="absolute end-2 top-1.5 z-10 h-5 gap-0 rounded-md px-1"
          iconClassName="size-3"
          label={copyAction.label}
          showLabel={false}
          side="left"
          stopPropagation
          text={copyAction.text}
        />
      )}
      {/* A file edit's arguments are its code: none while code diffs are hidden (upstream shows no payload then). */}
      {!(hideCodeDiffs && isFileEdit) && (
        <section className="grid min-w-0 gap-1" data-slot="athena_tool-input">
          <p className={SECTION_LABEL_CLASS}>{copy.input}</p>
          <pre className={PRE_CLASS}>{input || '{}'}</pre>
        </section>
      )}
      <section className="grid min-w-0 gap-1" data-athena-tool-output={state} data-slot="athena_tool-output">
        <p className={SECTION_LABEL_CLASS}>{copy.output}</p>
        {view.imageUrl && (
          <div className="max-w-72 overflow-hidden rounded-[0.25rem]">
            <MarkdownImage alt={t.assistant.tool.outputAlt} src={view.imageUrl} />
          </div>
        )}
        {diff && <FileDiffPanel diff={view.inlineDiff} path={isFileEdit ? view.subtitle : undefined} />}
        {view.stdout && <pre className={PRE_CLASS}>{text(view.stdout)}</pre>}
        {view.stderr && (
          <>
            <p className={SECTION_LABEL_CLASS}>stderr</p>
            <pre className={PRE_CLASS}>{text(view.stderr)}</pre>
          </>
        )}
        {output && <pre className={PRE_CLASS}>{text(output)}</pre>}
        {view.terminalExitCode !== undefined && <p className="m-0 font-mono">exit {view.terminalExitCode}</p>}
        {empty && <p className="m-0">{state === 'running' ? copy.waiting : copy.noOutput}</p>}
      </section>
    </div>
  )
}

/** What a run's summary line needs, read in one selector as a string so a stream delta re-renders nothing. */
interface RunSnapshot {
  approvalActivity: boolean
  completedAt?: number
  count: number
  entryIds: string[]
  key: string
  startedAt?: number
  state: ChatState
  summary: string
}

/** The worst state of a run's calls: running if any runs, failed if any failed, otherwise done. */
const worstState = (states: readonly ChatState[]): ChatState =>
  states.includes('running') ? 'running' : states.includes('error') ? 'error' : 'done'

/**
 * Slice 11: one run of consecutive tool calls (`ToolLayoutContext.Run`), in place of upstream's `ToolRun`. Upstream's
 * `ToolGroupSlot` still splits a range into cards and runs (`splitRunItems`) and keys each run on its start index; a
 * file edit or a card stays in place between two runs. A run of two or more calls is a group: a one-line summary
 * (upstream's `summarizeToolRun`, which also counts failed calls, then the number of calls and the run's state chip)
 * that opens to the rows. A run of one is the row alone, with no group around it.
 *
 * The group starts closed and stays as the user left it: its open state lives in upstream's persisted disclosure store
 * under the run's first call, so new calls joining while the turn streams, a re-render or a remount keep it. A row
 * the user opened inside it opens it too (upstream's rule), so a row being read never disappears into a group when a
 * second call arrives. While a pending approval stands in for a run of commands in the current turn, the run is
 * hidden, as upstream's is.
 */
export const AthenaToolRun: FC<PropsWithChildren<{ endIndex: number; startIndex: number }>> = ({
  children,
  endIndex,
  startIndex
}) => {
  const { locale } = useI18n()
  const bodyId = useId()

  const snapshot = useAuiState(state => {
    const parts = state.message.parts
    const tools = parts.slice(Math.max(0, startIndex), endIndex + 1).filter(isToolCallPart)
    const running = selectMessageRunning(state)
    // Upstream's live run: the turn works and nothing came after it (the summary narrates it in the present tense).
    const live = running && endIndex >= parts.length - 1

    const times = tools as readonly Pick<ToolPart, 'completedAt' | 'timestamp'>[]
    const started = times.flatMap(tool => (tool.timestamp === undefined ? [] : [tool.timestamp]))
    const completed = times.flatMap(tool => (tool.completedAt === undefined ? [] : [tool.completedAt]))

    const value: RunSnapshot & { locale: string } = {
      approvalActivity: tools.length > 0 && tools.every(isApprovalActivity),
      // The run's lifecycle range, as upstream's summary shows it when timeline timestamps are on.
      completedAt: completed.length ? Math.max(...completed) : undefined,
      count: tools.length,
      entryIds: tools.map(tool => toolEntryDisclosureId(state.message.id, tool)),
      key: `${state.message.id}:${tools[0]?.toolCallId ?? ''}`,
      locale,
      startedAt: started.length ? Math.min(...started) : undefined,
      state: worstState(tools.map(tool => athenaToolState(tool, running))),
      summary: summarizeToolRun(tools, live)
    }

    return JSON.stringify(value)
  })

  const run = useMemo(() => JSON.parse(snapshot) as RunSnapshot, [snapshot])
  const disclosureId = `athena-tool-run:${run.key}`
  const persistedOpen = useStore($toolDisclosureOpen(disclosureId))
  const rowOpen = useStore(useMemo(() => $anyToolDisclosureOpen(run.entryIds), [run.entryIds]))
  const sessionId = useStore(useSessionView().$runtimeId)
  const approval = useStore(useMemo(() => sessionApprovalRequest(sessionId), [sessionId]))
  const currentTurn = useAuiState(state => isCurrentTurnMessage(state.thread.messages, state.message.id))
  const grouped = run.count > 1
  const expanded = !grouped || (persistedOpen ?? rowOpen)
  const represented = Boolean(approval) && currentTurn && run.approvalActivity && !rowOpen && !persistedOpen

  return (
    <div
      aria-hidden={represented || undefined}
      className={cn('min-w-0 max-w-full', represented ? 'hidden' : 'grid gap-(--tool-row-gap)')}
      data-athena-tool-group={grouped ? '' : undefined}
      data-slot="tool-block"
      data-tool-group={grouped ? '' : undefined}
      hidden={represented}
      inert={represented}
    >
      {grouped && (
        <div data-slot="athena_tool-group-header" data-tool-summary="">
          <button
            aria-controls={bodyId}
            aria-expanded={expanded}
            className={HEADER_CLASS}
            data-slot="athena_tool-group-toggle"
            onClick={() => setToolDisclosureOpen(disclosureId, !expanded)}
            type="button"
          >
            <span aria-hidden="true" className="flex shrink-0 items-center" data-slot="athena_tool-icon">
              <ToolIcon name="tools" size="0.875rem" />
            </span>
            <span className="min-w-0 truncate font-medium" data-slot="athena_tool-group-summary">
              {run.summary}
            </span>
            <span className="shrink-0" data-slot="athena_tool-group-count">
              {copy.calls(run.count)}
            </span>
            <TimelineTimestamp className="ms-auto shrink-0" completedAt={run.completedAt} timestamp={run.startedAt} />
            <AthenaToolStateChip className="ms-auto" state={run.state} />
            <DisclosureCaret aria-hidden="true" className="shrink-0" open={expanded} size="0.625rem" />
          </button>
        </div>
      )}
      {/* The rows' container is there for one call too, so a row keeps its place when a second call joins. */}
      <div
        className={cn('min-w-0 max-w-full', expanded ? 'grid gap-(--tool-row-gap)' : 'hidden')}
        data-slot="athena_tool-group-body"
        hidden={!expanded}
        id={bodyId}
      >
        {expanded && children}
      </div>
    </div>
  )
}

/** The Athena layout's tool leaves, for upstream's `ToolFallback` and `ToolGroupSlot` (`ToolLayoutContext`). */
export const ATHENA_TOOL_LAYOUT: ToolLayout = Object.freeze({ Row: AthenaToolRow, Run: AthenaToolRun })
