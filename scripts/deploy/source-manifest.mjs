import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, lstatSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'

const roots = ['src', 'scripts', 'resources', 'tools', 'experiments/omni-realtime',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', '.gitattributes', 'evals/m9.5/embedding-manifest.json']
const allowed = path => !/(^|\/)(node_modules|data|local|\.env[^/]*)(\/|$)/.test(path)
  && !/\.private(?:[.-]|$)/i.test(path) && (/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|py|sh|ps1|html|css|json|yaml|yml)$/.test(path)
    || path.startsWith('resources/') && /\.md$/.test(path) || path === '.gitattributes')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function sourceManifest(root) {
  const git = args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots])
  if (listed.status !== 0) throw new Error('source_manifest_git_failed')
  const paths = [...new Set(listed.stdout.split('\0').filter(Boolean).filter(allowed))].sort()
  if (!paths.length) throw new Error('source_manifest_empty')
  const files = paths.map(path => {
    const abs = join(root, path)
    if (!lstatSync(abs).isFile()) throw new Error('source_manifest_non_regular_file')
    const bytes = readFileSync(abs)
    return { path, bytes: bytes.length, sha256: hash(bytes) }
  })
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const req = createRequire(join(resolve(root), 'package.json'))
  const installed = {}
  for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
    try {
      // Resolve package metadata without importing models or starting services.
      let dir = req.resolve(name)
      for (let i = 0; i < 12; i++) {
        dir = resolve(dir, '..')
        try {
          const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
          if (p.name === name) { installed[name] = p.version; break }
        } catch { /* package metadata is higher up */ }
      }
      installed[name] ??= null
    } catch { installed[name] = null }
  }
  const status = git(['status', '--porcelain', '--untracked-files=normal'])
  return { version: 1, head: git(['rev-parse', 'HEAD']).stdout.trim(), dirty: status.stdout.length > 0,
    treeSha256: hash(JSON.stringify(files)), files, requiredSchema: Math.max(...[...readFileSync(
      join(root, 'src/infrastructure/persistence/migrations.ts'), 'utf8').matchAll(/const MIGRATION_(\d+):/g)].map(m => Number(m[1]))),
    runtime: { node: process.version, platform: process.platform, arch: process.arch,
      engines: pkg.engines, declared: pkg.dependencies, installed } }
}
export function verifySourceManifest(root, manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) return false
  if (hash(JSON.stringify(manifest.files)) !== manifest.treeSha256) return false
  const listed = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  if (listed.status === 0) {
    const paths = [...new Set(listed.stdout.split('\0').filter(Boolean).filter(allowed))].sort()
    if (JSON.stringify(paths) !== JSON.stringify(manifest.files.map(file => file.path))) return false
  }
  const seen = new Set()
  return manifest.files.every(file => {
    if (typeof file.path !== 'string' || !allowed(file.path) || seen.has(file.path)) return false
    seen.add(file.path)
    const abs = resolve(root, file.path)
    const rel = relative(resolve(root), abs)
    if (rel.startsWith('..') || isAbsolute(rel)) return false
    try { return lstatSync(abs).isFile() && hash(readFileSync(abs)) === file.sha256 } catch { return false }
  })
}
