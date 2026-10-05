import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

const require = createRequire(import.meta.url)
const webRoot = fileURLToPath(new URL('./', import.meta.url))
const pythonPackageEntry = require.resolve('@codemirror/lang-python', { paths: [webRoot] })
// Resolve the common package through CodeMirror's language package so Vite
// cannot accidentally use a second @lezer/common copy from a stale nested
// install. NodeProp identities must be shared by parsers and highlighters.
const lezerCommonPackage = dirname(dirname(require.resolve('@lezer/common', { paths: [dirname(pythonPackageEntry)] })))

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    // All Lezer packages must share one @lezer/common instance. Otherwise
    // syntax-tree NodeProp IDs come from different copies and CodeMirror's
    // highlighter crashes while walking the tree.
    dedupe: ['@lezer/common', '@lezer/highlight'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@lezer/common': lezerCommonPackage,
    },
  },
  server: {
    port: 3000,
  },
  build: {
    outDir: 'dist',
    manifest: true,
    sourcemap: false,
  },
})
