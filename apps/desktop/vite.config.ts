import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Tauri erwartet einen festen Port und keine automatische Ausweichsuche —
 * sonst findet der Rust-Teil den Entwicklungsserver nicht.
 */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    // Zielsystem ist Windows 10 mit WebView2 (Chromium).
    target: 'es2022',
    outDir: 'dist',
  },
})
