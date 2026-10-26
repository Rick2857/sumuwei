/**
 * 在**隔离测试库**上跑一个门体脚本（2026-10-21 · 认知能力建设计划 P0）
 *
 * ============================================================================
 *  它解决什么
 * ============================================================================
 *  `pnpm gates:pg -- <pnpm 脚本名>` 要求那个名字**已经登记在 package.json**。
 *  而登记它会触发一条**当前环境做不了**的事：
 *  改 `package.json` ⇒ 仿真镜像的依赖层失效 ⇒ **Python venv 层也失效**
 *  ⇒ 需要 **PyPI**（本机容器内**连不上**）⇒ 镜像构建会挂住（实测 35 分钟）。
 *
 *  ⇒ 于是有了这个入口：**直接跑一个脚本路径**，不必改 package.json。
 *    准备阶段与 `gates:pg` **逐条相同**（新建空白库 + 显式迁移 + 身份核对）。
 *
 *  用法：
 *    pnpm serversim:pgtest -- --script scripts/cognitive/world-model-transition-verify.ts
 *    （宿主模式：docker compose exec … simhost pnpm exec tsx scripts/gates/run-pg-script.ts <脚本>）
 * ============================================================================
 */

import { runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'

const args = process.argv.slice(2)
const script = args.find(arg => !arg.startsWith('--'))
if (script === undefined) {
  console.error('用法：pnpm exec tsx scripts/gates/run-pg-script.ts <scripts/门体>.ts')
  process.exit(2)
}

const adminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
if (adminUrl === '') {
  console.error('❌ 需要 LG_SIM_PGTEST_ADMIN_URL（仿真内的专用隔离实例的 admin 连接串）')
  process.exit(2)
}

const label = script.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
console.log(`▸ 在隔离实例上跑：${script}`)
await runPreparedPgGateInInstance(adminUrl, label, script)
console.log(`✅ ${script} 在隔离测试库上通过`)
