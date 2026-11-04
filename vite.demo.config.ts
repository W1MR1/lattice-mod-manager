import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The animated product demo (demo/), built apart from the app.
export default defineConfig({
  root: 'demo',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../demo-dist',
    emptyOutDir: true,
  },
  server: {
    port: 5318,
    strictPort: true,
  },
});
