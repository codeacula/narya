import { Socket } from 'node:net';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { isLoopbackHost } from './src/server/config';

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

export default defineConfig(({ mode }) => {
  // Read .env here rather than trusting process.env. This file runs in the *Vite*
  // process, which is node — and `bun run dev:client` does not hand the .env Bun
  // loaded to a node child, so process.env.HOST and DASHBOARD_TOKEN are both empty
  // here even when .env sets them. The backend runs under Bun and does see them,
  // which is what made the two disagree: the API bound 0.0.0.0 while the dev server
  // it is reached through quietly stayed on loopback.
  //
  // An empty prefix means "every key", for this file only. It does not widen what
  // reaches the browser bundle — that is still `envPrefix` (VITE_), so DASHBOARD_TOKEN
  // is readable here and still never shipped to the client.
  //
  // A real environment variable outranks the file, matching Bun's precedence.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };

  // The dev server proxies /api and /socket to the backend, so exposing it to the
  // LAN exposes the backend too — a loopback-bound backend is no protection. Mirror
  // the backend's rule (src/server/index.ts): loopback unless HOST says otherwise,
  // and never off-box without a token.
  const host = env.HOST?.trim() || '127.0.0.1';
  if (!isLoopbackHost(host) && !env.DASHBOARD_TOKEN?.trim()) {
    throw new Error(
      `Refusing to start: HOST=${host} exposes the dev server (and the API it proxies) beyond loopback ` +
      'but DASHBOARD_TOKEN is not set. Set DASHBOARD_TOKEN in .env, or drop HOST to bind loopback only.',
    );
  }

  return {
    plugins: [react()],
    preview: { host },
    server: {
      port: 5173,
      host,
      proxy: {
        '/api': env.VITE_BACKEND_ORIGIN ?? 'http://localhost:4317',
        '/socket': {
          target: env.VITE_BACKEND_WS_ORIGIN ?? 'http://localhost:4317',
          ws: true,
          changeOrigin: true,
          configure(proxy) {
            // Backend may not be ready when Vite starts; swallow ECONNREFUSED so
            // the log isn't noisy. The client reconnect loop handles retries.
            proxy.on('error', () => {});
          },
        },
      },
    },
  };
});
