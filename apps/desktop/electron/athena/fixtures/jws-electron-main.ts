import { readFileSync, writeFileSync } from 'node:fs'

// Runs as a real Electron main process (no window, no Hermes home): verifies the fixture with the main
// process's own Node and BoringSSL, then writes the results and exits.
import { app } from 'electron'

import { type JwsFixture, verifyFixture } from './jws-verify-fixture'

const argument = process.argv.find(arg => arg.startsWith('--jws-fixture='))

if (!argument) {
  throw new Error('Missing --jws-fixture options')
}

const options: { fixture: string; out: string; userData: string } = JSON.parse(argument.slice('--jws-fixture='.length))

app.setPath('userData', options.userData)
app.dock?.hide()

const fixture: JwsFixture = JSON.parse(readFileSync(options.fixture, 'utf8'))

writeFileSync(
  options.out,
  JSON.stringify({
    runtime: {
      type: process.type,
      electron: process.versions.electron,
      node: process.versions.node,
      boringssl: process.versions.openssl === '0.0.0'
    },
    results: verifyFixture(fixture)
  })
)
app.exit(0)
