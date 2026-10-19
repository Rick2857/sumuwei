/**
 * 跨平台编排 `thinhost:ddl:verify` 的三段。
 *
 * ⚠️ 为什么不用 `&&` 串在 package.json 里：Windows 的 cmd 不支持 `&&` 作为
 *    npm script 的连接符（不同 shell 行为不一致），仓库脚本必须三平台同形。
 *
 * 为什么必须分三段独立进程：`@elizaos/plugin-sql` 的连接池是**进程级单例**，
 * 同一进程里连开两个库会拿到**已关闭**的客户端（`PGlite is closed`）。
 * 详见 scripts/thinhost-ddl-decoupling-verify.ts 文件头。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const gate = join(here, 'thinhost-ddl-decoupling-verify.ts')

const phases = ['build', 'build-reopen', 'reopen'] as const
let failed = 0

for (const phase of phases) {
  console.log(`\n########## phase: ${phase} ##########`)
  const result = spawnSync(
    process.execPath,
    ['--import', './node_modules/tsx/dist/loader.mjs', gate, `--phase=${phase}`],
    { stdio: 'inherit' }
  )
  if (result.status !== 0) {
    console.error(`phase ${phase} 退出码 ${result.status ?? 'null'}`)
    failed += 1
  }
}

if (failed > 0) {
  console.error(`\nthinhost:ddl:verify 失败：${failed}/${phases.length} 段未通过`)
  process.exit(1)
}
console.log(`\nthinhost:ddl:verify 全部 ${phases.length} 段通过`)
