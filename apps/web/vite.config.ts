import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Build configuration for the AAT Web client.
 *
 * The Cloudflare plugin is deliberately absent: this application is local-first
 * and its build must not depend on a Worker being configured. `apps/web/worker/`
 * is served by Wrangler separately; adding `cloudflare()` here would make a
 * missing `wrangler.jsonc` break the build of a client that does not need one.
 */
export default defineConfig({
  // Module workers, so `new Worker(url, { type: 'module' })` survives the build
  // instead of being downgraded to a classic worker that cannot use ESM imports.
  worker: { format: 'es' },

  build: {
    target: 'es2023',
    sourcemap: true,
    rollupOptions: {
      output: {
        // uPlot is large, stable, and unrelated to the analysis engine. Splitting
        // it means a change to either one does not invalidate the other's cache
        // entry in an installed PWA.
        manualChunks: {
          uplot: ['uplot'],
        },
      },
    },
  },

  plugins: [
    react(),
    VitePWA({
      // `prompt`, never `autoUpdate`: an installed instance must not swap its
      // bundle underneath a running analysis or a half-finished export. See
      // `src/pwa/update.ts`.
      registerType: 'prompt',
      // Registration is done explicitly in application code so the update prompt
      // is part of the UI rather than a browser-level surprise.
      injectRegister: null,

      workbox: {
        // Static assets only. There is no `runtimeCaching` entry on purpose: an
        // authenticated `/api/v1/*` response must never land in a cache that
        // another user of the same machine, or the same user after signing out,
        // could be served from.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        // The analysis engine plus uPlot exceeds the 2 MiB default; without this
        // the largest chunk would be silently left out of the precache and the
        // app would not actually work offline.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },

      manifest: {
        name: 'AAT — Acceleration Analysis Tool',
        short_name: 'AAT',
        description: '微小重力実験の加速度データを解析します。',
        lang: 'ja',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0D1117',
        theme_color: '#0D1117',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
