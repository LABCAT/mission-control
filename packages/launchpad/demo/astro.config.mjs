import { defineConfig } from 'astro/config'

// The demo is a build-only sample of the theme: no adapter, and no client JavaScript beyond
// the Turnstile island, exactly like the site apps that depend on this package.
export default defineConfig({
  outDir: './dist',
})
