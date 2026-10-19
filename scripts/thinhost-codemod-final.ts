// 一次性工具：删包前清掉**最后 5 处**上游引用（W4-b）。
// 这些形态 codemod 没覆盖到（逐个形态列举在注释里），改完由 typecheck 兜底。
import { readFileSync, writeFileSync } from 'node:fs'

/** [文件, 原文本, 新文本, 为什么 codemod 没覆盖] */
const EDITS = [
  [
    'scripts/m4-harness.ts',
    "import { stringToUuid } from '@elizaos/core'",
    "import { stringToUuid } from '../src/kernel/contracts/uuid.ts'",
    '值导入（构造字符串），B 簇 codemod 当时把本文件列进了 --skip（别的人在改）',
  ],
  [
    'scripts/thinhost-initdb-verify.ts',
    "import { stringToUuid } from '@elizaos/core'",
    "import { stringToUuid } from '../src/kernel/contracts/uuid.ts'",
    '同上',
  ],
  [
    'scripts/test-persist-write.ts',
    "const userId = (await import('@elizaos/core')).stringToUuid(",
    "const { stringToUuid } = await import('../src/kernel/contracts/uuid.ts')\nconst userId = stringToUuid(",
    '**属性访问**而非解构 ⇒ D 簇 codemod 只处理解构',
  ],
  [
    'scripts/u1-new-user-relationship-verify.ts',
    "type Character = import('@elizaos/core').Character",
    "type Character = import('../src/infrastructure/runtime/eliza-types.ts').Character",
    '**内联 import() 类型**（`import("…").Character`）⇒ 不是 ImportDeclaration，两批 codemod 都不认',
  ],
  [
    'scripts/thinhost-bootstrap-baseline.ts',
    "  const { AgentRuntime } = await import('@elizaos/core')\n  const { default: sqlPlugin } = await import('@elizaos/plugin-sql')",
    "  const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')",
    '⚠️ 这是**别的会话**的未跟踪新文件。本仓 typecheck 必须 0 错 ⇒ 只能一并改；改动仅限这两行 import。',
  ],
]

for (const [file, from, to, why] of EDITS) {
  const src = readFileSync(file, 'utf8')
  if (!src.includes(from)) {
    console.log(`  SKIP ${file}（形态已变，可能是别处已改）`)
    continue
  }
  writeFileSync(file, src.replace(from, to), 'utf8')
  console.log(`  改 ${file}  ← ${why}`)
}
