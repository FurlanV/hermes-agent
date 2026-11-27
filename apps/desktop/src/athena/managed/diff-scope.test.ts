// @vitest-environment node
// Diff scope (F02, F14): inside apps/desktop an Athena branch touches only the
// upstream files listed in src/athena/README.md › "Upstream files touched (Fnn)" tables,
// plus the Athena folders. Outside apps/desktop, hermes itself may change under
// ADR 0009 (athena docs/adr: hermes changes are allowed without regressions, e.g.
// F03 slice 06's auth_command): what this test enforces there is that no existing
// hermes test is edited, renamed or removed (new tests are fine). The base is the
// D05 branding branch (`feature/athena-demo`); set ATHENA_F02_BASE to compare elsewhere.
// After an upstream merge (P10: v0.23.4) the comparison is against that base merged with
// the same upstream release, so only what Athena changed since the base counts, not what
// upstream changed. The release is the newest stable tag in HEAD's history
// (ATHENA_UPSTREAM_RELEASE overrides it); it is ignored while the base already has it.
import { execFileSync, spawnSync } from 'node:child_process'
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

const release =
  process.env.ATHENA_UPSTREAM_RELEASE ??
  (git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--exclude', '*+*', '--exclude', '*-*', 'HEAD')?.trim() ||
    null)

/** The base merged with the upstream release, as a tree: what HEAD would be had Athena changed nothing since
 *  the base. A file both sides changed keeps git's conflict markers there, so it still differs from HEAD (and
 *  any such file is one Athena touched before the base, hence listed). The base itself while it holds the
 *  release already, or when there is none. */
function upgradedBase(): null | string {
  if (!mergeBase || !release || git('merge-base', '--is-ancestor', release, mergeBase) !== null) {
    return mergeBase
  }

  // Exit 1 means conflicts, and the tree is still written: its id is the first line either way.
  const merged = spawnSync('git', ['merge-tree', '--write-tree', mergeBase, release], { cwd: desktop, encoding: 'utf8' })
  const tree = merged.status === 0 || merged.status === 1 ? merged.stdout.split('\n')[0]?.trim() : ''

  if (!tree) {
    throw new Error(`could not merge ${base} with ${release}: ${merged.stderr}`)
  }

  return tree
}

const baseline = upgradedBase()
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
})

/** Committed, staged, unstaged and untracked paths that differ from the merge base. */
function changedPaths(since: string): string[] {
  const lines = [
    git('diff', '--name-only', since) ?? '',
    git('-C', repoRoot, 'ls-files', '--others', '--exclude-standard') ?? ''
  ].join('\n')

  return [...new Set(lines.split('\n').filter(Boolean))].sort()
}

describe.skipIf(!baseline)(`F02 diff scope against ${base}${baseline === mergeBase ? '' : ` + ${release}`}`, () => {
  const listed = new Set(listedUpstreamFiles(readFileSync(path.join(desktop, 'src/athena/README.md'), 'utf8')))

  test('the upstream-files list exists', () => {
    expect(listed.size).toBeGreaterThan(0)
  })

  test('touches only listed upstream desktop files and the Athena folders', () => {
    const outside = changedPaths(baseline!).filter(
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
        baseline!,
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
