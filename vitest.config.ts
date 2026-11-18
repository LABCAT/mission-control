import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
<<<<<<< HEAD
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts'], // mission-control: include tools/
=======
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', '.github/scripts/*.test.ts'],
>>>>>>> origin/main
  },
})
