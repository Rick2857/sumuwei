/**
 * M7 WP3 —— **规则模式精度探针**（`pnpm m7:wp3:probe`）。
 *
 * ============================================================================
 *  为什么这个门先于实现存在
 * ============================================================================
 * ADR-064 附录 A 的冻结程序（M6-FMB-01 §3 硬顺序对关系提案器同样适用）：
 * **判定契约 → 量具有效性验证 → 才实现机器门与规则**。
 * 语义规则（R-2/R-3/R-4）的模式清单是候选；本探针对 120 条对抗语料测精度，
 * 语义族 precision ≥ 90% 才算冻结。不达标 ⇒ 缩清单重跑，不放宽判据。
 *
 * ============================================================================
 *  量具纪律
 * ============================================================================
 * · §6.7 三段式在本门的形态：正控 = 应触发样本必须触发（recall 面）；
 *   负控 = 对抗形样本必须安静（precision 面）；恢复 = 探针自身的行为
 *   在注入已知答案后仍可复现（同一输入两次运行读数逐字一致——确定性自证）。
 * · §6.8：measured_count 自检——语料 120 条、每族正控/负控各 ≥ 20，
 *   分母为 0 ⇒ MEASUREMENT INVALID。
 * · 本探针主张的是「冻结清单在对抗形语料上的精度」，**不是**真实世界精度
 *   （语料是人工编写的对抗形集合；真实分布需要真实对话与隐私审查，另行授权）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  RELATIONSHIP_PATTERN_RULE_VERSION,
  matchRelationshipPatterns,
  type RelationshipRuleFamily,
} from '../src/kernel/app/relationship/patterns.ts'
import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const CORPUS_PATH = join(REPO_ROOT, 'evals/fixtures/m7/relationship-rule-corpus.json')

/** 语料族 → 模式族的映射（r4 语料覆盖 r4a + r4b 两个模式族） */
const FAMILY_PATTERNS: Readonly<Record<string, readonly RelationshipRuleFamily[]>> = {
  r2: ['r2'],
  r3: ['r3'],
  r4: ['r4a', 'r4b'],
}

const PRECISION_FLOOR = 0.9

interface CorpusSample {
  id: string
  family: string
  expect: 'fire' | 'silent'
  text: string
  note: string
}

interface FamilyStat {
  family: string
  positive: number
  negative: number
  tp: number
  fp: number
  fn: number
  tn: number
  precision: number
  recall: number
  falsePositives: { sampleId: string; text: string; matchedPatterns: string[] }[]
  falseNegatives: { sampleId: string; text: string }[]
}

function main(): void {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { samples: CorpusSample[] }
  const samples = corpus.samples

  // ---- 结构自检（§6.8：分母必须真实存在）----
  const structureOk =
    samples.length === 120 &&
    Object.keys(FAMILY_PATTERNS).every((family) => {
      const mine = samples.filter((s) => s.family === family)
      return (
        mine.filter((s) => s.expect === 'fire').length >= 20 &&
        mine.filter((s) => s.expect === 'silent').length >= 20
      )
    })

  // ---- 逐族测量 ----
  const stats: FamilyStat[] = []
  for (const family of Object.keys(FAMILY_PATTERNS)) {
    const patternFamilies = FAMILY_PATTERNS[family]
    const mine = samples.filter((s) => s.family === family)
    let tp = 0
    let fp = 0
    let fn = 0
    let tn = 0
    const falsePositives: FamilyStat['falsePositives'] = []
    const falseNegatives: FamilyStat['falseNegatives'] = []

    for (const sample of mine) {
      const matches = matchRelationshipPatterns(sample.text)
      const familyMatches = matches.filter((m) => patternFamilies.includes(m.ruleId))
      const fired = familyMatches.length > 0
      if (sample.expect === 'fire') {
        if (fired) tp += 1
        else {
          fn += 1
          falseNegatives.push({ sampleId: sample.id, text: sample.text })
        }
      } else {
        if (fired) {
          fp += 1
          falsePositives.push({
            sampleId: sample.id,
            text: sample.text,
            matchedPatterns: familyMatches.map((m) => m.patternId),
          })
        } else tn += 1
      }
    }

    const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
    stats.push({
      family,
      positive: mine.filter((s) => s.expect === 'fire').length,
      negative: mine.filter((s) => s.expect === 'silent').length,
      tp,
      fp,
      fn,
      tn,
      precision,
      recall,
      falsePositives,
      falseNegatives,
    })
  }

  // ---- 恢复段：确定性自证（同一输入跑两遍，命中清单逐字一致）----
  const runOnce = (): string =>
    samples.map((s) => `${s.id}:${matchRelationshipPatterns(s.text).map((m) => m.patternId).join(',')}`).join(';')
  const deterministic = runOnce() === runOnce()

  // ---- 判定 ----
  const precisionOk = stats.every((s) => s.precision >= PRECISION_FLOOR)
  const recallReported = stats.every((s) => s.tp + s.fn > 0)
  const verdict = !structureOk || !recallReported
    ? 'MEASUREMENT INVALID'
    : precisionOk && deterministic
      ? 'PASS'
      : 'FAIL'

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM7RunId({ wpId: 'wp3-probe', headShort: head })
  const dir = openM7RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm7-wp3-probe@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    patternRuleVersion: RELATIONSHIP_PATTERN_RULE_VERSION,
    corpusPath: 'evals/fixtures/m7/relationship-rule-corpus.json',
    corpusSize: samples.length,
    precisionFloor: PRECISION_FLOOR,
    claim:
      '冻结清单在对抗形语料上的精度（非真实世界分布精度；语料为人工对抗形集合）',
    families: stats,
    deterministic,
    verdict,
  }
  writeFileSync(join(dir, 'probe.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(dir, {
    runId,
    wp: 'wp3-probe',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'rule-probe',
    counts: {
      total: samples.length,
      passed: stats.reduce((sum, s) => sum + s.tp + s.tn, 0),
      failed: stats.reduce((sum, s) => sum + s.fp + s.fn, 0),
    },
    phases: ['single'],
    supersedes: null,
    notes: 'M7 WP3 模式精度探针：三族 precision ≥ 0.90 才冻结（ADR-064 附录 A）',
  })

  console.log(`runId: ${runId}`)
  for (const s of stats) {
    console.log(
      `  ${s.precision >= PRECISION_FLOOR ? '✅' : '❌'} ${s.family}: precision=${(s.precision * 100).toFixed(1)}% · recall=${(s.recall * 100).toFixed(1)}% · TP=${s.tp} FP=${s.fp} FN=${s.fn} TN=${s.tn}`,
    )
    for (const fpItem of s.falsePositives) {
      console.log(`     FP ${fpItem.sampleId} ← ${fpItem.matchedPatterns.join(',')}: ${fpItem.text}`)
    }
    for (const fnItem of s.falseNegatives) {
      console.log(`     FN ${fnItem.sampleId}: ${fnItem.text}`)
    }
  }
  console.log(`deterministic: ${String(deterministic)} · corpus: ${String(samples.length)} 条`)
  console.log(`verdict: ${verdict}`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main()
