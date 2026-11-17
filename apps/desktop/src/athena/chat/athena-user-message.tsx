/**
 * F15 slice 04: the user message in the Athena chat layout. A right-aligned bubble on the user surface token, at
 * most 44rem or 80% wide, labelled "You" above; the time shows on hover in the bubble's action corner, as upstream.
 * Chosen by the layout switch (`athenaMessageType` in `layout.ts`) only while the layout is active.
 *
 * The behaviour is upstream's, imported rather than copied (`thread/user-message.tsx`): the sticky prompt container
 * (and with it the `aui_user-message-root` slot the sticky-prompt clip, the selection rules and the messages-below
 * tracker key on), the bubble base class (`composer-human-message`, the titlebar no-drag carve-out), the clamp, the
 * touch bubble, the Stop / Restore / hover-time cluster, reactions and checkpoints. Click-to-edit is
 * `ActionBarPrimitive.Edit`, so the thread's shared edit composer opens in place as it does upstream.
 *
 * Inter-agent and process notes arrive on the user role but are not the user speaking: they render as upstream's
 * `UserMessage` until slice 06 restyles them.
 */
import './chat.css'

import { ActionBarPrimitive, BranchPickerPrimitive, MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type ComponentProps, type FC, useCallback, useMemo, useState } from 'react'

import { DirectiveContent } from '@/components/assistant-ui/directive-text'
import {
  messageAttachmentRefs,
  messageContentText,
  PROCESS_NOTIFICATION_RE
} from '@/components/assistant-ui/thread/content'
import { ReactionBadge, ReactionPicker } from '@/components/assistant-ui/thread/message-reactions'
import { threadUserOrdinal } from '@/components/assistant-ui/thread/thread-message-index'
import { MessageTimelineTimestamp } from '@/components/assistant-ui/thread/timeline-timestamp'
import { useMessageReactions } from '@/components/assistant-ui/thread/use-message-reactions'
import {
  AGENT_MESSAGE_RE,
  hasTextSelection,
  isChipOnlyTurn,
  StickyHumanMessageContainer,
  TouchUserBubble,
  USER_BUBBLE_BASE_CLASS,
  UserBubbleActions,
  UserMessage,
  useUserBubbleClamp
} from '@/components/assistant-ui/thread/user-message'
import { UserMessageText } from '@/components/assistant-ui/thread/user-message-text'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { $touchPointer, isTouchInteraction } from '@/lib/touch-interaction'
import { cn } from '@/lib/utils'
import { notifyThreadEditOpen } from '@/store/thread-scroll'
import { isWatchWindow } from '@/store/windows'

import { athenaStrings } from '../strings'

export type AthenaUserMessageProps = ComponentProps<typeof UserMessage>

/** A text upstream renders through the user message that is not the user speaking (a delivery or a process note). */
export function isUserRoleNote(text: string): boolean {
  const trimmed = text.trim()

  return PROCESS_NOTIFICATION_RE.test(trimmed) || AGENT_MESSAGE_RE.test(trimmed)
}

/** The thread's `UserMessage` entry while the Athena layout is active; same props as upstream's. */
export const AthenaUserMessage: FC<AthenaUserMessageProps> = props => {
  // The content array, as upstream selects it (a reference compare per store tick); the text is derived on render.
  const content = useAuiState(s => s.message.content)
  const note = useMemo(() => isUserRoleNote(messageContentText(content)), [content])

  return note ? <UserMessage {...props} /> : <AthenaUserBubble {...props} />
}

const BUBBLE_CLASS = cn(
  USER_BUBBLE_BASE_CLASS,
  'cursor-pointer pr-9 text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height) text-foreground/95 transition-colors'
)

const CHECKPOINT_STEP_CLASS =
  'checkpoint-restore-text rounded-sm bg-transparent px-1 opacity-65 hover:opacity-100 disabled:hidden disabled:cursor-default'

function AthenaUserBubble({ onCancel, onRequestRestoreConfirm }: AthenaUserMessageProps) {
  const copy = useI18n().t.assistant.thread
  const touch = useStore($touchPointer)
  const messageId = useAuiState(s => s.message.id)
  const content = useAuiState(s => s.message.content)
  const messageText = messageContentText(content)
  const threadRunning = useAuiState(s => s.thread.isRunning)
  const isLatestUser = useAuiState(s => s.thread.messages.findLast(m => m.role === 'user')?.id === s.message.id)
  const runtimeUserOrdinal = useAuiState(s => threadUserOrdinal(s.thread.messages, s.message.id))

  const attachmentRefs = useAuiState(s =>
    messageAttachmentRefs((s.message.metadata?.custom as { attachmentRefs?: unknown } | undefined)?.attachmentRefs)
  )

  const [pickerOpen, setPickerOpen] = useState(false)
  const { enabled: reactionsEnabled, react, reactions } = useMessageReactions(messageId, 'user')

  const pickEmoji = useCallback(
    (emoji: null | string) => {
      setPickerOpen(false)
      react(emoji)
    },
    [react]
  )

  // Watch windows spectate a run driven elsewhere: no edit, restore or stop, and a click only toggles the clamp.
  const readOnly = isWatchWindow()
  const { bodyClamped, clampActive, clampInnerRef, expanded, setExpanded } = useUserBubbleClamp(readOnly, touch)

  const hasBody = messageText.trim().length > 0
  const chipOnlyTurn = isChipOnlyTurn(hasBody, attachmentRefs)
  const showStop = !readOnly && isLatestUser && threadRunning && Boolean(onCancel)
  const showRestore = !readOnly && !showStop && Boolean(onRequestRestoreConfirm) && hasBody

  const bubbleContent = hasBody ? (
    <div
      className={cn(clampActive && 'sticky-human-clamp')}
      data-clamped={clampActive && bodyClamped ? 'true' : undefined}
    >
      <div className="min-h-[1.25rem]" ref={clampInnerRef}>
        <UserMessageText className="wrap-anywhere" text={messageText} />
      </div>
    </div>
  ) : (
    chipOnlyTurn && (
      <div className="flex min-h-[1.25rem] flex-wrap gap-1">
        <DirectiveContent text={attachmentRefs.join(' ')} />
      </div>
    )
  )

  const bubble = touch ? (
    <TouchUserBubble
      className={BUBBLE_CLASS}
      editable={!readOnly}
      expandable={bodyClamped}
      expanded={expanded}
      onToggleExpanded={() => setExpanded(value => !value)}
      showRestore={showRestore}
      showStop={showStop}
    >
      {bubbleContent}
    </TouchUserBubble>
  ) : readOnly ? (
    <button
      aria-expanded={bodyClamped ? expanded : undefined}
      className={cn(BUBBLE_CLASS, !bodyClamped && 'cursor-default')}
      onClick={() => {
        if (hasTextSelection() || !bodyClamped) {
          return
        }

        triggerHaptic('selection')
        setExpanded(value => !value)
      }}
      type="button"
    >
      {bubbleContent}
    </button>
  ) : (
    // Click opens the shared edit composer, even mid-stream; a live text highlight wins over the click.
    <ActionBarPrimitive.Edit asChild>
      <button
        aria-label={copy.editMessage}
        className={BUBBLE_CLASS}
        onClick={event => {
          if (hasTextSelection()) {
            event.preventDefault()
            event.stopPropagation()

            return
          }

          triggerHaptic('selection')
        }}
        onPointerDown={() => {
          if (!hasTextSelection()) {
            notifyThreadEditOpen()
          }
        }}
        type="button"
      >
        {bubbleContent}
      </button>
    </ActionBarPrimitive.Edit>
  )

  return (
    <MessagePrimitive.Root asChild>
      <StickyHumanMessageContainer
        attachments={
          // Below the sticky box in normal flow, so they scroll away behind the pinned bubble (as upstream).
          attachmentRefs.length > 0 && !chipOnlyTurn ? (
            <div className="mb-2 flex flex-wrap justify-end gap-1" data-slot="athena_user-attachments">
              <DirectiveContent text={attachmentRefs.join(' ')} />
            </div>
          ) : null
        }
        messageId={messageId}
      >
        <ActionBarPrimitive.Root className="relative w-full max-w-full" data-slot="aui_user-bubble-actions">
          <div className="human-message-with-todos-wrapper flex w-full flex-col gap-0" data-slot="athena_user-message">
            <span className="select-none px-1 pb-1 text-[0.75rem] leading-4 font-medium" data-slot="athena_user-label">
              {athenaStrings.chat.userLabel}
            </span>
            <ReactionPicker
              onOpenChange={setPickerOpen}
              onSelect={pickEmoji}
              open={pickerOpen}
              selected={reactions.find(reaction => reaction.author === 'user')?.emoji}
            >
              <div
                className="relative"
                // Right-click is the desktop reaction gesture; the app menu skips plain right-clicks here.
                data-context-menu-skip=""
                data-slot="athena_user-bubble"
                onContextMenu={
                  readOnly || !reactionsEnabled
                    ? undefined
                    : event => {
                        if (hasTextSelection() || isTouchInteraction(event.nativeEvent)) {
                          return
                        }

                        event.preventDefault()
                        setPickerOpen(true)
                      }
                }
              >
                {bubble}
                <UserBubbleActions
                  fullText={messageText}
                  messageId={messageId}
                  onCancel={onCancel}
                  onRequestRestoreConfirm={onRequestRestoreConfirm}
                  runtimeUserOrdinal={runtimeUserOrdinal}
                  showRestore={showRestore}
                  showStop={showStop}
                  touch={touch}
                />
              </div>
            </ReactionPicker>
            <ReactionBadge
              className="justify-end gap-1.5 py-1.5 pe-1.5"
              onRetract={() => react(null)}
              reactions={reactions}
            />
            <MessageTimelineTimestamp className="self-end pe-1.5" />
            <BranchPickerPrimitive.Root
              className={cn(
                'checkpoint-container flex items-center justify-end gap-1 pb-0 pt-1 pe-1.5 text-[0.75rem] leading-none text-(--ui-text-tertiary)',
                readOnly && 'hidden'
              )}
              hideWhenSingleBranch
            >
              <span aria-hidden className="checkpoint-icon size-1.5 rounded-full border border-current" />
              <BranchPickerPrimitive.Previous className={CHECKPOINT_STEP_CLASS} title={copy.restorePrevious}>
                {copy.restoreCheckpoint}
              </BranchPickerPrimitive.Previous>
              <span className="checkpoint-divider opacity-55">
                <BranchPickerPrimitive.Number />/<BranchPickerPrimitive.Count />
              </span>
              <BranchPickerPrimitive.Next className={CHECKPOINT_STEP_CLASS} title={copy.restoreNext}>
                {copy.goForward}
              </BranchPickerPrimitive.Next>
            </BranchPickerPrimitive.Root>
          </div>
        </ActionBarPrimitive.Root>
      </StickyHumanMessageContainer>
    </MessagePrimitive.Root>
  )
}
