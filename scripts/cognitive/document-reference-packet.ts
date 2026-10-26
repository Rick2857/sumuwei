/**
 * 参照复核包生成器（2026-10-23 · P2.1 第四批 · 开发工具）
 *
 * ⚠️ 它把**冻结的页面渲染图按单元裁出来**，排成一份可逐条核对的材料。
 *    裁剪位置来自 PDF 文本层坐标（**只是导航**）；**判定必须由人看图**。
 * ⚠️ 输出落在 `artifacts/`（不入库）：它是**复核材料**，不是金标准。
 *
 * 用法：tsx scripts/cognitive/document-reference-packet.ts <crop-index.json> <out.md>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const indexPath = resolve(process.argv[2] ?? 'artifacts/cognitive/local/p21-batch4-20261023/ref-crops/crop-index.json')
const outPath = resolve(process.argv[3] ?? 'artifacts/cognitive/local/p21-batch4-20261023/Reference-Review.md')
const referencesPath = 'evals/world-model-pilot/document-reference-v3.json'
const references = JSON.parse(readFileSync(referencesPath, 'utf8')) as {
  version: string
  review: { method: string; humanReview: string; scope: string }
  normalization: string
  documents: Array<{ id: string; file: string; sha256: string; units: Array<{ id: string; page: number; region: string; kind: string; needles: string[] }> }>
  developmentCorrections: Array<{ unit: string; from: string; to: string; reason: string }>
}
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Array<{
  document: string; unit: string; page: number; region: string; kind: string
  needles: string[]; render: string; located: boolean; locatedNeedle: string | null; crop: string | null
}>

const cropRoot = indexPath.replace(/[/\\][^/\\]+$/, '').replace(/\\/g, '/')
const lines: string[] = []
lines.push('# P2.1 参照复核包（参照 v2 · 19 个单元）')
lines.push('')
lines.push('状态：**代理基于页面图像标注；真人复核 PENDING**。这是**开发期参照**，')
lines.push('不是完整语义金标准、不是独立留出、不是收益评价。')
lines.push('')
lines.push('## 怎么用这份材料')
lines.push('')
lines.push('每个单元给一张**从冻结页面渲染图裁出的行带**（2×放大）。请逐条核对：')
lines.push('')
lines.push('1. 这段文字**确实印在这一页上**（不是标注员看错、不是从别处抄来的）；')
lines.push('2. 文字内容与下面列出的**锚点短语**一致（允许 PDF 换行造成的断字）；')
lines.push('3. 表格行单元的**同一行**确实对应同一组单元格（不是跨行拼出来的）。')
lines.push('')
lines.push('发现不一致 ⇒ 请直接写出"单元 id → 正确的文字/页码"，不要只说"有一条不对"。')
lines.push('')
lines.push(`- 参照版本：\`${references.version}\` · 归一化：\`${references.normalization}\``)
lines.push(`- 标注方法：\`${references.review.method}\` · 真人复核：**${references.review.humanReview}**`)
lines.push('- 范围声明：' + references.review.scope)
lines.push('')
for (const document of references.documents) {
  lines.push(`## ${document.id}`)
  lines.push('')
  lines.push(`文件 \`${document.file}\` · SHA-256 \`${document.sha256}\``)
  lines.push('')
  for (const unit of document.units) {
    const entry = index.find(item => item.document === document.id && item.unit === unit.id)
    lines.push(`### ${unit.id}`)
    lines.push('')
    lines.push(`页 ${unit.page} / ${unit.region} / ${unit.kind} · 锚点：${unit.needles.map(needle => `\`${needle}\``).join(' ｜ ')}`)
    if (entry?.crop) {
      lines.push('')
      lines.push(`![${unit.id}](<${cropRoot}/${entry.crop}>)`)
      if (!entry.located) lines.push('')
      lines.push('')
      lines.push(`_裁剪定位：${entry.locatedNeedle ?? '未定位（整页图）'}_`)
    }
    lines.push('')
    lines.push('- [ ] 图上确有该文字，且与锚点一致')
    lines.push('- [ ] 该单元的页码与区域标注正确')
    lines.push('')
  }
}
lines.push('## v2 的标注修正（复核时一并看）')
lines.push('')
for (const correction of references.developmentCorrections) {
  lines.push(`- \`${correction.unit}\`：${correction.from} → ${correction.to}（${correction.reason}）`)
}
lines.push('')
lines.push('## 复核结论（由人填写）')
lines.push('')
lines.push('- 通过单元数：____ / 19')
lines.push('- 需要修正的单元：____（逐条写明正确内容）')
lines.push('- 复核人：____ · 日期：____')
lines.push('')
writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8')
console.log(`packet -> ${outPath} (${String(index.length)} units)`)
