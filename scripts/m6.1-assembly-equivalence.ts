/**
 * M6.1 WP4 / ADR-055 `D-55d`：「**生产装配 ≡ 受测装配**」的**静态**等价判据。
 *
 * ============================================================================
 *  它防的是哪一种缺陷（真发生过）
 * ============================================================================
 * ```text
 * 旧 `evals/m3/runtime/host.ts` 的 `rebindConversation` **自己 new 了一个 TurnGateway**，
 * 只接了 ConversationRecorder + TurnGateway —— **没有**注入 memoryWriter / recall /
 * rollup / actionWriter。于是"门里测的那条路"与"用户走的那条路"从那一刻起就是两条路，
 * 而所有门都是绿的（M6.1 WP3 §2.2 的实测结论）。
 * ```
 * ⇒ 判据因此**不是**"测了什么能力"，而是**"测的是不是生产那一份装配"**。
 *
 * ============================================================================
 *  为什么是**纯函数 + 可注入的源码文本**
 * ============================================================================
 * ```text
 * · 纯函数 ⇒ 能做**负控**：把源码文本改坏（拿掉一个端口 / 拿掉一个开关消费 /
 *   伪造一个自建网关），判据**必须**报红，而且必须报出**预期的那个原因**。
 * · 只读源码文本 ⇒ 离线、确定性、不碰数据库、不需要模型。
 * ```
 *
 * ⚠️ 它**只**覆盖"静态接线"这一层（用户 §4.6 ① 的那一半）。用户的 ②③④ 还要：
 *    · **三读数**（端口接没接 / 开关开没开 / 本轮实际入模没有）—— 后两项要跑起来看 trace；
 *    · **Gateway 之外的路径**（意图处理 → 显式写入 → 上下文编译 → 回复守卫 → 完成记录）；
 *    · **负控三缺陷**（端口缺失 / 开关未被消费 / 结果未进入后续链路）—— 本文件覆盖前两类，
 *      第三类（结果没进后续链路）只能在运行期看，不能靠读源码声称。
 *    这些**不许**用本判据冒充已经验过。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface CapabilityWiring {
  readonly capability: string
  /** 生产装配里**必须**出现的端口注入（逐字正则） */
  readonly port: RegExp
  /** 与该端口成对的**开关消费**（没有它 = 端口接了但没人问开关，M4 的 D3 形状） */
  readonly flag?: RegExp
  readonly note: string
}

/**
 * 逐能力的接线清单。
 *
 * ⚠️ **计数型自检**：这张表本身要被判据检查"至少覆盖 5 个能力" ——
 *    否则表被清空时"0 个问题"会显示成"全部合格"（本仓库反复登记的那类损失）。
 */
export const CAPABILITY_WIRINGS: readonly CapabilityWiring[] = [
  {
    capability: 'memoryWriter（显式记忆写入）',
    port: /memoryWriter:\s*this\.buildMemoryWriter\(\)/,
    flag: /memoryExplicitEnabled:\s*this\.flags\.memoryExplicitEnabled/,
    note: '端口决定接没接上，开关决定接上了要不要用 —— 缺一不可（M4 的 D3 就是这么来的）',
  },
  {
    capability: 'recall（召回）',
    port: /recall:\s*this\.buildRecallTurnPort\(\)/,
    flag: /recallEnabled:\s*this\.flags\.recallEnabled/,
    note: '召回是只读的 ⇒ 两个分支（干跑/非干跑）都应注入',
  },
  {
    capability: 'rollup（会话摘要）',
    port: /rollup:\s*this\.buildRollupTurnPort\(\)/,
    note: '摘要额度是 token 预算（`CHARACTER_ROLLUP_TOKENS`），不是布尔开关 ⇒ 只查端口',
  },
  {
    capability: 'actionWriter（动作）',
    port: /actionWriter:\s*this\.buildActionWriter\(\)/,
    flag: /actionEnabled:\s*this\.flags\.actionEnabled/,
    note: '与 memoryWriter 同形：端口 + 开关',
  },
  {
    capability: 'conflict（槽位冲突分析，M6.1 WP4 新增）',
    port: /conflict:\s*\{[\s\S]{0,200}?recordsInCanonicalSlot:/,
    note: 'A（ADR-055 D-55b）接的那条线：生产**必须**注入，否则显式路径不做冲突判定',
  },
  {
    capability: 'replyGuards（回复守卫观测三态，M6.1 WP4 新增）',
    port: /replyGuards,/,
    note:
      'D-55g 接的那条线：四道守卫的返回值必须经 `completeTurn` 带出去，' +
      '否则 trace 里没有 `reply_guard` 那一步 —— 而"守卫没运行"正是修复前那条静默分支',
  },
]

/**
 * 剥掉注释，**只留代码**（字符串字面量原样保留）。
 *
 * ⚠️ 为什么必须剥（第一版在这里吃了假阳性）：`scripts/m6.1-baseline.ts` 的**文档注释里**
 *    引用了反例的名字（"旧 `evals/m3/runtime/host.ts` 的 `rebindConversation`…"），
 *    于是"受测脚本自建网关"那条判据对着**一段说明文字**报了红。
 *    判据必须看**接线**，不能看**提到接线的散文** —— 否则它会把"照实记录缺陷"判成缺陷。
 *
 * 手写状态机（不引依赖）：单引号 / 双引号 / 模板串里的 `//`、`/*` 不算注释起点。
 */
export function stripComments(source: string): string {
  let out = ''
  let i = 0
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  while (i < source.length) {
    const ch = source[i] as string
    const next = source[i + 1]
    if (mode === 'code') {
      if (ch === '/' && next === '/') {
        mode = 'line'
        i += 2
        continue
      }
      if (ch === '/' && next === '*') {
        mode = 'block'
        i += 2
        continue
      }
      if (ch === "'") mode = 'single'
      else if (ch === '"') mode = 'double'
      else if (ch === '`') mode = 'template'
      out += ch
      i += 1
      continue
    }
    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code'
        out += ch
      }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = 'code'
        i += 2
        continue
      }
      // 保留换行，行号不塌（便于人对着报错行号看）
      if (ch === '\n') out += ch
      i += 1
      continue
    }
    // 字符串内部：原样保留，处理转义与结束
    if (ch === '\\') {
      out += ch + (next ?? '')
      i += 2
      continue
    }
    if (
      (mode === 'single' && ch === "'") ||
      (mode === 'double' && ch === '"') ||
      (mode === 'template' && ch === '`')
    ) {
      mode = 'code'
    }
    out += ch
    i += 1
  }
  return out
}

export type AssemblyProblemKind =
  | 'port_missing'
  | 'flag_not_consumed'
  | 'harness_not_production_entry'
  | 'isolation_guard_missing'
  | 'capability_table_empty'

export interface AssemblyProblem {
  readonly capability: string
  readonly kind: AssemblyProblemKind
  readonly detail: string
}

/**
 * 判据本体。
 *
 * `productionSrc` = `src/main.ts`；`harnessSrc` = 受测装配的驱动脚本（本仓库是
 * `scripts/m6.1-baseline.ts`，它**spawn 生产入口**而不是自己搭网关）。
 */
export function checkAssemblyEquivalence(input: {
  readonly productionSrc: string
  readonly harnessSrc: string
}): AssemblyProblem[] {
  const problems: AssemblyProblem[] = []
  /* 只看代码，不看散文（见 `stripComments` 的说明：第一版在这里吃过假阳性） */
  const productionSrc = stripComments(input.productionSrc)
  const harnessSrc = stripComments(input.harnessSrc)

  if (CAPABILITY_WIRINGS.length === 0) {
    problems.push({
      capability: '(整张接线表)',
      kind: 'capability_table_empty',
      detail: '接线表为空 ⇒ "0 个问题"不能当成"全部合格"',
    })
    return problems
  }

  for (const wiring of CAPABILITY_WIRINGS) {
    if (!wiring.port.test(productionSrc)) {
      problems.push({
        capability: wiring.capability,
        kind: 'port_missing',
        detail: `生产装配里找不到端口注入（${String(wiring.port)}）`,
      })
      continue
    }
    if (wiring.flag !== undefined && !wiring.flag.test(productionSrc)) {
      problems.push({
        capability: wiring.capability,
        kind: 'flag_not_consumed',
        detail: `端口注入了，但找不到与之成对的开关消费（${String(wiring.flag)}）`,
      })
    }
  }

  /*
   * ② 受测的那份装配**必须**是生产入口：
   *    · 必须能看到 `src/main.ts`（spawn 它，或 import 它的装配函数）
   *    · **不得**自己 new 网关（那正是旧 M3 host 的形状）
   */
  if (!harnessSrc.includes('src/main.ts')) {
    problems.push({
      capability: '(受测装配)',
      kind: 'harness_not_production_entry',
      detail: '受测脚本里看不到 `src/main.ts` ⇒ 测的可能不是生产装配',
    })
  }
  if (/new TurnGateway\(|rebindConversation/.test(harnessSrc)) {
    problems.push({
      capability: '(受测装配)',
      kind: 'harness_not_production_entry',
      detail: '受测脚本自己搭了网关（`new TurnGateway` / `rebindConversation`）⇒ 与生产是两条路',
    })
  }

  /* ③ 隔离闸必须还在：受测脚本给沙箱、生产入口的护栏读它 */
  if (!harnessSrc.includes('PROJECT_LG_SANDBOX')) {
    problems.push({
      capability: '(隔离)',
      kind: 'isolation_guard_missing',
      detail: '受测脚本没有设置 `PROJECT_LG_SANDBOX` ⇒ 可能指向真实库',
    })
  }
  if (!/PROJECT_LG_SANDBOX\s*===\s*undefined/.test(productionSrc)) {
    problems.push({
      capability: '(隔离)',
      kind: 'isolation_guard_missing',
      detail: '生产入口的 `PROJECT_LG_SANDBOX === undefined` 护栏不见了 ⇒ 沙箱闸失效',
    })
  }

  return problems
}

/** 从仓库根读两份源码文本（判据本身不读文件，方便注入破坏文本做负控）。 */
export function readAssemblySources(root: string): { productionSrc: string; harnessSrc: string } {
  return {
    productionSrc: readFileSync(join(root, 'src', 'main.ts'), 'utf8'),
    harnessSrc: readFileSync(join(root, 'scripts', 'm6.1-baseline.ts'), 'utf8'),
  }
}
