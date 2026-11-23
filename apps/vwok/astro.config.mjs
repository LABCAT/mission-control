import cloudflare from '@astrojs/cloudflare'
import { defineConfig } from 'astro/config'

// vanuatuwok.vu runs on Cloudflare Workers (`mc-vwok`). Pages render on demand so a later task
// can read the tenant and the jobs from the CMS; today the shell is static in effect. Nothing
// here ships client JavaScript: the only island will be a form (launchpad's Turnstile).
export default defineConfig({
  site: 'https://vanuatuwok.vu',
  // Image variants come from R2 (PJ-10), so the Worker never transforms images. This also keeps
  // the "IMAGES" binding, which is billed per transformation, off the Worker.
  adapter: cloudflare({ imageService: 'passthrough' }),
  // The site has no server-side session: accounts live in an httpOnly cookie the astro
  // endpoints set (docs/ACCOUNT-AUTH.md), not in Astro's session store.
  session: false,
  output: 'server',
})
