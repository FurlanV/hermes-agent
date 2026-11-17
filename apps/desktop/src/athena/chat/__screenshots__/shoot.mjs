// F15 slice 15: screenshots of the acceptance transcript pages that `athena-acceptance-screens.test.tsx` exports.
// Usage (from apps/desktop): node src/athena/chat/__screenshots__/shoot.mjs <build dir> <out dir>
// CHROME_BIN picks the browser when Playwright's own download for its version is missing (any Chromium works).
import { readdirSync } from 'node:fs'
import path from 'node:path'

import { chromium } from '@playwright/test'

const [dir, out] = process.argv.slice(2)

if (!dir || !out) {
  throw new Error('usage: shoot.mjs <build dir> <out dir>')
}

const pages = readdirSync(dir).filter(file => /^(athena|upstream)-.*\.html$/.test(file))
const browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {})
const page = await browser.newPage({ viewport: { width: 900, height: 1250 }, deviceScaleFactor: 1 })

for (const file of pages) {
  await page.emulateMedia({ colorScheme: file.includes('-dark-') ? 'dark' : 'light', reducedMotion: 'reduce' })
  await page.goto(`file://${path.resolve(dir, file)}`)
  await page.evaluate(() => globalThis.document.fonts.ready)
  await page.screenshot({ path: path.join(out, file.replace(/\.html$/, '.png')) })
}

await browser.close()
