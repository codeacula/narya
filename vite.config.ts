import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.VITE_BACKEND_ORIGIN ?? 'http://localhost:4317',
      '/socket': {
        target: process.env.VITE_BACKEND_WS_ORIGIN ?? 'ws://localhost:4317',
        ws: true
      }
    }
  }
});
