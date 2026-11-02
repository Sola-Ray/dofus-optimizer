import { defineConfig } from 'vite';

// base relative : le site fonctionne aussi sur GitHub Pages (/dofus-optimizer/)
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
