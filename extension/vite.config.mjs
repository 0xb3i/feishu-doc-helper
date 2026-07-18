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
    outDir: process.env.FEISHU_EXTENSION_UI_OUT_DIR
      ? resolve(process.env.FEISHU_EXTENSION_UI_OUT_DIR)
      : resolve('dist/feishu-extension/ui'),
    emptyOutDir: false,
    target: 'chrome111',
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
