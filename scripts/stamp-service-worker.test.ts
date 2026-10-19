import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { build } from 'vite'
import { stampServiceWorker } from '../vite.config'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it.each(['build/audit-cloud-ui', '/absolute-output'])('stamps the resolved root/outDir and preserves unrelated dist: %s', async outDir => {
  const workspace = mkdtempSync(join(tmpdir(), 'frostsim-sw-'))
  directories.push(workspace)
  const root = join(workspace, 'project')
  const output = outDir.startsWith('/') ? join(workspace, outDir) : join(root, outDir)
  mkdirSync(join(root, 'public'), { recursive: true })
  mkdirSync(join(root, 'public', 'assets'), { recursive: true })
  mkdirSync(join(root, 'src', 'lib', 'account'), { recursive: true })
  mkdirSync(join(root, 'dist', 'assets'), { recursive: true })
  writeFileSync(join(root, 'dist', 'sw.js'), 'unrelated old service worker\n')
  writeFileSync(join(root, 'dist', 'index.html'), 'unrelated old index\n')
  writeFileSync(join(root, 'dist', 'assets', 'old.js'), 'old')
  writeFileSync(join(root, 'public', 'sw.js'), 'self.addEventListener("fetch", () => {})\n')
  writeFileSync(join(root, 'public', 'assets', 'pi-detail-fixture.js'), 'on demand')
  writeFileSync(join(root, 'index.html'), '<script type="module" src="/main.js"></script>')
  writeFileSync(join(root, 'main.js'), 'import "./shared.css"; import("./src/lib/account/account.js").then(m => m.show()); import("./tool.js").then(m => m.show())')
  writeFileSync(join(root, 'shared.css'), 'body { color: red }')
  writeFileSync(join(root, 'tool.js'), 'export const show = () => console.log("tool")')
  writeFileSync(join(root, 'src', 'lib', 'account', 'account.js'), 'import "../../../shared.css"; import "./account.css"; export const show = () => console.log("account")')
  writeFileSync(join(root, 'src', 'lib', 'account', 'account.css'), '.account { color: blue }')
  await build({ configFile: false, root, publicDir: 'public', logLevel: 'silent',
    plugins: [stampServiceWorker()], build: { outDir: outDir.startsWith('/') ? output : outDir } })
  const html = readFileSync(join(output, 'index.html'))
  const expected = createHash('sha256').update(html).digest('hex').slice(0, 12)
  const worker = readFileSync(join(output, 'sw.js'), 'utf8')
  expect(worker).toMatch(new RegExp(`^// build: ${expected}\\nself\\.__FROSTSIM_ASSETS = \\["/assets/`))
  const assets = JSON.parse(worker.split('\n')[1]!.replace('self.__FROSTSIM_ASSETS = ', '')) as string[]
  const emitted = readdirSync(join(output, 'assets'))
  expect(emitted.some(file => file.startsWith('account-') && file.endsWith('.js'))).toBe(true)
  expect(assets.some(file => file.includes('/account-') || file.includes('/pi-detail-'))).toBe(false)
  expect(assets.some(file => file.includes('/tool-') && file.endsWith('.js'))).toBe(true)
  expect(assets.some(file => file.includes('/index-') && file.endsWith('.css'))).toBe(true)
  expect(readFileSync(join(root, 'dist', 'sw.js'), 'utf8')).toBe('unrelated old service worker\n')
})
