import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/missions': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
      '/outputs': 'http://localhost:8000',
    },
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
