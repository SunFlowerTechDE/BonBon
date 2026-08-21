import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Kein Test darf Netzwerk brauchen (CLAUDE.md, Testregeln).
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts', 'tools/**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/target/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
})
