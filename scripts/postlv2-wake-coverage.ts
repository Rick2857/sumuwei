/**
 * Lv4.5 / `P2`+`P3` —— **呼唤覆盖率探针**（用真实 ASR 读数算，不靠眼看）。
 *
 * ============================================================================
 *  它回答的问题（用户提出的现实难题）
 * ============================================================================
 * "语音识别不保证认对'苏沐薇'" —— 那么**判据到底覆盖了多少种真实读法**？
 *
 * ```text
 * 输入：一份**真实语音**的 ASR 批量读数（`postlv2-partial-probe.py --batch-out`）
 *       —— 即"用生产在用的那一档流式识别器念她的名字，它到底吐出了什么"
 * 判据：`detectFastSignal`（与线上完全同一个函数）
 * 输出：逐样本命中/未命中 + 覆盖率
 * ```
 *
 * ⚠️ 它**不**证明"真人也一定命中"：语料是**机器合成**的普通话（用户 2026-10-04
 *    明确"就按普通话来"）。它证明的是"**在真实 ASR 的真实读音上**，判据覆盖到哪"。
 *
 * 用法： `npx tsx scripts/postlv2-wake-coverage.ts <batch.json>`
 */

export {}

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { detectFastSignal } from '../src/kernel/app/bridge/fast-signal.ts'
import { WAKE_NAME_TABLE_PROVENANCE } from '../src/kernel/app/bridge/wake-name-table.ts'

interface BatchSample {
  wav: string
  streaming?: { final?: string; lastPartialText?: string }
  offline?: { final?: string }
}

const path = resolve(process.argv[2] ?? 'artifacts/post-lv2/local/wake-corpus-20261004/offline-batch.json')
const batch = JSON.parse(readFileSync(path, 'utf8')) as { samples?: BatchSample[] }
const samples = batch.samples ?? []
if (samples.length === 0) {
  /* ⚠️ 计数型自检：0 份样本时"0 未命中"与"全部命中"长得一样 */
  console.error('MEASUREMENT INVALID：这份批量读数里一份样本都没有')
  process.exit(1)
}

const rows = samples.map((sample) => {
  const streaming = String(sample.streaming?.final ?? sample.streaming?.lastPartialText ?? '')
  const offline = String(sample.offline?.final ?? '')
  const streamingHit = detectFastSignal({ text: streaming })
  const offlineHit = detectFastSignal({ text: offline })
  return {
    wav: sample.wav,
    streaming,
    streamingKind: streamingHit.kind,
    streamingCode: streamingHit.code,
    offline,
    offlineKind: offlineHit.kind,
    offlineCode: offlineHit.code,
  }
})

const streamingHits = rows.filter((row) => row.streamingKind === 'wake').length
const offlineHits = rows.filter((row) => row.offlineKind === 'wake').length
/**
 * 未命中要**分类**，不许只报一个数。
 *
 * ⚠️ 已知且**刻意**的那一类：**两字名**（"沐薇"）只接受**精确同音类** ——
 *    因为放宽它会让「木卫二」「素未谋面」变成呼唤（实测过）。于是当识别器把
 *    单独两声听成「莫薇」（莫 = `m o`，不是 `m u`）时，它**故意**不命中。
 *    把这一类与"判据漏了"混在一起，就再也看不出哪个是设计、哪个是缺陷。
 */
const classifyMiss = (row: { streaming: string; offline: string }): string => {
  /* 两字形态的"YouTube"判法：看**这一列**的汉字数，而不是固定看 streaming */
  const ascii = (text: string): number => text.replace(/[^\u4e00-\u9fa5]/g, '').length
  const shortest = Math.min(ascii(row.streaming), ascii(row.offline))
  return shortest <= 2 ? 'two_character_form_is_deliberately_exact' : 'judgement_gap'
}
const misses = [
  ...rows
    .filter((row) => row.streamingKind !== 'wake')
    .map((row) => ({ path: 'streaming', wav: row.wav, text: row.streaming, reason: classifyMiss(row) })),
  /*
   * ⚠️ 正式（离线）识别那一列**也要报未命中**：它在线上不参与呼唤判定，
   *    但"她收到的用户原话"就是它 —— 若它把名字听成别的字，那一轮对话本身就跑偏了。
   *    （第一版只统计了 streaming 一列 ⇒ 真正的未命中被漏报成 `judgementGaps: 0`。）
   */
  ...rows
    .filter((row) => row.offlineKind !== 'wake')
    .map((row) => ({ path: 'offline', wav: row.wav, text: row.offline, reason: classifyMiss(row) })),
]
const reading = {
  probe: 'Lv4.5 wake-name coverage over real ASR readings (Mandarin)',
  batch: path.split(/[\\/]/).pop(),
  nameTable: {
    source: WAKE_NAME_TABLE_PROVENANCE.lexicon,
    sha256: WAKE_NAME_TABLE_PROVENANCE.sha256,
  },
  samples: rows.length,
  streaming: { hits: streamingHits, coverage: Number((streamingHits / rows.length).toFixed(3)) },
  /** 正式（离线）识别那一半：呼唤判定**不**走它，但读数一起报出来 */
  offline: { hits: offlineHits, coverage: Number((offlineHits / rows.length).toFixed(3)) },
  rows,
  misses,
  /** ⚠️ 只有"判据漏了"才算失败；"刻意不收"的那一类如实报、不判失败 */
  judgementGaps: misses.filter((item) => item.reason === 'judgement_gap').length,
  notClaimed: [
    '语料是**机器合成**的普通话，不是真人麦克风：它证明判据在真实 ASR 读数上的覆盖，不证明用户体验',
    '只在**普通话**范围内（用户 2026-10-04 明确「就按普通话来」）：方言/口音不在主张内',
    '8 份样本不足以给出覆盖率置信区间 —— 它是"已知读法都被覆盖"的证据，不是"覆盖率 = 100%"的证明',
    '呼唤判定走的是 partial（流式），这里量的是该路的 final（极限情形）；partial 只会更早、更不完整',
  ],
}
console.log(JSON.stringify(reading, null, 2))
process.exit(reading.judgementGaps === 0 ? 0 : 1)
