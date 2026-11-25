import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The deployment writes this; without it the build has no deployment.json and the page says so.
const DEPLOYMENT = new URL('../docs/deployments/testnet.json', import.meta.url);

export default defineConfig({
  base: './',
  // A static site, not an SPA: a missing deployment.json must be a 404, not index.html.
  appType: 'mpa',
  build: { outDir: 'dist', emptyOutDir: true },
  preview: { port: 4173, strictPort: true },
  plugins: [
    {
      name: 'deployment-json',
      generateBundle() {
        if (existsSync(DEPLOYMENT)) this.emitFile({ type: 'asset', fileName: 'deployment.json', source: readFileSync(DEPLOYMENT) });
      },
    },
  ],
});
