import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', '..', 'dist');
const indexHtml = path.join(distDir, 'index.html');

export function registerStaticRoutes(app: express.Express) {
  if (!existsSync(indexHtml)) return;

  app.use(express.static(distDir, {
    index: false,
    // Vite fingerprints everything under /assets/, so those files are cached
    // hard and forever. Anything else (index.html, favicons) must revalidate,
    // or a client would pin an old asset manifest until its cache expired.
    setHeaders(res, filePath) {
      if (path.relative(distDir, filePath).startsWith(`assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get(/^(?!\/api\/|\/socket$).*/, (_request, response) => {
    response.sendFile(indexHtml);
  });
}
