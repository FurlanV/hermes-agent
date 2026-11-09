// @vitest-environment node
// F02 diff scope: the managed-client branch touches only the upstream files
// listed in src/athena/README.md › "Upstream files touched (F02)", plus the
// Athena folders, and never the hermes Python. The base is the D05 branding
// branch (`feature/athena-demo`); set ATHENA_F02_BASE to compare elsewhere.
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

/** Paths (from the repo root) in the README's F02 table, first column. */
function listedUpstreamFiles(readme: string): string[] {
  const section = readme.split(/^### Upstream files touched \(F02\)$/m)[1]?.split(/^#{1,3} /m)[0] ?? ''

  return section
    .split('\n')
    .filter(line => line.startsWith('| `'))
    .flatMap(line => [...(line.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)].map(match => `apps/desktop/${match[1]}`))
}

/** Committed, staged, unstaged and untracked paths that differ from the merge base. */
function changedPaths(since: string): string[] {
  const lines = [
    git('diff', '--name-only', since) ?? '',
    git('-C', git('rev-parse', '--show-toplevel')?.trim() ?? desktop, 'ls-files', '--others', '--exclude-standard') ??
      ''
  ].join('\n')

  return [...new Set(lines.split('\n').filter(Boolean))].sort()
}

describe.skipIf(!mergeBase)(`F02 diff scope against ${base}`, () => {
  const listed = new Set(listedUpstreamFiles(readFileSync(path.join(desktop, 'src/athena/README.md'), 'utf8')))

  test('the upstream-files list exists', () => {
    expect(listed.size).toBeGreaterThan(0)
  })

  test('touches only listed upstream files and the Athena folders', () => {
    const outside = changedPaths(mergeBase!).filter(
      file => !listed.has(file) && !ATHENA_DIRS.some(dir => file.startsWith(dir))
    )

    expect(outside).toEqual([])
  })

  test('changes no hermes Python', () => {
    expect((git('diff', '--name-only', mergeBase!, '--', '*.py') ?? '').trim()).toBe('')
  })
})
