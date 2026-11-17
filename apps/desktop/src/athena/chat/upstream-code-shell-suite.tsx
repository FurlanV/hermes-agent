/**
 * F15 slice 07: run an upstream markdown or code test file unchanged with the Athena code block shell in place. Those
 * files render `MarkdownTextContent`, `UserMessageText` or the highlighter directly, outside a thread, so the Athena
 * message wrappers (which provide the shell in the app) are not there; this provides it instead, as a `wrapper`
 * around every `render` the file makes (composed with the file's own wrapper, if any). The upstream file is imported,
 * not copied, so its cases register in the importing test file.
 *
 * At least one Athena shell must mount across the file, so a suite can't pass vacuously on upstream's card.
 */
import type * as TestingLibrary from '@testing-library/react'
import type { FC, ReactNode } from 'react'
import { afterAll, beforeEach, expect, vi } from 'vitest'

import { CodeBlockShellContext, type CodeBlockShellProps } from '@/components/chat/shiki-highlighter'

export async function runUpstreamSuiteWithCodeShell(
  load: () => Promise<unknown>,
  shell: FC<CodeBlockShellProps>
): Promise<void> {
  const Provide = ({ children }: { children: ReactNode }) => (
    <CodeBlockShellContext.Provider value={shell}>{children}</CodeBlockShellContext.Provider>
  )

  vi.doMock('@testing-library/react', async () => {
    const actual = await vi.importActual<typeof TestingLibrary>('@testing-library/react')

    const render: typeof actual.render = ((
      ui: Parameters<typeof actual.render>[0],
      options: TestingLibrary.RenderOptions = {}
    ) => {
      const Inner = options.wrapper

      return actual.render(ui, {
        ...options,
        wrapper: Inner
          ? ({ children }: { children: ReactNode }) => (
              <Provide>
                <Inner>{children}</Inner>
              </Provide>
            )
          : Provide
      })
    }) as typeof actual.render

    return { ...actual, render }
  })

  let mounts = 0
  let observer: MutationObserver | null = null

  const count = (records: MutationRecord[]) => {
    for (const node of records.flatMap(record => [...record.addedNodes])) {
      if (node instanceof Element) {
        mounts +=
          (node.matches('[data-athena-code-block]') ? 1 : 0) + node.querySelectorAll('[data-athena-code-block]').length
      }
    }
  }

  beforeEach(() => {
    observer?.disconnect()
    observer = new MutationObserver(count)
    observer.observe(window.document.body, { childList: true, subtree: true })

    return () => {
      count(observer?.takeRecords() ?? [])
      observer?.disconnect()
      observer = null
    }
  })

  await load()

  afterAll(() => {
    expect(mounts, 'no case mounted the Athena code block shell').toBeGreaterThan(0)
  })
}
