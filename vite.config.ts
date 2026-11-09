import path from 'node:path';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

const serverPort = process.env.ALIGN_PORT || '4600';

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'web'),
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // The server only trusts this origin in development.
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
      '/ws': {target: `ws://127.0.0.1:${serverPort}`, ws: true},
    },
  },
});
