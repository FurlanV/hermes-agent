// @vitest-environment node
// Every picker reads the shared selector: no UI file merges custom ids or
// offers a typed id on its own, so narrowing the selector narrows them all.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { expect, test } from 'vitest'

const src = path.resolve(import.meta.dirname, '../..')
const OWNERS = new Set(['store/custom-models.ts', 'athena/managed/models.ts'])

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)

    if (statSync(file).isDirectory()) {
      yield* sources(file)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield file
    }
  }
}

test('only the selector calls withCustomModels / customModelCandidate', () => {
  const callers = [...sources(src)]
    .map(file => path.relative(src, file))
    .filter(file => !OWNERS.has(file))
    .filter(file => /\b(withCustomModels|customModelCandidate)\(/.test(readFileSync(path.join(src, file), 'utf8')))

  expect(callers).toEqual([])
})
