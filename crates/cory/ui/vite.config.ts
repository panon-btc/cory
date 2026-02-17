import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    // ELK is intentionally isolated in a lazy chunk and is currently >500 kB.
    // Raise the warning threshold to avoid noisy warnings for this known split.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('elkjs/lib/elk.bundled.js')) return 'elk.bundled'
          if (id.includes('@xyflow/react')) return 'reactflow'
          if (id.includes('node_modules')) return 'vendor'
          return undefined
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3080',
    },
  },
})
