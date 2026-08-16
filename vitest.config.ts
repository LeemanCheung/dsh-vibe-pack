import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/dsh-vibe-pack/{test,tests}/**/*.{test,spec}.ts'],
    exclude: ['**/lib/**', '**/node_modules/**'],
    testTimeout: 30_000,
  },
})
