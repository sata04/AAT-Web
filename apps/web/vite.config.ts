import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const appRoot = fileURLToPath(new URL('.', import.meta.url))

// The poster engine (Pyodide + matplotlib wheels) is vendored into
// `node_modules/.cache/poster-assets/pyodide/<version>/` by
// `scripts/vendor-poster-assets.mjs` and served from `/pyodide/<version>/`. The versioned path
// makes every URL immutable, which is what allows the CacheFirst runtime cache below and what
// keeps `connect-src 'self'` honest — nothing at runtime may come from the Pyodide CDN.
function posterAssetsPlugin(): Plugin {
  const require = createRequire(import.meta.url)
  const pyodideVersion = (require('pyodide/package.json') as { version: string }).version
  const assetDir = join(appRoot, 'node_modules', '.cache', 'poster-assets', 'pyodide', pyodideVersion)

  // Vendoring runs once per process, on demand: buildStart covers `vite build`, the first
  // `/pyodide/` request covers `vite dev` (buildStart does not fire for the dev server). The
  // script is idempotent and a no-op once the cache exists, so this is cheap insurance rather
  // than a per-boot download.
  let vendored = false
  const vendor = () => {
    if (vendored) return
    execFileSync(process.execPath, [join(appRoot, 'scripts/vendor-poster-assets.mjs')], {
      cwd: appRoot,
      stdio: 'inherit',
    })
    vendored = true
  }

  const contentType = (file: string) =>
    file.endsWith('.wasm')
      ? 'application/wasm'
      : file.endsWith('.mjs')
        ? 'text/javascript'
        : file.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream'

  return {
    name: 'aat-poster-assets',
    buildStart: vendor,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        const prefix = `/pyodide/${pyodideVersion}/`
        if (!url.startsWith(prefix)) return next()
        vendor()
        // Reject traversal outright — this middleware must serve the vendored dir and nothing else.
        const rel = normalize(url.slice(prefix.length))
        const filePath = join(assetDir, rel)
        if (rel.startsWith('..') || !filePath.startsWith(assetDir + sep)) {
          res.statusCode = 404
          return res.end()
        }
        try {
          const body = readFileSync(filePath)
          // Versioned URL == immutable body: the cache can hold this forever.
          res.setHeader('Content-Type', contentType(filePath))
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          res.end(body)
        } catch {
          res.statusCode = 404
          res.end()
        }
      })
    },
    generateBundle() {
      // Emit each vendored file under its stable /pyodide/<version>/ path so the deployed
      // asset layout matches the dev-server layout exactly. `fileName` (not `name`) pins the
      // output path verbatim — a hashed name would defeat the immutable-URL contract.
      for (const file of readdirSync(assetDir)) {
        this.emitFile({
          type: 'asset',
          fileName: `pyodide/${pyodideVersion}/${file}`,
          source: readFileSync(join(assetDir, file)),
        })
      }
    },
  }
}

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
    // Assets go to dist/client, which is what wrangler.jsonc's assets.directory
    // points at and what the CI verify job hands to the deploy job. Emitting to
    // a bare dist/ leaves the Worker with no static assets to serve.
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2023',
    sourcemap: true,
    rollupOptions: {
      output: {
        // uPlot is large, stable, and unrelated to the analysis engine. Splitting
        // it means a change to either one does not invalidate the other's cache
        // entry in an installed PWA. Written as a function because Vite 8's
        // bundler (Rolldown) only accepts that form.
        manualChunks: (id: string) => (id.includes('node_modules/uplot') ? 'uplot' : undefined),
      },
    },
  },

  plugins: [
    react(),
    posterAssetsPlugin(),
    VitePWA({
      // `prompt`, never `autoUpdate`: an installed instance must not swap its
      // bundle underneath a running analysis or a half-finished export. See
      // `src/pwa/update.ts`.
      registerType: 'prompt',
      // Registration is done explicitly in application code so the update prompt
      // is part of the UI rather than a browser-level surprise.
      injectRegister: null,

      workbox: {
        // Static app assets only. Nothing under `/api/v1/*` may ever be cached —
        // an authenticated response must never land in a cache that another user
        // of the same machine, or the same user after signing out, could be
        // served from. The one runtimeCaching entry below is scoped to the
        // versioned, immutable poster-engine assets only and changes nothing
        // about that rule.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        // The analysis engine plus uPlot exceeds the 2 MiB default; without this
        // the largest chunk would be silently left out of the precache and the
        // app would not actually work offline. (The poster engine is deliberately
        // runtime-cached, not precached — see runtimeCaching.)
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,

        // The poster engine (~26 MiB of Pyodide core + matplotlib wheels) is
        // runtime-cached rather than precached: precaching would make every
        // install pay the download even when posters are never opened, while
        // lazy loading is the engine's whole design. Every URL under
        // `/pyodide/<version>/` is versioned and therefore immutable, so
        // CacheFirst-forever is correct and is what makes repeat poster renders
        // work offline. Nothing here is user data — the /api no-cache rule is
        // untouched.
        runtimeCaching: [
          {
            // A function matcher, not a RegExp: Workbox evaluates a RegExp
            // against the request's href *starting at index 0* for same-origin
            // requests, so `/^\/pyodide\//` can never match
            // `https://<host>/pyodide/…` — the pattern must see the pathname.
            urlPattern: ({ url }: { url: URL }) =>
              url.origin === self.location.origin && url.pathname.startsWith('/pyodide/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'aat-poster-engine',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 64, maxAgeSeconds: 90 * 24 * 60 * 60 },
            },
          },
        ],
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
