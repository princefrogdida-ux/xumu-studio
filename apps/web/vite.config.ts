import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root, plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.STUDIO_WEB_PORT ?? 4310), strictPort: true, proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 4311}` } },
  build: { outDir: path.resolve(root, '../../dist/web'), emptyOutDir: true },
});
