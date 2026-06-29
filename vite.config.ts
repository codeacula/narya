import { Socket } from 'node:net';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Bun's net.Socket omits this Node method, which Vite's WebSocket proxy uses.
if (typeof Socket.prototype.destroySoon !== 'function') {
  Object.defineProperty(Socket.prototype, 'destroySoon', {
    configurable: true,
    value(this: Socket) {
      if (this.writableFinished) {
        this.destroy();
        return;
      }
      this.end();
      if (!this.writableFinished) this.once('finish', () => this.destroy());
    },
  });
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.VITE_BACKEND_ORIGIN ?? 'http://localhost:4317',
      '/socket': {
        target: process.env.VITE_BACKEND_WS_ORIGIN ?? 'http://localhost:4317',
        ws: true,
        changeOrigin: true,
      }
    }
  }
});
