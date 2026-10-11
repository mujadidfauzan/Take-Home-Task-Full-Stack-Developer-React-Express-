import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxy = { '/api': { target: process.env.API_TARGET ?? 'http://127.0.0.1:4000', changeOrigin: true } };
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { proxy }
});
