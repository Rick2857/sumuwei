/**
 * M6.1 —— **命令面的纯判定**（不含 CLI 外壳）。
 *
 * 与 `m6-command-surface.ts` 同一个形状与同一个理由：这些判定必须能被
 * `m6.1:test` **穷举断言**，而一个"进口即执行"的 CLI 文件被 import 时会在
 * 模块顶层 `process.exit` —— 组件门会死在 import 阶段，且死因与它要测的东西无关。
 *
 * 本文件**不读 `process.argv`、不读 `process.env`、不 spawn、不 exit、不碰文件系统**。
 *
 * ---------------------------------------------------------------------------
 *  三条入口纪律（每一条都对应一个**真实的**最坏失败模式）
 * ---------------------------------------------------------------------------
 * ```text
 *  ① Live 必须显式给套件          —— 默认一口气跑三条长轨迹是真实开销
 *  ② Live 必须经测试包装器        —— 否则"以为在跑测试、其实在烧 .env 里的原 Key"
 *  ③ 未实现的套件必须具名拒绝      —— 空跑 PASS 比跑失败更坏（TD-14）
 *  ④ 汇总必须由**显式 manifest** 选证据 —— 按"最新 PASS"挑证据会让旧绿冒充本次结论（TD-04②）
 * ```
 */

import { TEST_MODEL_WRAPPER_MARKER } from './m6-command-surface.ts'

/** 与 `m6-command-surface.ts` **同源**，避免第二个字面量悄悄长出来。 */
export { TEST_MODEL_WRAPPER_MARKER }

// ---------------------------------------------------------------------------
// Live 套件（`m6.1:live`）
// ---------------------------------------------------------------------------

/**
 * Live 套件登记表。
 *
 * ⚠️ **short 自 M6.1 WP5 起、long 自 M6.1 WP6 起是 `implemented: true`**
 *    （运行器分别在 `scripts/m6.1-live-short.ts` / `scripts/m6.1-live-long.ts`，
 *    由 `m6.1-live.ts` 转交）。
 *    ⇒ 未实现的套件仍会**具名拒绝**（TD-14：空跑 PASS 比跑失败更坏）。
 */
export const M6_1_LIVE_SUITES = [
  { name: 'short', label: '真实模型短场景（计划书 §5 的合成多轮）', implemented: true, plannedIn: 'WP5' },
  { name: 'long', label: '冻结长对话套件（3 条独立的 500 轮轨迹）', implemented: true, plannedIn: 'WP6' },
] as const

export type M6_1LiveSuiteName = (typeof M6_1_LIVE_SUITES)[number]['name']

export type M6_1LiveGuardDecision =
  | { readonly ok: false; readonly code: string; readonly message: string }
  | { readonly ok: true; readonly suite: M6_1LiveSuiteName }

/**
 * 四条判定，顺序刻意（前三条是**入口纪律**，与套件内容无关 ⇒ 不该等到套件实现后才生效）。
 */
export function evaluateM6_1LiveGuard(input: {
  readonly argv: readonly string[]
  readonly wrapperMarkerPresent: boolean
}): M6_1LiveGuardDecision {
  const index = input.argv.indexOf('--suite')
  const value = index === -1 ? undefined : input.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    return {
      ok: false,
      code: 'suite_required',
      message:
        '必须显式给出 --suite <' +
        `${M6_1_LIVE_SUITES.map((entry) => entry.name).join('|')}>：` +
        '默认一口气跑冷启动的真实模型调用是一次真实开销',
    }
  }
  if (!M6_1_LIVE_SUITES.some((entry) => entry.name === value)) {
    return {
      ok: false,
      code: 'suite_unknown',
      message: `未知套件 ${value}（可选：${M6_1_LIVE_SUITES.map((entry) => entry.name).join('|')}）`,
    }
  }
  if (!input.wrapperMarkerPresent) {
    return {
      ok: false,
      code: 'wrapper_required',
      message:
        `必须经测试包装器运行（pnpm with-test-model pnpm m6.1:live --suite ${value}）：` +
        `缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 拒绝，**绝不**回落到 .env 的原 key`,
    }
  }
  const suite = M6_1_LIVE_SUITES.find((entry) => entry.name === value)
  if (suite === undefined || !suite.implemented) {
    return {
      ok: false,
      code: 'suite_not_implemented',
      message: `套件 ${value} 尚未实现（归属 ${suite?.plannedIn ?? '未登记'}）—— 如实拒绝，不假装跑过`,
    }
  }
  return { ok: true, suite: value as M6_1LiveSuiteName }
}

// ---------------------------------------------------------------------------
// 汇总的证据选择（`m6.1:gates`）
// ---------------------------------------------------------------------------

export type ManifestSelection =
  | { readonly ok: true; readonly manifests: readonly string[] }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * 解析 `--manifest <path>`（可重复）。
 *
 * ```text
 *   没有 --manifest        ⇒ 拒绝（汇总必须由显式清单选证据）
 *   --all-runs / --latest  ⇒ **具名拒绝** —— 那正是 TD-04② 说的"按最新 PASS 挑证据"
 *   路径为空或以 -- 开头     ⇒ 拒绝
 * ```
 *
 * 允许重复是**有意的**：WP0 与 WP1 各自有自己的 runId 目录（TD-04① 要求目录唯一），
 * 里程碑级汇总因此需要同时引用两份清单。它**不是**"多找几个来源碰运气" ——
 * 每一份清单都必须自己校验通过（字段 / 自摘要 / 每条证据的 sha256）。
 */
export function resolveManifestSelection(argv: readonly string[]): ManifestSelection {
  const refused = ['--all-runs', '--latest', '--newest']
  const hit = refused.find((flag) => argv.includes(flag))
  if (hit !== undefined) {
    return {
      ok: false,
      code: 'evidence_selection_refused',
      message:
        `${hit} 被具名拒绝：按"最新 / 全部"挑证据会让旧绿冒充本次结论（TD-04②）。` +
        '汇总只接受显式 --manifest <path>。',
    }
  }

  const manifests: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--manifest') continue
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      return {
        ok: false,
        code: 'manifest_arg_missing_value',
        message: `--manifest 后面必须有路径（收到 ${JSON.stringify(value)}）`,
      }
    }
    manifests.push(value)
  }
  if (manifests.length === 0) {
    return {
      ok: false,
      code: 'manifest_required',
      message:
        '必须显式给出 --manifest <path>（可重复）：汇总只读**该清单引用**的证据，' +
        '缺文件 = NOT RUN，绝不按"最新 PASS"选。',
    }
  }
  return { ok: true, manifests }
}
