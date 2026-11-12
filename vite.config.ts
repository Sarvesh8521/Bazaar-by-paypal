import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: UI on :5173, API proxied to the Express server on :3000. Build output (dist/) is served by Express.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist' },
});
