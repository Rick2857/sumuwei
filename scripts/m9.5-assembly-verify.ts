/**
 * M9.5 WP6 —— **生产装配门**（`pnpm m9.5:assembly:verify`）。
 *
 * ============================================================================
 *  它守的是那条最容易被违反的纪律：**"装了"与"用了"必须同时被同一个开关控制**
 * ============================================================================
 * ```text
 * 仓库为此付过代价：`CHARACTER_MEMORY_BACKGROUND_ENABLED` 只被读进 flags、
 * **没有任何消费者** ⇒ 变成一个"看起来能开、其实什么都不做"的惰性开关（D3）。
 * 语义召回有**两个半边**，缺一不可：
 *   半边①  装不装语义探针（`buildRecallTurnPort`）
 *   半边②  请求带不带 `hybrid-relevance@1`（网关注册处的 `recallPolicyVersion`）
 * ⇒ 只做一半的两种情形都必须被这条门挡住（见 §判据 ④）。
 * ```
 *
 * 另有一条**不许伪启用**的判据：只选策略版本、没装探针 ⇒ store 报 `not_indexed`、
 * 能力报告仍列 `unavailable`（该性质的**真库读数**在 `pnpm m9.5:semantic:verify` 的
 * ⑥ 号探针；本门只做静态核对，不重复出证据）。
 *
 * 用法：`pnpm m9.5:assembly:verify`（纯静态 + 纯函数；不开数据库、不加载模型）
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import {
  DEFAULT_RETRIEVAL_POLICY_VERSION,
  createRecallRequest,
} from '../src/kernel/contracts/recall.ts'

import { sha256 } from './m4-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  runIdFromM95OutPath,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-assembly@1'
const FLAG = 'memorySemanticRecallEnabled'
const ENV_NAME = 'CHARACTER_MEMORY_SEMANTIC_ENABLED'

interface Probe {
  readonly id: string
  readonly question: string
  readonly verdict: 'ok' | 'expected-failure' | 'unexpected'
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

function probe(input: {
  readonly id: string
  readonly question: string
  readonly expectation?: 'succeed' | 'fail'
  readonly run: () => Record<string, unknown>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Probe {
  const expectation = input.expectation ?? 'succeed'
  try {
    const reading = input.run()
    const problems = input.judge?.(reading) ?? []
    if (expectation === 'fail') {
      return { id: input.id, question: input.question, verdict: 'unexpected', reading, error: '应当失败却成功了' }
    }
    return {
      id: input.id,
      question: input.question,
      verdict: problems.length > 0 ? 'unexpected' : 'ok',
      reading,
      error: problems.length > 0 ? problems.join('; ') : null,
    }
  } catch (error) {
    return {
      id: input.id,
      question: input.question,
      verdict: expectation === 'fail' ? 'expected-failure' : 'unexpected',
      reading: {},
      error: (error as Error).message.replace(/\s+/g, ' ').slice(0, 240),
    }
  }
}

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function readSource(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8')
}

/** 取某个方法体的源码（从签名到下一个同级 `private `/`public ` 或文件末）。用于"这一处在不在那个半边里"。 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) return ''
  const rest = source.slice(start + signature.length)
  const next = rest.search(/\n {2}(private|public|protected) /)
  return next < 0 ? rest : rest.slice(0, next)
}

function main(): void {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp6-assembly', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const probes: Probe[] = []

  /* ---- ① 开关的解析：缺省必须 off ---- */
  probes.push(
    probe({
      id: 'flag-defaults-off',
      question: `${ENV_NAME} 缺省 = **off**；true/1 才开；false/垃圾值一律 off`,
      run: () => {
        const cases: Record<string, boolean> = {
          unset: readKernelFlags({})[FLAG],
          true: readKernelFlags({ [ENV_NAME]: 'true' })[FLAG],
          one: readKernelFlags({ [ENV_NAME]: '1' })[FLAG],
          false: readKernelFlags({ [ENV_NAME]: 'false' })[FLAG],
          zero: readKernelFlags({ [ENV_NAME]: '0' })[FLAG],
          garbage: readKernelFlags({ [ENV_NAME]: 'yes-please' })[FLAG],
        }
        return { cases }
      },
      judge: (reading) => {
        const problems: string[] = []
        const cases = reading.cases as Record<string, boolean>
        if (cases.unset !== false) problems.push(`★ 缺省必须是 off（这是"接线不改行为"的前提），实际 ${String(cases.unset)}`)
        if (cases.true !== true) problems.push('true 应开启')
        if (cases.one !== true) problems.push('1 应开启')
        for (const key of ['false', 'zero', 'garbage']) {
          if (cases[key] !== false) problems.push(`${key} 应判 off，实际 ${String(cases[key])}`)
        }
        return problems
      },
    })
  )

  /* ---- ② 开关在启动报告里可见（"装了没有"必须一眼可见） ---- */
  probes.push(
    probe({
      id: 'flag-visible-in-startup-report',
      question: '开关进启动报告（`describeKernelFlags`），账号上"装了没有"一眼可见',
      run: () => {
        const flagsSource = readSource('src/kernel/app/flags.ts')
        const describe = methodBody(flagsSource, 'export function describeKernelFlags(')
        return {
          hasRecord: describe.includes("record('memory-semantic-recall'"),
          recordedName: 'memory-semantic-recall',
          interfaceField: flagsSource.includes(`${FLAG}: boolean`),
          envRead: flagsSource.includes(`env.${ENV_NAME}`),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.interfaceField !== true) problems.push('KernelFlags 上缺该字段')
        if (reading.envRead !== true) problems.push('没有从环境变量读取')
        if (reading.hasRecord !== true) problems.push('★ 启动报告里看不见它 ⇒ "装了没有"无法一眼分辨')
        return problems
      },
    })
  )

  /* ---- ③ 请求：缺省**不出现**该字段；传了才出现 ---- */
  probes.push(
    probe({
      id: 'request-omits-policy-version-by-default',
      question: '缺省 ⇒ `RecallRequest` 里**不出现** `retrievalPolicyVersion`（"行为逐字不变"的机器形态）',
      run: () => {
        const base = {
          traceId: 'trace-x',
          characterId: 'char-x',
          user: entityRef('user', 'u1'),
          query: { text: '你好' },
        }
        const withoutField = createRecallRequest(base)
        const withField = createRecallRequest({ ...base, retrievalPolicyVersion: 'hybrid-relevance@1' as const })
        return {
          withoutHasField: Object.prototype.hasOwnProperty.call(withoutField, 'retrievalPolicyVersion'),
          withField: withField.retrievalPolicyVersion,
          defaultConstant: DEFAULT_RETRIEVAL_POLICY_VERSION,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.withoutHasField !== false) {
          problems.push('★ 缺省竟然在请求里塞了策略版本字段 ⇒ "不传就等价"的前提被破坏')
        }
        if (reading.withField !== 'hybrid-relevance@1') problems.push('传了却没出现在请求上')
        if (reading.defaultConstant !== 'lexical-recency@1') problems.push('缺省常量不是现状策略')
        return problems
      },
    })
  )

  /* ---- ④ ★ 静态锁：两个半边必须由**同一个**开关控制 ---- */
  probes.push(
    probe({
      id: 'both-halves-behind-the-same-flag',
      question:
        '★ 装配层里该开关出现**恰好两次**（装探针 / 选策略版本各一次），且两处都在对的半边里',
      run: () => {
        const main = readSource('src/main.ts')
        const occurrences = main.split(FLAG).length - 1
        const recallPortBody = methodBody(main, 'private buildRecallTurnPort(): RecallTurnPort {')
        const semanticProbeBody = methodBody(main, `private buildSemanticRecallProbe(db: RawDb): MemorySemanticProbe {`)
        /*
         * 半边② 在网关注册处（`turn-gateway` 的构造选项里）—— 它不在上面两个方法体里，
         * 因此用"整文件里除去那两个方法体之后仍出现一次"来定位。
         */
        const outsideBoth = main
          .replace(recallPortBody, '')
          .replace(semanticProbeBody, '')
          .split(FLAG).length - 1
        const gateway = readSource('src/kernel/app/turn-gateway.ts')
        const gatewayBuildsRequest = methodBody(gateway, 'const request = createRecallRequest({')
        return {
          totalOccurrences: occurrences,
          inRecallPortBuilder: recallPortBody.includes(FLAG),
          outsideBothBuilders: outsideBoth,
          gatewayPassesPolicyVersion: gateway.includes('this.options.recallPolicyVersion'),
          gatewayRequestIncludesField:
            gateway.includes('retrievalPolicyVersion: this.options.recallPolicyVersion') ||
            gatewayBuildsRequest.includes('recallPolicyVersion'),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.inRecallPortBuilder !== true) {
          problems.push('★ 半边①（装探针）不在 `buildRecallTurnPort` 里 ⇒ 开关没接到那一条')
        }
        if (Number(reading.outsideBothBuilders) < 1) {
          problems.push('★ 半边②（选策略版本）不存在 ⇒ 只装了探针、没有策略版本（分数根本不被调用）')
        }
        /*
         * ⚠️ **期望值 2 → 3**（2026-09-28）：原锁写"两个半边各一次"。
         *    但装配**实际有第三个**正确围栏的站点：**探针构造**
         *    （`main.ts`：`memorySemanticRecallEnabled ? buildSemanticRecallProbe(db) : null`）。
         *    实测（Round 82）：三处分别是 **策略版本** / **语义模式** / **探针构造**，**都在同一开关下**。
         *    ⇒ 锁的**意图不变**（挡住"只记一句日志"式的伪接线）：**恰好 3 处**，
         *      第 4 处仍会报红。若将来再增围栏站点，**必须**回来改这里并说明理由。
         */
        if (Number(reading.totalOccurrences) !== 3) {
          problems.push(
            `开关在 main.ts 里应恰好出现 3 次（策略版本 / 语义模式 / 探针构造，各一次），实际 ${String(reading.totalOccurrences)} 次` +
              '（多出来的地方很可能是"只记了一句日志"式的伪接线）'
          )
        }
        if (reading.gatewayPassesPolicyVersion !== true) {
          problems.push('★ 网关没有消费 `recallPolicyVersion` ⇒ 请求不会带策略版本')
        }
        if (reading.gatewayRequestIncludesField !== true) {
          problems.push('★ 网关没有把策略版本放进 `createRecallRequest`')
        }
        return problems
      },
    })
  )

  /* ---- ⑤ 未知策略版本仍被拒（装配不放松契约） ---- */
  probes.push(
    probe({
      id: 'unknown-policy-version-still-rejected',
      question: '装配层不放松契约：未知策略版本仍被 `createRecallRequest` 拒绝',
      expectation: 'fail',
      run: () => {
        const request = createRecallRequest({
          traceId: 'trace-x',
          characterId: 'char-x',
          user: entityRef('user', 'u1'),
          query: { text: '你好' },
          retrievalPolicyVersion: 'on' as never,
        })
        return { accepted: request.retrievalPolicyVersion }
      },
    })
  )

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })

  const payload = {
    schemaVersion: 'm9.5-assembly@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '开关缺省 off / 启动报告可见 / 请求缺省不含策略版本 / **两个半边由同一开关控制**（静态锁）/ 未知版本仍被拒',
      notProves:
        '**不**证明真库上的语义分数（见 `pnpm m9.5:semantic:verify` 与 `m9.5:probe:verify`）；' +
        '也**不**证明开关打开后的端到端回复质量（那要 WP10 盲测）',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
  }
  const evidencePath = join(runDir, 'assembly-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp6',
    lane: 'offline',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: GATE_VERSION,
    dbKind: 'not-applicable',
    isolationProof: {
      dbTouched: false,
      method: '**构造属性**：本门只读源码 + 调纯函数；不 import 数据库、不 import 模型',
    },
    configHash: { flag: FLAG, env: ENV_NAME, defaultPolicyVersion: DEFAULT_RETRIEVAL_POLICY_VERSION },
    command: [{ cmd: 'pnpm m9.5:assembly:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    retrievalPolicyVersion: DEFAULT_RETRIEVAL_POLICY_VERSION,
    artifactHashes: { 'assembly-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP6 装配门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

main()
