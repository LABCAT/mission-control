// Browser smoke for the Payload admin: load <URL>/admin in Chromium and wait for
// the login (or create-first-user) form to render. A 307 to /admin/login is not
// enough; the admin can redirect fine and still hang while hydrating.
//
//   node admin-smoke.mjs https://<preview>.workers.dev
import { chromium } from 'playwright';

const base = process.argv[2]?.replace(/\/$/, '');
if (!base) {
  console.error('usage: node admin-smoke.mjs <base-url>');
  process.exit(2);
}
const timeout = Number(process.env.SMOKE_TIMEOUT_MS || 45000);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

let ok = false;
try {
  await page.goto(`${base}/admin`, { waitUntil: 'domcontentloaded', timeout });
  // Login and create-first-user both render an email and a password field.
  await page.locator('input[name="email"]').waitFor({ state: 'visible', timeout });
  await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout });
  ok = true;
  console.log(`Admin rendered at ${page.url()}`);
} catch (error) {
  console.error(`::error::${base}/admin did not render a login form within ${timeout / 1000}s (at ${page.url()}): ${error.message.split('\n')[0]}`);
  await page.screenshot({ path: process.env.SMOKE_SCREENSHOT || 'admin-smoke.png', fullPage: true }).catch(() => {});
} finally {
  for (const message of errors.slice(0, 10)) console.log(`browser error: ${message.slice(0, 300)}`);
  await browser.close();
}
process.exit(ok ? 0 : 1);
