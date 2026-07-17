import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', '..', 'dist');
const indexHtml = path.join(distDir, 'index.html');

export function registerStaticRoutes(app: express.Express) {
  if (!existsSync(indexHtml)) return;

  app.use(express.static(distDir, { index: false }));
  app.get(/^(?!\/api\/|\/socket$).*/, (_request, response) => {
    response.sendFile(indexHtml);
  });
}
