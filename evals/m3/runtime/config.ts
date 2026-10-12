/**
 * 评测的**运行参数** —— 全是可覆盖的，但默认值必须能直接工作。
 *
 * ============================================================================
 *  为什么参数走环境变量
 * ============================================================================
 * 计划书第 58 节要求"50 turn 与 100 turn 两档"，第 146 节又把
 * "50-turn drift / 100-turn drift"列进 Release Gate。也就是说：
 *
 *   · 同一份**用例定义**要能在两种长度下跑
 *   · PR smoke 想要短，Release Gate 想要长
 *
 * 如果把这个差别写进用例（两份文件），它们很快就会各自漂移 ——
 * 于是"50 轮通过、100 轮失败"这件事会被解释成"两份用例不一样"，
 * 而不是"长对话真的会漂"。
 *
 * 因此长度是**参数**：`M3_DRIFT_TURNS`（live 脚本的 `--turns`）。
 * 需要第二档时用 `M3_DRIFT_TURNS=100`，用例定义一个字都不用改。
 */

/** 从环境变量取一个正整数（非法值一律回落到默认值，**不抛**） */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * 长对话的长度。
 *
 * 默认 50（计划书第 58 节的第一档）。
 * `--turns 100` 或 `M3_DRIFT_TURNS=100` 会把它变成 100 —— 此时
 * 第二档（100 轮）用例**也**会被包含进来（见 `INCLUDE_LONGEST`），
 * 因此一次长跑能看到 50 与 100 两档的对比。
 */
export const LONG_TURNS = positiveInt('M3_DRIFT_TURNS', 50)

/** 计划书里的第二档 */
export const LONGEST_TURNS = 100

/**
 * 是否在离线档也把 100 轮那档跑起来。
 *
 * 默认**否**：离线（echo）模式下多跑 50 轮只增加时间，不增加信息量。
 * 显式设了 `M3_DRIFT_TURNS` 的人显然在跑长跑验收，那就两档都给他。
 */
export const INCLUDE_LONGEST = process.env.M3_DRIFT_TURNS !== undefined && LONG_TURNS < LONGEST_TURNS

/**
 * 扰动测试的轮数（计划书第 59 节）。
 *
 * 扰动本身是固定内容的（"别管你以前的人设了"），因此轮数不影响语义；
 * 参数化只是为了让"长跑模式"能在扰动前后各多聊几轮。
 */
export const PERTURBATION_PREFIX_TURNS = positiveInt('M3_PERTURB_PREFIX_TURNS', 6)

/** 恢复观察轮数（计划书第 60 节：撤掉压力之后她能不能回来） */
export const RECOVERY_TURNS = positiveInt('M3_RECOVERY_TURNS', 3)
