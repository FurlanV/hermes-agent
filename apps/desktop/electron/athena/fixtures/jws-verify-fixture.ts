import type { JsonWebKey } from 'node:crypto'

import { JwsError, trustedKeys, verifyCompactJws } from '../jws'

export interface JwsFixture {
  trusted_keys: JsonWebKey[]
  payload: unknown
  cases: { name: string; token: string; expect: string }[]
}

export interface JwsCaseResult {
  name: string
  reason: string
  payload?: unknown
}

/** One row per fixture case: `ok` with the parsed payload, or the verifier's reason code. */
export function verifyFixture(fixture: JwsFixture): JwsCaseResult[] {
  const trusted = trustedKeys(fixture.trusted_keys)

  return fixture.cases.map(({ name, token }) => {
    try {
      const { payload } = verifyCompactJws(token, trusted)

      return { name, reason: 'ok', payload: JSON.parse(payload.toString('utf8')) }
    } catch (error) {
      if (error instanceof JwsError) {
        return { name, reason: error.reason }
      }

      throw error
    }
  })
}
