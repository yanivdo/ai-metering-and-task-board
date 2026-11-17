/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverPort = Number(process.env.PORT ?? 4000);

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  // `npm run dev`: Vite serves the app with hot reload and forwards /api (incl. the SSE stream) to Fastify.
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://127.0.0.1:${serverPort}`, changeOrigin: true } },
  },
  test: {
    // Server and state tests run in Node; app.test.tsx opts into jsdom with a file comment.
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
