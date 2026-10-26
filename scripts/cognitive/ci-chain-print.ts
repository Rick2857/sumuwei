/** 打印完整 CI 链的展开结果（诊断用）。 */
import { fullCiChain } from './ci-chain.ts'

const chain = fullCiChain(process.argv[2] ?? 'm4.5:ci')
console.log(`链：${process.argv[2] ?? 'm4.5:ci'} · 共 ${String(chain.length)} 道`)
for (const [index, gate] of chain.entries()) {
  console.log(
    `  ${String(index + 1).padStart(2, '0')}  ${gate.touchesDatabase ? 'DB ' : '   '} ${gate.name.padEnd(28)} ${gate.script ?? '(无脚本)'}`
  )
  for (const item of gate.evidence) console.log(`        · ${item}`)
}
