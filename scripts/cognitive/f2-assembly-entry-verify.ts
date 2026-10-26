/*
 * F2 装配层入口解析门（纯函数 · 零模型请求 · 零数据库）。
 *
 * 证明：开关关 ⇒ `not_applicable`（旧行为逐字不变）；合法 F2 请求 ⇒ 范围 + **准备读路径 = 权威源**；
 *       自称 F2 但形状不合法 ⇒ `rejected:f2_<reason>`（不截半执行）；准备读**只读权威源**（不是缓存源）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveF2EntryScope } from '../../src/infrastructure/runtime/simulation-planning.ts'

const OUT_DIR = resolve('artifacts/local/f2-assembly-entry')
const OK = 'F2 只操作相对路径 f1/a/obj-01.txt；缓存源 f1/a/obj-01.cache；权威源 f1/a/obj-01.src；族标记 f1/a/.freshness，最多读一次。'

const checks: Array<{ label: string, pass: boolean, detail: string }> = []
const check = (label: string, pass: boolean, detail = ''): void => {
  checks.push({ label, pass, detail })
  assert.ok(pass, `${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// 开关关 ⇒ 旧行为
check('① 开关关 ⇒ not_applicable（旧入口行为逐字不变）',
  resolveF2EntryScope({ enabled: false, text: OK }).kind === 'not_applicable')

// 合法请求 ⇒ 范围 + 准备读路径
const entry = resolveF2EntryScope({ enabled: true, text: OK })
check('② 合法请求 ⇒ entry，四路径齐全、族命中 f1/a',
  entry.kind === 'entry' && entry.targetPath === 'f1/a/obj-01.txt' &&
  entry.cacheSource === 'f1/a/obj-01.cache' && entry.authoritativeSource === 'f1/a/obj-01.src' &&
  entry.familyMarker === 'f1/a/.freshness')
check('③ **准备读路径 = 权威源**（不是缓存源；A 裁定：真值指纹来自真实读权威源）',
  entry.kind === 'entry' && entry.prepReadPath === 'f1/a/obj-01.src' && entry.prepReadPath !== entry.cacheSource)
check('④ 派生范围与 R4 一致：两源只读、标记限次一次、目标可写',
  entry.kind === 'entry' &&
  entry.sourceScopedPaths.readOnly.length === 2 && entry.sourceScopedPaths.readOnly.includes('f1/a/obj-01.cache') &&
  entry.sourceScopedPaths.limitedReads.length === 1 && entry.sourceScopedPaths.limitedReads[0]!.maxReads === 1 &&
  entry.sourceScopedPaths.writable.length === 1 && entry.sourceScopedPaths.writable[0] === 'f1/a/obj-01.txt')

// 非法形状 ⇒ 明确拒绝（带 f2_ 前缀，便于闭集归因）
const rejected = resolveF2EntryScope({ enabled: true, text: 'F2 请把 f1/a/obj-01.txt 写对' })
check('⑤ 自称 F2 但形状不合法 ⇒ rejected:f2_bad_prefix（不截半执行）',
  rejected.kind === 'rejected' && rejected.reason === 'f2_bad_prefix',
  rejected.kind === 'rejected' ? rejected.reason : rejected.kind)
const escaped = resolveF2EntryScope({ enabled: true, text: 'F2 只操作相对路径 f1/../a/obj-01.txt；缓存源 f1/a/obj-01.cache；权威源 f1/a/obj-01.src；族标记 f1/a/.freshness，最多读一次。' })
check('⑥ 逃逸路径 ⇒ rejected:f2_absolute_or_escape_path',
  escaped.kind === 'rejected' && escaped.reason === 'f2_absolute_or_escape_path')

// 开关开但不是 F2 请求 ⇒ not_applicable（不干扰旧入口）
check('⑦ 开关开 + 普通请求 ⇒ not_applicable',
  resolveF2EntryScope({ enabled: true, text: '帮我整理桌面' }).kind === 'not_applicable')

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(resolve(OUT_DIR, 'verification.json'), `${JSON.stringify({
  schema: 'f2-assembly-entry-gate@1',
  status: 'PASS',
  checks,
  boundaries: [
    '本门是**纯函数**门（零模型、零数据库、零文件系统）',
    '它证明入口解析与范围/准备读路径的派生；**不**证明准备读已真被调度、也**不**证明闭环已跑通',
  ],
}, null, 2)}\n`, 'utf8')
console.log(`F2 装配层入口门：${String(checks.length)} 项检查全部通过（零模型请求）`)
for (const item of checks) console.log(`PASS ${item.label}${item.detail === '' ? '' : ` — ${item.detail}`}`)
