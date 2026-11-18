// Browser smoke for the launchpad theme: serve the built demo and load it in Chromium.
// The build proves the HTML exists; this proves the page renders, the tenant tokens reach
// the components through CSS custom properties, and the one island does not break the page.
//
//   node launchpad-smoke.mjs [dist-dir]     (default: packages/launchpad/demo/dist)
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { chromium } from 'playwright'

const dist = resolve(process.argv[2] ?? 'packages/launchpad/demo/dist')
const timeout = Number(process.env.SMOKE_TIMEOUT_MS || 45000)

// The tenant from demo/src/data.ts. The accent is the value BaseLayout must publish as a
// custom property, and the one the accent tag pill must paint with at runtime.
const ACCENT = '#06914b'
const ACCENT_RGB = 'rgb(6, 145, 75)'

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const serve = (root) =>
  createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const file = normalize(join(root, path === '/' ? 'index.html' : path))
    if (!file.startsWith(root)) {
      response.writeHead(403).end()
      return
    }
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      response.end(body)
    } catch {
      response.writeHead(404).end()
    }
  })

const close = (server) => new Promise((done) => server.close(done))

const server = serve(dist)
await new Promise((done, fail) => {
  server.once('error', fail)
  server.listen(0, '127.0.0.1', done)
})
const base = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch()
const page = await browser.newPage()
const pageErrors = []
const failedRequests = []
page.on('pageerror', (error) => pageErrors.push(error.message))
page.on('requestfailed', (request) => failedRequests.push(request.url()))

// The Turnstile API is a third-party script the smoke does not need: a stub keeps the run
// offline and deterministic, while the island's own code (the part this package owns) runs.
// The stub mirrors Cloudflare where it matters: it adds its own response field to the form
// unless `response-field` is false, and hands a token to the callback.
const TURNSTILE_STUB = `
window.turnstile = {
  render: function (container, options) {
    window.__turnstileCalls = (window.__turnstileCalls || 0) + 1
    if (options['response-field'] !== false) {
      var field = document.createElement('input')
      field.type = 'hidden'
      field.name = options['response-field-name'] || 'cf-turnstile-response'
      container.appendChild(field)
    }
    if (options.callback) options.callback('stub-token')
    return 'stub'
  }
}
`

await page.route('https://challenges.cloudflare.com/**', (route) =>
  route.fulfill({ body: TURNSTILE_STUB, contentType: 'text/javascript' }),
)

let failure
try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout })

  const heading = page.locator('h1')
  await heading.waitFor({ state: 'visible', timeout })
  await page.locator('article.rs-card').first().waitFor({ state: 'visible', timeout })

  const check = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  check((await heading.textContent())?.trim() === 'Jobs in Vanuatu', 'wrong page heading')

  const jobs = await page.locator('.lp-job__org').count()
  const orgs = await page.locator('.lp-org__facts').count()
  check(jobs > 0, 'no job card rendered')
  check(orgs > 0, 'no organisation card rendered')

  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  check(body.includes('Head Chef'), 'the first job card did not render')
  check(body.includes('VUV 150,000'), 'the salary did not format in the tenant currency')

  const accentToken = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--rs-color-accent').trim(),
  )
  check(accentToken === ACCENT, `--rs-color-accent is "${accentToken}", expected ${ACCENT}`)

  const pill = page.locator('.lp-job__tag--accent').first()
  await pill.waitFor({ state: 'visible', timeout })
  const pillBackground = await pill.evaluate((element) => getComputedStyle(element).backgroundColor)
  check(
    pillBackground === ACCENT_RGB,
    `accent tag painted ${pillBackground}, expected the tenant accent ${ACCENT_RGB}`,
  )

  // Exactly one response field: the component's own. If the widget were allowed to add its own,
  // the form would post the same name twice and the server would see an empty or ambiguous token.
  const responseFields = page.locator('input[name="cf-turnstile-response"]')
  check(
    (await responseFields.count()) === 1,
    `expected one cf-turnstile-response field, found ${await responseFields.count()}`,
  )

  // The island ran: the stub was called for the widget and the token reached the field.
  const widgetToken = await responseFields.first().inputValue()
  check(widgetToken === 'stub-token', `the response field holds "${widgetToken}", not the widget token`)

  // The no-JavaScript fallback is a noscript element, so it is not shown when JS works.
  const noscriptVisible = await page.locator('.lp-turnstile__noscript').isVisible().catch(() => false)
  check(!noscriptVisible, 'the "needs JavaScript" message is visible even though JavaScript works')

  // The island runs, so its first-party module and the stylesheet it depends on were served.
  check(failedRequests.length === 0, `requests failed: ${failedRequests.join(', ')}`)

  console.log(`Launchpad demo rendered at ${base} (${jobs} job cards, ${orgs} organisation cards)`)
} catch (error) {
  failure = `${error.message.split('\n')[0]} (at ${page.url()})`
  console.error(`::error::the launchpad demo did not render within ${timeout / 1000}s: ${failure}`)
  await page
    .screenshot({ fullPage: true, path: process.env.SMOKE_SCREENSHOT || 'launchpad-smoke.png' })
    .catch(() => {})
} finally {
  for (const message of pageErrors.slice(0, 10)) {
    console.log(`browser error: ${message.slice(0, 300)}`)
  }
  if (!failure && pageErrors.length > 0) failure = `${pageErrors.length} uncaught page error(s)`
  await browser.close()
  await close(server)
}

// A thrown island is a real regression even if the rendered text looked right.
process.exit(failure ? 1 : 0)
