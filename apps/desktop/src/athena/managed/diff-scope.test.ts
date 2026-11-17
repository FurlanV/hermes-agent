// @vitest-environment node
// Diff scope (F02, F14, F15): inside apps/desktop an Athena branch touches only the
// upstream files listed in src/athena/README.md › "Upstream files touched (Fnn)" tables,
// plus the Athena folders. Outside apps/desktop, hermes itself may change under
// ADR 0009 (athena docs/adr: hermes changes are allowed without regressions, e.g.
// F03 slice 06's auth_command): what this test enforces there is that no existing
// hermes test is edited, renamed or removed (new tests are fine). The base is the
// D05 branding branch (`feature/athena-demo`); set ATHENA_F02_BASE to compare elsewhere.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

const desktop = path.resolve(import.meta.dirname, '../../..')
const base = process.env.ATHENA_F02_BASE ?? 'feature/athena-demo'
const ATHENA_DIRS = ['apps/desktop/src/athena/', 'apps/desktop/electron/athena/']

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: desktop, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

const mergeBase = git('merge-base', base, 'HEAD')?.trim() || null
const repoRoot = git('rev-parse', '--show-toplevel')?.trim() ?? desktop
const DESKTOP = 'apps/desktop/'

/** The heading of each plan's table of upstream files (F02, F14, …). */
const UPSTREAM_TABLE_HEADING = /^### Upstream files touched \(F\d\d\)$/m

/** Paths (from the repo root) in every "Upstream files touched (Fnn)" table of the README, first column. */
function listedUpstreamFiles(readme: string): string[] {
  const sections = readme
    .split(UPSTREAM_TABLE_HEADING)
    .slice(1)
    .map(rest => rest.split(/^#{1,3} /m)[0] ?? '')

  return sections.flatMap(section =>
    section
      .split('\n')
      .filter(line => line.startsWith('| `'))
      .flatMap(line => [...(line.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)].map(match => `apps/desktop/${match[1]}`))
  )
}

describe('upstream-files tables', () => {
  const readme = [
    '### Upstream files touched (F02)',
    '',
    '| File | Change |',
    '|---|---|',
    '| `src/a.ts` | one |',
    '',
    '## Something else',
    '',
    '| `src/not-listed.ts` | a table outside an upstream-files section |',
    '',
    '### Upstream files touched (F14)',
    '',
    '| File | Change |',
    '|---|---|',
    '| `src/b.tsx`, `electron/c.ts` | two |',
    ''
  ].join('\n')

  test('every plan table counts, and nothing outside them', () => {
    expect(listedUpstreamFiles(readme).sort()).toEqual([
      'apps/desktop/electron/c.ts',
      'apps/desktop/src/a.ts',
      'apps/desktop/src/b.tsx'
    ])
  })

  test('the real README has both the F02 and the F14 table', () => {
    const real = readFileSync(path.join(desktop, 'src/athena/README.md'), 'utf8')

    expect(real).toMatch(/^### Upstream files touched \(F02\)$/m)
    expect(real).toMatch(/^### Upstream files touched \(F14\)$/m)
  })

  test('the real README has the F15 table', () => {
    const real = readFileSync(path.join(desktop, 'src/athena/README.md'), 'utf8')

    expect(real).toMatch(/^### Upstream files touched \(F15\)$/m)
  })
})

/** Committed, staged, unstaged and untracked paths that differ from the merge base. */
function changedPaths(since: string): string[] {
  const lines = [
    git('diff', '--name-only', since) ?? '',
    git('-C', repoRoot, 'ls-files', '--others', '--exclude-standard') ?? ''
  ].join('\n')

  return [...new Set(lines.split('\n').filter(Boolean))].sort()
}

describe.skipIf(!mergeBase)(`F02 diff scope against ${base}`, () => {
  const listed = new Set(listedUpstreamFiles(readFileSync(path.join(desktop, 'src/athena/README.md'), 'utf8')))

  test('the upstream-files list exists', () => {
    expect(listed.size).toBeGreaterThan(0)
  })

  test('touches only listed upstream desktop files and the Athena folders', () => {
    const outside = changedPaths(mergeBase!).filter(
      file => file.startsWith(DESKTOP) && !listed.has(file) && !ATHENA_DIRS.some(dir => file.startsWith(dir))
    )

    expect(outside).toEqual([])
  })

  test('hermes changes edit, rename or remove no existing hermes test (ADR 0009)', () => {
    const edited = (
      git(
        '-C',
        repoRoot,
        'diff',
        '--name-status',
        '--diff-filter=MDR',
        mergeBase!,
        '--',
        'tests/',
        ':(glob)**/test_*.py'
      ) ?? ''
    )
      .split('\n')
      .filter(Boolean)
      .filter(
        line =>
          !line
            .split('\t')
            .slice(1)
            .every(file => file.startsWith(DESKTOP))
      )

    expect(edited).toEqual([])
  })
})
