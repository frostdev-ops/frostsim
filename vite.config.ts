import { configDefaults, defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import { engineCompat } from './scripts/engine-compat.mjs'
import { isAccountApi, proxyAccountApi } from './scripts/account-proxy.mjs'

// COOP/COEP required for SharedArrayBuffer; engine worker fails to start without them.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Production CSP from public/_headers; applied to preview only (not dev where HMR breaks it); P14.10 gate.
function productionCsp(): string | null {
  try {
    const headers = readFileSync(new URL('./public/_headers', import.meta.url), 'utf8')
    const line = headers.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'))
    return line ? line.slice(line.indexOf(':') + 1).trim() : null
  } catch {
    return null
  }
}

// Service worker updates only on byte change; stamp emitted asset names so worker updates when app changes.
function stampServiceWorker(): Plugin {
  // Chunks (and their CSS) reachable only through a dynamic import of src/lib/account/ (VITE_FEATURE_ACCOUNTS builds, CLAUDE.md D15)
  // load on use and stay out of the precache.
  const accountOnly = new Set<string>()
  return {
    name: 'frostsim-stamp-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      const chunk = (f: string) => {
        const o = bundle[f]
        return o?.type === 'chunk' ? o : undefined
      }
      // Module ids, not facadeModuleId: rolldown leaves the facade null on a dynamically imported chunk that is also imported statically.
      const account = (f: string) => !!chunk(f)?.moduleIds.some((id) => id.includes('/src/lib/account/'))
      // Follows the output chunk graph (tree-shaken, unlike the module graph) and every static import whatever the chunk is named.
      const walk = (stack: string[]) => {
        const seen = new Set<string>()
        for (let f = stack.pop(); f !== undefined; f = stack.pop()) {
          const c = chunk(f)
          if (!c || seen.has(f)) continue
          seen.add(f)
          stack.push(...c.imports, ...c.dynamicImports.filter((d) => !account(d)))
        }
        return seen
      }
      const names = Object.keys(bundle)
      const app = walk(names.filter((f) => chunk(f)?.isEntry))
      const appCss = new Set([...app].flatMap((f) => [...(chunk(f)?.viteMetadata?.importedCss ?? [])]))
      for (const f of walk(names.filter(account))) {
        if (app.has(f)) continue
        accountOnly.add(f)
        chunk(f)?.viteMetadata?.importedCss.forEach((css) => appCss.has(css) || accountOnly.add(css))
      }
    },
    closeBundle() {
      const swPath = new URL('./dist/sw.js', import.meta.url)
      const htmlPath = new URL('./dist/index.html', import.meta.url)
      if (!existsSync(swPath) || !existsSync(htmlPath)) return

      // Stamp is hash of index.html (names all hashed assets); earlier version missed CSS-only changes.
      const build = createHash('sha256').update(readFileSync(htmlPath)).digest('hex').slice(0, 12)

      // Full asset list, not just index.html (which misses dynamic chunks); emitted here not in worker.
      // Per-spec Power Infusion details (~70 KB each) load on demand and are cached on first open.
      const assets = readdirSync(new URL('./dist/assets/', import.meta.url))
        .filter((f) => !f.startsWith('pi-detail-') && !accountOnly.has(`assets/${f}`))
        .map((f) => `/assets/${f}`)
        .sort()

      const source = readFileSync(swPath, 'utf8')
        .replace(/^\/\/ build: [0-9a-f]+\n/, '')
        .replace(/^self\.__FROSTSIM_ASSETS = .*\n/m, '')
      writeFileSync(
        swPath,
        `// build: ${build}\nself.__FROSTSIM_ASSETS = ${JSON.stringify(assets)}\n${source}`,
      )
      this.info?.(`service worker stamped with build ${build}, ${assets.length} assets`)
    },
  }
}

// /api/v1/* goes to the account server (npm run account:serve), registered before the Battle.net /api middleware (CLAUDE.md D15).
function accountApiDev(): Plugin {
  return {
    name: 'frostsim-account-api-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => (isAccountApi(req.url) ? proxyAccountApi(req, res) : next()))
    },
  }
}

// Runs the game-data proxy handler in-process for dev only; secrets come from .dev.vars, never a VITE_ variable.
function gameDataProxyDev(): Plugin {
  return {
    name: 'frostsim-game-data-proxy-dev',
    apply: 'serve',
    configureServer(server) {
      const handlerPath = new URL('./functions/api/[[path]].ts', import.meta.url)
      server.middlewares.use('/api', async (req, res) => {
        if (!existsSync(handlerPath)) {
          res.statusCode = 503
          res.end('No /api handler yet: create functions/api/[[path]].ts')
          return
        }
        try {
          const env = { ...process.env, ...readDevVars() }
          const mod = await server.ssrLoadModule(fileURLToPath(handlerPath))
          const onRequest = mod.onRequest ?? mod.default
          const url = new URL(req.url ?? '/', 'http://localhost')
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers.set(k, v)
            else if (Array.isArray(v)) headers.set(k, v.join(', '))
          }
          const request = new Request(`http://localhost/api${url.pathname}${url.search}`, {
            method: req.method,
            headers,
          })
          const response: Response = await onRequest({ request, env, params: {}, data: {} })
          res.statusCode = response.status
          response.headers.forEach((v, k) => res.setHeader(k, v))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (err) {
          // Handler threw; report error instead of hanging request.
          res.statusCode = 500
          res.end(`/api handler threw: ${(err as Error).message}`)
        }
      })
    },
  }
}

function readDevVars(): Record<string, string> {
  try {
    const text = readFileSync(new URL('./.dev.vars', import.meta.url), 'utf8')
    return Object.fromEntries(
      text.split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    )
  } catch {
    return {}
  }
}

const csp = productionCsp()
const siteLegal = ['terms.html', 'privacy.html'].map((name) => existsSync(new URL(`./public/legal/${name}`, import.meta.url)))
if (siteLegal.some(Boolean) && !siteLegal.every(Boolean)) throw new Error('Both private legal documents are required.')

export default defineConfig({
  define: {
    'import.meta.env.VITE_SITE_LEGAL': JSON.stringify(siteLegal.every(Boolean)),
    // Accounts and cloud features compile out unless built with VITE_FEATURE_ACCOUNTS=1 (CLAUDE.md D15).
    'import.meta.env.VITE_FEATURE_ACCOUNTS': JSON.stringify(process.env.VITE_FEATURE_ACCOUNTS === '1'),
    // The app runs only engine packs built from the same contract (scripts/update-engines.mjs).
    __ENGINE_COMPAT__: JSON.stringify(engineCompat(fileURLToPath(new URL('.', import.meta.url)))),
  },
  plugins: [svelte(), stampServiceWorker(), accountApiDev(), gameDataProxyDev()],
  server: { headers: crossOriginIsolation },
  preview: {
    headers: csp ? { ...crossOriginIsolation, 'Content-Security-Policy': csp } : crossOriginIsolation,
  },
  test: {
    // release/ has tests with repo-root imports; keep source tests, exclude release.
    exclude: [...configDefaults.exclude, 'release/**', 'vendor/**'],
  },
})
