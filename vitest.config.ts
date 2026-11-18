import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // Astro components need Astro's Vite plugin, which only the launchpad project loads.
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            '.github/scripts/*.test.ts',
            'tools/*/src/**/*.test.ts', // mission-control: include tools/
          ],
          exclude: ['packages/launchpad/**'],
        },
      },
      './packages/launchpad',
    ],
  },
})
