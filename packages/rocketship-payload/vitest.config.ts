import { getViteConfig } from 'astro/config'

// Astro's Vite plugin is needed to import `.astro` components in the renderer tests. The root
// vitest config references this project, so `pnpm test` at the root runs these too.
export default getViteConfig({
  root: import.meta.dirname,
  test: {
    include: ['src/**/*.test.ts'],
    name: 'rocketship-payload',
  },
})
