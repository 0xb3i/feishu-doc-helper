import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve('extension/ui'),
  base: './',
  esbuild: {
    jsx: 'automatic',
    jsxDev: false,
  },
  build: {
    outDir: resolve('dist/feishu-extension/ui'),
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      input: resolve('extension/ui/popup.html'),
      output: {
        entryFileNames: 'assets/popup.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: function (assetInfo) {
          return assetInfo.name === 'popup.css' ? 'assets/popup.css' : 'assets/[name][extname]';
        },
      },
    },
  },
});
