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

// The dev server proxies /api and /socket to the backend, so exposing it to the
// LAN exposes the backend too — a loopback-bound backend is no protection. Mirror
// the backend's rule (src/server/index.ts): loopback unless HOST says otherwise,
// and never off-box without a token.
const host = process.env.HOST?.trim() || 'localhost';
const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
if (!isLoopback && !process.env.DASHBOARD_TOKEN?.trim()) {
  throw new Error(
    `Refusing to start: HOST=${host} exposes the dev server (and the API it proxies) beyond loopback ` +
    'but DASHBOARD_TOKEN is not set. Set DASHBOARD_TOKEN in .env, or drop HOST to bind loopback only.',
  );
}

export default defineConfig({
  plugins: [react()],
  preview: { host },
  server: {
    port: 5173,
    host,
    proxy: {
      '/api': process.env.VITE_BACKEND_ORIGIN ?? 'http://localhost:4317',
      '/socket': {
        target: process.env.VITE_BACKEND_WS_ORIGIN ?? 'http://localhost:4317',
        ws: true,
        changeOrigin: true,
        configure(proxy) {
          // Backend may not be ready when Vite starts; swallow ECONNREFUSED so
          // the log isn't noisy. The client reconnect loop handles retries.
          proxy.on('error', () => {});
        },
      }
    }
  }
});
