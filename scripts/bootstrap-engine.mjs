#!/usr/bin/env node
// Obtain exact upstream SimulationCraft revision from engine.lock.json into vendor/simc (PLAN P00.3); idempotent verification.
// Never tracks moving branch; commit is checked out detached; vendor/simc is read-only, refuses local mods.
// Node rather than bash so it runs on Windows too; scripts/bootstrap-engine.sh forwards here.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { remote, branch, commit, path } = JSON.parse(readFileSync(join(root, 'engine.lock.json'), 'utf8')).upstream

// FROSTSIM_ENGINE_DIR retargets checkout (clean-clone path untestable without destroying working checkout).
const dir = process.env.FROSTSIM_ENGINE_DIR || join(root, path)
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const tryGit = (...args) => { try { return git(...args) } catch { return null } }
const fail = (...lines) => { for (const l of lines) console.error(l); process.exit(1) }

if (!existsSync(join(dir, '.git'))) {
  console.log(`bootstrap: ${dir} absent, fetching ${commit} from ${remote}`)
  mkdirSync(dir, { recursive: true })
  git('init', '-q')
  git('remote', 'add', 'origin', remote)
  // Single-commit fetch (GitHub allows arbitrary reachable SHA); pulls ~360 MB tree not full history.
  git('fetch', '-q', '--depth', '1', 'origin', commit)
  git('checkout', '-q', '--detach', 'FETCH_HEAD')
  console.log(`bootstrap: checked out ${commit}`)
  process.exit(0)
}

const actualRemote = tryGit('remote', 'get-url', 'origin') ?? 'none'
if (actualRemote !== remote) {
  fail(`bootstrap: ${dir} points at '${actualRemote}', lock says '${remote}'.`,
    '           Refusing to repoint an existing checkout. Move it aside and rerun.')
}

const dirty = () => git('status', '--porcelain').split('\n').filter(Boolean).slice(0, 5).join('\n')
const head = git('rev-parse', 'HEAD')
if (head === commit) {
  const d = dirty()
  if (d) {
    fail(`bootstrap: ${dir} is at the locked commit but has local modifications:`, d,
      '           vendor/simc is read-only; engine changes belong in patches/. Not touching it.')
  }
  console.log(`bootstrap: ${dir} already at ${commit} (clean)`)
  process.exit(0)
}

const d = dirty()
if (d) fail(`bootstrap: ${dir} has local modifications; refusing to move it from ${head} to ${commit}.`, d)

console.log(`bootstrap: moving ${dir} from ${head} to ${commit}`)
if (tryGit('fetch', '-q', 'origin', commit) === null) git('fetch', '-q', 'origin', branch)
git('checkout', '-q', '--detach', commit)
console.log(`bootstrap: checked out ${commit}`)
