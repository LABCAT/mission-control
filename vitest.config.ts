import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          // Astro components need Astro's Vite plugin, which only the launchpad project loads.
          exclude: ['packages/launchpad/**'],
        },
      },
      './packages/launchpad',
    ],
  },
})
