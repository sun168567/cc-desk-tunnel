import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  // React's compiler keeps what a component drew when nothing it reads has changed, so that a key pressed or a
  // second ticking does not redraw the whole page.
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  resolve: {
    alias: {
      '@lobehub/icons': fileURLToPath(new URL('./src/lobehub-icons.tsx', import.meta.url)),
    },
  },
  server: { host: '127.0.0.1', strictPort: true, watch: { ignored: ['**/vendor/**'] } },
  build: { outDir: 'dist' },
});
