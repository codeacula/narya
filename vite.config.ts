import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4317',
      '/socket': {
        target: 'ws://localhost:4317',
        ws: true
      }
    }
  }
});
