/** 当前候选的完整回归承接；历史稳定文件不被新结果覆盖。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validateLv2Manifest } from './lv2-evidence.ts'

export function inspectLv2Regression(root: string, directory: string) {
  const problems: string[] = []
  let manifest: any, regression: any
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
    regression = JSON.parse(readFileSync(join(directory, 'regression.json'), 'utf8'))
  } catch { return { valid: false, runId: null, problems: ['完整回归清单或读数缺失'], g14: null } }
  for (const problem of validateLv2Manifest(manifest)) problems.push(`${problem.field}: ${problem.problem}`)
  if (manifest.runId !== regression.runId || manifest.wp !== 'wp6-repair-regression') problems.push('回归身份不一致')
  if (manifest.faultInjection != null) problems.push('故障注入档不能作为正式回归')
  if (manifest.cleanClose !== true || manifest.realDb?.opened !== false) problems.push('隔离或收尾不成立')
  if (regression.command !== 'pnpm with-test-model pnpm m4.5:ci:full' || regression.exitCode !== 0 || manifest.verdict !== 'PASS') problems.push('完整回归没有成功退出')
  if (regression.g14?.status !== 'PASS' || regression.g14?.checks?.failed !== 0 || !(regression.g14?.checks?.passed > 0)) problems.push('真实回归没有有效通过读数')
  const fingerprints = manifest.sourceFingerprints ?? {}
  const required = ['src/main.ts', 'src/kernel/contracts/memory.ts', 'src/kernel/policies/memory-validator.ts',
    'src/kernel/app/memory/explicit-service.ts', 'src/kernel/app/goal/turn.ts', 'package.json']
  for (const file of required) if (!fingerprints[file]) problems.push(`回归指纹缺少 ${file}`)
  for (const [file, expected] of Object.entries(fingerprints)) {
    const path = resolve(root, file), rel = relative(root, path)
    if (isAbsolute(rel) || rel.startsWith('..') || !existsSync(path)) problems.push(`源码不可读：${file}`)
    else if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) problems.push(`源码变化：${file}`)
  }
  for (const [pathKey, hashKey] of [['logLocal', 'logSha256'], ['originalSmokeLocal', 'originalSmokeSha256']] as const) {
    const path = resolve(root, String(regression[pathKey] ?? ''))
    const privateRoot = resolve(root, 'artifacts/lv2/local') + sep
    if (!path.startsWith(privateRoot) || !existsSync(path)) problems.push(`私有证据不可读：${pathKey}`)
    else if (createHash('sha256').update(readFileSync(path)).digest('hex') !== regression[hashKey]) problems.push(`私有证据摘要不一致：${pathKey}`)
  }
  try {
    const original = JSON.parse(readFileSync(resolve(root, regression.originalSmokeLocal), 'utf8'))
    if (original.testId !== regression.g14?.testId || original.status !== regression.g14?.status ||
      JSON.stringify(original.checks) !== JSON.stringify(regression.g14?.checks) ||
      JSON.stringify(original.controls) !== JSON.stringify(regression.g14?.controls)) problems.push('公开 Smoke 读数与原始证据不一致')
  } catch { problems.push('原始 Smoke 不可解析') }
  return { valid: problems.length === 0, runId: manifest.runId as string, problems, g14: regression.g14 }
}

export function readLatestLv2Regression(root: string) {
  const parent = join(root, 'artifacts/lv2')
  const candidates = existsSync(parent) ? readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('lv2-wp6-repair-regression-')).flatMap(entry => {
    const directory = join(parent, entry.name)
    try { const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')); return [{ directory, ended: String(manifest.ended ?? ''), runId: entry.name }] }
    catch { return [{ directory, ended: '', runId: entry.name }] }
  }).sort((a, b) => b.ended.localeCompare(a.ended) || b.runId.localeCompare(a.runId)) : []
  return candidates.length ? inspectLv2Regression(root, candidates[0]!.directory) : undefined
}
