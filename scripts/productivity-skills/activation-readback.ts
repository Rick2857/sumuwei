/**
 * 第二批实用能力的**激活读回**（`pnpm productivity:activation:readback`）。
 *
 * ============================================================================
 *  它只做一件事：把**实际生效**的开关读回来
 * ============================================================================
 * 与 `scripts/m9-activation-readback.ts` 同一条纪律：**"改了 .env"不等于"它生效了"**。
 * 一个写错名字的键、一个被后面的行覆盖的键，在人工 `cat .env` 时看起来完全正常。
 *
 * ⚠️ 它**不打开数据库**、**不发起任何动作**、**不写任何东西** ——
 *    只调 `readKernelFlags()`（读 env → 得到与启动时**同一个**函数算出的取值）。
 * ⚠️ 输出**只含开关与闭集配置**（额度、上限、地址），**不含任何凭据**。
 *
 * ```bash
 * pnpm productivity:activation:readback
 * ```
 */

import 'dotenv/config'

import { describeKernelFlags, readKernelFlags } from '../../src/kernel/app/flags.ts'

const flags = readKernelFlags()

const reading = {
  schemaVersion: 'productivity-skills-activation-readback@1',
  observedAt: new Date().toISOString(),
  /** 第二批七个新开关的**实际生效值** */
  switches: {
    localFileReadEnabled: flags.localFileReadEnabled,
    localFileWriteEnabled: flags.localFileWriteEnabled,
    taskAutonomyEnabled: flags.taskAutonomyEnabled,
    weatherEnabled: flags.weatherEnabled,
    officeGenerateEnabled: flags.officeGenerateEnabled,
    newsReadEnabled: flags.newsReadEnabled,
    browserEnabled: flags.browserEnabled,
  },
  /** 相关的既有配置（缺省值也一并读出来：它们决定"这一档到底开了没有"） */
  config: {
    turnContentTokens: flags.turnContentTokens,
    localFileRecoveryRoot: flags.localFileRecoveryRoot,
    taskMaxActions: flags.taskMaxActions,
    taskMaxPlans: flags.taskMaxPlans,
    taskDeadlineMs: flags.taskDeadlineMs,
    browserSidecarUrl: flags.browserSidecarUrl,
    actionMaxRiskLevel: flags.actionMaxRiskLevel,
  },
  /** 旧沙箱能力是否仍然在原位（"关闭新域不会动旧能力"的读回） */
  legacySandboxUnchanged: {
    actionEnabled: flags.actionEnabled,
    actionSandboxRoot: flags.actionSandboxRoot,
  },
  describe: describeKernelFlags(flags),
}

process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`)
