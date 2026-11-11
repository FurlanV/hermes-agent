// Athena bundled client-config data (F02 slice 14). Byte-for-byte the JSON in the athena repo, as TypeScript so
// the composite electron project and the main bundle take it without a JSON loader:
//   TRUSTED_KEYS            ← shared/athena_schemas/src/athena_schemas/data/trusted-keys.json
//   BUNDLED_DEFAULT_CONFIG  ← shared/athena_schemas/src/athena_schemas/data/client-config.default.json
// client-config.test.ts fails when they drift (with an athena checkout present). The demo key is the compose
// signing key (`GET /client-config/jwks.json` on ingest); a new compose `clientconfigkey` volume means a new kid.

export const TRUSTED_KEYS = {
  "keys": [
    {
      "alg": "EdDSA",
      "crv": "Ed25519",
      "kid": "1JEZoss16_o8dYtelFNdqU3I0oa-m9gicOtA3oHE4eY",
      "kty": "OKP",
      "use": "sig",
      "x": "3nvIdaNL4iTVpm4QfgAPaMCu02YrwbMCzcFQfDOgYO0"
    }
  ]
} as const

export const BUNDLED_DEFAULT_CONFIG = {
  "catalog": {
    "min_version": null,
    "remote": false
  },
  "features": {},
  "managed": {
    "features": "enforce",
    "models": "enforce",
    "tools": "enforce"
  },
  "models": {
    "allowed": [
      {
        "hidden": false,
        "id": "gpt-6-luna",
        "label": "GPT-6 Luna",
        "note": "Faster",
        "reasoning": {
          "default": "low",
          "levels": [
            "none",
            "low",
            "medium"
          ]
        }
      }
    ],
    "default": "gpt-6-luna",
    "max_turns_limit": 90
  },
  "schema_version": "1.0",
  "tools": {
    "available": [
      "files",
      "memory",
      "todo",
      "clarify",
      "desktop-projects"
    ],
    "default_on": [
      "files",
      "memory",
      "todo",
      "clarify",
      "desktop-projects"
    ],
    "experimental": [],
    "locked_on": []
  }
}
