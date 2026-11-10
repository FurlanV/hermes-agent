/**
 * Athena: verify an Ed25519 compact JWS (RFC 7515, `alg: EdDSA` per RFC 8037) with Node's built-in crypto.
 *
 * Spike for F02 slice 07 (check M5). The signed client config (slice 11) is verified here in Electron main
 * against a trusted-key list bundled in the app, keyed by `kid`. The reason codes match the Python reference
 * verifier in the athena repo (`tests/spikes/jws_ed25519.py`), and both pass the same fixture
 * (`fixtures/jws-ed25519.json`, signed there with a throwaway key).
 */
import { createPublicKey, type JsonWebKey, type KeyObject, verify } from 'node:crypto'

export const JWS_ALG = 'EdDSA'

export type JwsReason =
  'malformed' | 'unsupported_alg' | 'missing_kid' | 'unknown_kid' | 'crit_unsupported' | 'bad_signature'

export class JwsError extends Error {
  constructor(
    readonly reason: JwsReason,
    detail = ''
  ) {
    super(detail ? `${reason}: ${detail}` : reason)
  }
}

export interface VerifiedJws {
  header: Record<string, unknown>
  payload: Buffer
}

const BASE64URL = /^[A-Za-z0-9_-]+$/

/**
 * Strict base64url: unpadded, URL alphabet, canonical. `Buffer.from(s, 'base64url')` ignores invalid characters
 * and the unused bits of the last one, so a signature with its last character changed would still verify.
 */
export function b64urlDecode(text: string): Buffer {
  if (!BASE64URL.test(text)) {
    throw new JwsError('malformed', 'not unpadded base64url')
  }

  const data = Buffer.from(text, 'base64url')

  if (data.toString('base64url') !== text) {
    throw new JwsError('malformed', 'non-canonical base64url')
  }

  return data
}

/** A bundled trusted key: an Ed25519 OKP JWK. Throws on anything else, so a bad bundle fails at load. */
export function keyFromJwk(jwk: JsonWebKey): KeyObject {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('not an Ed25519 OKP JWK')
  }

  b64urlDecode(jwk.x)

  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' })
}

export function trustedKeys(jwks: readonly JsonWebKey[]): ReadonlyMap<string, KeyObject> {
  return new Map(
    jwks.map(jwk => {
      if (typeof jwk.kid !== 'string' || !jwk.kid) {
        throw new Error('trusted key without kid')
      }

      return [jwk.kid, keyFromJwk(jwk)] as const
    })
  )
}

/** Same check order as the Python reference: shape, header JSON, alg, crit, kid, signature. */
export function verifyCompactJws(token: string, trusted: ReadonlyMap<string, KeyObject>): VerifiedJws {
  const parts = token.split('.')

  if (parts.length !== 3) {
    throw new JwsError('malformed', 'expected 3 segments')
  }

  const [h64, p64, s64] = parts
  let header: unknown

  try {
    header = JSON.parse(b64urlDecode(h64).toString('utf8'))
  } catch (error) {
    if (error instanceof JwsError) {
      throw error
    }

    throw new JwsError('malformed', 'header is not JSON')
  }

  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new JwsError('malformed', 'header is not an object')
  }

  const fields = header as Record<string, unknown>

  if (fields.alg !== JWS_ALG) {
    throw new JwsError('unsupported_alg', String(fields.alg))
  }

  if ('crit' in fields) {
    throw new JwsError('crit_unsupported')
  }

  if (typeof fields.kid !== 'string' || !fields.kid) {
    throw new JwsError('missing_kid')
  }

  const key = trusted.get(fields.kid)

  if (!key) {
    throw new JwsError('unknown_kid', fields.kid)
  }

  const payload = b64urlDecode(p64)
  const signature = b64urlDecode(s64)

  // Ed25519 takes no digest: the algorithm argument is null.
  if (!verify(null, Buffer.from(`${h64}.${p64}`, 'ascii'), key, signature)) {
    throw new JwsError('bad_signature')
  }

  return { header: fields, payload }
}
