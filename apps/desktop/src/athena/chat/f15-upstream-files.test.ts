// @vitest-environment node
/**
 * F15 slice 15: the README's F15 table lists every upstream desktop file the chat redesign touched, in that table
 * (`managed/diff-scope.test.ts` only asks for a row in any plan's table). The F15 branch is cut from
 * `feature/athena-demo` (set ATHENA_F02_BASE to compare elsewhere, as diff-scope does); without git or a merge base
 * the branch check is skipped.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

const desktop = path.resolve(import.meta.dirname, '../../..')
const base = process.env.ATHENA_F02_BASE ?? 'feature/athena-demo'
const ATHENA_DIRS = ['src/athena/', 'electron/athena/']

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: desktop, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** The first-column paths (relative to apps/desktop) of one `### Upstream files touched (Fnn)` table. */
function tableFiles(readme: string, plan: string): string[] {
  const heading = new RegExp(`^### Upstream files touched \\(${plan}\\)$`, 'm')
  const section = readme.split(heading)[1]?.split(/^#{1,3} /m)[0] ?? ''

  return section
    .split('\n')
    .filter(line => line.startsWith('| `'))
    .flatMap(line => [...(line.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)].map(match => match[1]!))
}

describe('the F15 table', () => {
  test('is read on its own, apart from the other plans tables', () => {
    const readme = [
      '### Upstream files touched (F14)',
      '',
      '| `src/f14.ts` | one |',
      '',
      '### Upstream files touched (F15)',
      '',
      '| File | Change |',
      '|---|---|',
      '| `src/a.tsx` | two |',
      '| `src/b.ts`, `electron/c.ts` | three |',
      '',
      '## Next',
      '',
      '| `src/after.ts` | not in the table |'
    ].join('\n')

    expect(tableFiles(readme, 'F15')).toEqual(['src/a.tsx', 'src/b.ts', 'electron/c.ts'])
    expect(tableFiles(readme, 'F14')).toEqual(['src/f14.ts'])
  })
})

const mergeBase = git('merge-base', base, 'HEAD')?.trim() || null

describe.skipIf(!mergeBase)(`the F15 diff against ${base}`, () => {
  /** Upstream desktop files changed since the merge base: committed, staged, unstaged and untracked. */
  const changed = () =>
    [
      ...new Set(
        [
          git('diff', '--name-only', '--relative', mergeBase!) ?? '',
          git('ls-files', '--others', '--exclude-standard') ?? ''
        ]
          .join('\n')
          .split('\n')
          .filter(Boolean)
      )
    ]
      .filter(file => !ATHENA_DIRS.some(dir => file.startsWith(dir)))
      .sort()

  test('every upstream file the plan touched has a row in the F15 table', () => {
    const listed = new Set(tableFiles(readFileSync(path.join(desktop, 'src/athena/README.md'), 'utf8'), 'F15'))

    expect(listed.size).toBeGreaterThan(0)
    expect(changed().filter(file => !listed.has(file))).toEqual([])
  })
})
