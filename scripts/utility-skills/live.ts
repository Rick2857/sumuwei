/**
 * live —— `--live` 的八轮真模型短链（计划书 §4C）。
 *
 * ============================================================================
 *  它走的是**生产装配本尊**
 * ============================================================================
 * ```text
 * 子进程：node --import tsx src/main.ts "<用户原话>"
 *   · env: PGLITE_DATA_DIR / PROJECT_LG_SANDBOX = 本次运行的**隔离库**
 *          ACTION_SANDBOX_ROOT                  = 本次运行的 fixture 沙箱（不是 data/）
 *          CHARACTER_MATH_CALCULATE_ENABLED=1 … 四项开关只在这里打开
 *          CHARACTER_TURN_CONTENT_TOKENS=2000   当轮内容额度（隔离验收的值）
 * 模型：`pnpm with-test-model pnpm utility:verify --live` 注入的测试端点
 * ```
 *
 * ⚠️ **不碰生产库**：`PGLITE_DATA_DIR` 指向 `os.tmpdir()` 下的一次性目录
 *    （`isolateDatabase` 的同一约定），生产 `data/pglite` 一个字节都不动。
 *
 * ⚠️ **包装器必须真的跑过**：`DSH_TEST_MODEL_WRAPPER=1` 是 `run-with-test-model.ts`
 *    给子进程打的标记（M6/WP4）。没有它就是"以为在跑测试、其实在烧 `.env` 的 key"
 *    ⇒ 本入口**拒绝运行**（exit 2），不是"试着跑一下"。
 *
 * ⚠️ **不fake**：八个场景逐条给出判据与实测读数。跑不了就 `NOT RUN` + 原因。
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { cleanupSandbox, isProductionDir } from '../../src/dev/sandbox.ts'
import { loadFixtureSet, webExpectOf } from './fixtures.ts'
import {
  createSystemResolver,
  admitWebReadUrl,
  extractArticle,
} from '../../src/infrastructure/action/adapters/web-read.ts'

export type LiveStatus = 'PASS' | 'FAIL' | 'NOT RUN'

export interface LiveCaseReading {
  readonly id: string
  readonly capability: string
  readonly kind: 'success' | 'degrade'
  readonly title: string
  readonly status: LiveStatus
  readonly input: string
  readonly exitCode?: number
  readonly reply?: string
  readonly traceId?: string
  readonly appendix?: string
  readonly expected?: unknown
  readonly observed?: unknown
  readonly reason?: string
  /** 这一场景真实发生的模型调用次数（`main.ts` 的 `[turn N] 模型 Xs` 行计数） */
  readonly modelCalls?: number
  /** 模型耗时合计（秒） */
  readonly modelSeconds?: number | null
  /** 主入口自己报出来的重试词次数（本门不发明计数器） */
  readonly retries?: number
}

export interface LiveResult {
  readonly runId: string
  readonly runDir: string
  readonly exitCode: number
  readonly cases: readonly LiveCaseReading[]
  readonly notRunReason?: string
}

interface LiveCli {
  readonly fixturesDir: string
  readonly label: string
  readonly only?: readonly string[]
}

/** 计划书 §4C 的固定公开文章（成功场景**实际读取**的那一篇） */
const LIVE_WEB_URL = process.env.UTILITY_LIVE_WEB_URL ?? 'https://example.com/'

const LOG_PREFIX =
  /^\s*(Info|Warn|Error|Debug|◇|\[sandbox\]|\[kernel\]|\[identity\]|\[telemetry\]|\[action|\[memory|\[search|\[evidence-truth\]|\[turn-content-truth\]|\[goal|\[affect)/

function parseReply(stdout: string): { reply: string; appendix: string; traceId: string } {
  const marker = '苏沐薇:'
  const at = stdout.lastIndexOf(marker)
  /*
   * ⚠️ 回复**逐字**取到"下一次明确的日志行"为止，不按"行首像不像日志"过滤。
   *    第一版按 `LOG_PREFIX` 逐行过滤，而**程序生成的来源与范围附录**每一行
   *    （`[C1] doc-zh.pdf（84 字符）`）与方括号日志行长得一样 ⇒ 附录被整段滤掉，
   *    四个成功场景因此全部假红（"没有附录"），而应用日志里那句
   *    `[turn-content-truth] …已追加确定性来源与范围附录（1 条）` 明明在说附录追加了。
   *    现在只切到**明确的字面量**：`\n Info ` / `\n Warn ` 这类带前后空格的日志行。
   */
  const LOG_LINE = /\n\s+(?:Info|Warn|Error|Debug)\s{2,}/
  const raw =
    at === -1
      ? ''
      : (() => {
          const body = stdout.slice(at + marker.length)
          const cut = LOG_LINE.exec(body)
          return (cut === null ? body : body.slice(0, cut.index)).trim()
        })()
  const appendixAt = raw.lastIndexOf('来源与范围：')
  return {
    reply: appendixAt === -1 ? raw : raw.slice(0, appendixAt).trim(),
    appendix: appendixAt === -1 ? '' : raw.slice(appendixAt).trim(),
    traceId: /trace=(trc:[0-9a-f-]+)/.exec(stdout)?.[1] ?? '',
  }
}

export async function runLive(cli: LiveCli): Promise<LiveResult> {
  const startedAt = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const runId = `${cli.label}-live-${startedAt}-${String(process.pid)}`
  const runDir = resolve(process.cwd(), 'artifacts/post-lv2/utility-skills', runId)
  mkdirSync(runDir, { recursive: true })

  const cases: LiveCaseReading[] = []
  const fail = (reason: string): LiveResult => {
    for (const id of [
      'live-math-success',
      'live-math-degrade',
      'live-document-success',
      'live-document-degrade',
      'live-web-success',
      'live-web-degrade',
      'live-ocr-success',
      'live-ocr-degrade',
    ]) {
      if (cli.only !== undefined && !cli.only.includes(id.split('-')[1] ?? '')) continue
      cases.push({
        id,
        capability: id.split('-')[1] ?? '',
        kind: id.endsWith('success') ? 'success' : 'degrade',
        title: '',
        status: 'NOT RUN',
        input: '',
        reason,
      })
    }
    const evidence = {
      schemaVersion: 'utility-skills-live@1',
      runId,
      mode: 'live',
      startedAt,
      endedAt: new Date().toISOString(),
      notRunReason: reason,
      cases,
    }
    writeFileSync(join(runDir, 'live.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    process.stdout.write(`[utility:live] NOT RUN：${reason}\n`)
    process.stdout.write(`[utility:live] 证据 = artifacts/post-lv2/utility-skills/${runId}/live.json\n`)
    return { runId, runDir, exitCode: 1, cases, notRunReason: reason }
  }

  // ① 包装器标记：没有它就是"以为在跑测试、其实在烧生产 key"
  if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') {
    return fail(
      '没有经过 `pnpm with-test-model` 包装（DSH_TEST_MODEL_WRAPPER≠1）—— 拒绝用 `.env` 的生产 key 跑 `--live`'
    )
  }
  if (!existsSync(resolve('.env.test'))) {
    return fail('找不到 `.env.test`（测试端点配置）—— 不回落生产 key')
  }

  // ② fixture：成功场景要用真的沙箱文件与真的参考答案
  const fixtures = loadFixtureSet(cli.fixturesDir)
  if (!fixtures.manifestExists || fixtures.problems.length > 0) {
    return fail(`fixture 不可用：${fixtures.problems.join('；') || 'manifest 缺失'}`)
  }

  // ③ 隔离库 + fixture 沙箱（**都在 tmpdir**；生产库一个字节都不动）
  const work = mkdtempSync(join(tmpdir(), 'project-lg-utility-live-'))
  const dbDir = join(work, 'pglite')
  const sandboxRoot = join(work, 'action-sandbox')
  mkdirSync(dbDir, { recursive: true })
  mkdirSync(sandboxRoot, { recursive: true })
  if (isProductionDir(dbDir) || isProductionDir(sandboxRoot)) {
    return fail('拒绝运行：隔离目录与真实库重叠')
  }
  for (const name of ['doc-zh.pdf', 'doc-scan.pdf', 'img-zh.png', 'img-en.png', 'img-mixed.png']) {
    copyFileSync(join(fixtures.dir, name), join(sandboxRoot, name))
  }

  const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PGLITE_DATA_DIR: dbDir,
    PROJECT_LG_SANDBOX: dbDir,
    ACTION_SANDBOX_ROOT: sandboxRoot,
    /* 四项开关只在**这一个子进程**里打开；`.env` / `.env.test` 一个字节都不改 */
    CHARACTER_MATH_CALCULATE_ENABLED: '1',
    CHARACTER_DOCUMENT_READ_ENABLED: '1',
    CHARACTER_WEB_READ_ENABLED: '1',
    CHARACTER_IMAGE_OCR_ENABLED: '1',
    /*
     * ⚠️ 跟随父进程的 `.env`（当前 3000；`flags.ts` 的上限已放宽到 4000）。
     *    这里**不写死**：兄弟批次改配置时，本门跟着改而不是悄悄测另一套配置。
     */
    CHARACTER_TURN_CONTENT_TOKENS: process.env.CHARACTER_TURN_CONTENT_TOKENS ?? '2000',
    CHARACTER_WEB_SEARCH_ENABLED: '0',
  }

  /*
   * ==========================================================================
   *  "资产真的不可用"的夹具（自证式，不是代理式）
   * ==========================================================================
   * ⚠️ 实测（2026-10-04）：只把 `PROJECT_LG_OCR_LANG_PATH` 指向空目录**不构成降档** ——
   *    适配器懒加载的 `ensureOcrLocalAssets()` 看见语言目录为空，就从**已安装包**
   *    物化一份进去，然后正常识别成功（上一轮的 `live-ocr-degrade` 因此是个**假 PASS**：
   *    它一边声称"资产缺失"，一边在回复里引用了识别出来的文字）。
   *    要真的缺资产，必须让**来源**也是空的 ⇒ 三处一起指向空树：
   *      · `PROJECT_LG_OCR_LANG_PATH`         目标语言目录（空）
   *      · `PROJECT_LG_OCR_DATA_PACKAGE_ROOT` 物化来源（空）
   *      · `PROJECT_LG_OCR_CACHE_PATH`        缓存目录（空）
   *    并且**先自证**：在子进程里问适配器自己，两处路径确实为空、物化返回问题。
   */
  const ocrEmptyRoot = join(work, 'ocr-empty')
  const ocrEmptyLang = join(ocrEmptyRoot, 'lang')
  const ocrEmptyData = join(ocrEmptyRoot, 'data-packages')
  const ocrEmptyCache = join(ocrEmptyRoot, 'cache')
  for (const dir of [ocrEmptyLang, ocrEmptyData, ocrEmptyCache]) mkdirSync(dir, { recursive: true })
  const ocrMissingEnv: NodeJS.ProcessEnv = {
    PROJECT_LG_OCR_BACKEND: 'rapidocr',
    PROJECT_LG_RAPIDOCR_MODEL_DIR: ocrEmptyLang,
    PROJECT_LG_OCR_LANG_PATH: ocrEmptyLang,
    PROJECT_LG_OCR_DATA_PACKAGE_ROOT: ocrEmptyData,
    PROJECT_LG_OCR_CACHE_PATH: ocrEmptyCache,
  }

  const say = (
    capability: string,
    input: string,
    extraEnv: NodeJS.ProcessEnv = {}
  ): {
    exitCode: number
    reply: string
    appendix: string
    traceId: string
    stdout: string
    modelCalls: number
    modelSeconds: number | null
    retries: number
  } => {
    if (cli.only !== undefined && !cli.only.includes(capability)) {
      return { exitCode: 0, reply: '', appendix: '', traceId: '', stdout: '', modelCalls: 0, modelSeconds: null, retries: 0 }
    }
    const result = spawnSync(process.execPath, [tsxCli, 'src/main.ts', input], {
      cwd: process.cwd(),
      env: { ...childEnv, ...extraEnv },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const stdout = String(result.stdout ?? '')
    /*
     * ⚠️ 应用日志走 **stderr**（实测：子进程 stdout 里只有 `苏沐薇:` 与那句回复，
     *    `[turn N] 模型 Xs` 那类读数一行都不在 stdout 上）。
     *    第一版只解析 stdout ⇒ 八个场景的 `modelCalls` 全是 0 —— 那不是"没调模型"，
     *    而是**量错了流**。这里把两条流合并后再计数。
     */
    const merged = `${stdout}\n${String(result.stderr ?? '')}`
    const parsed = parseReply(stdout)
    /*
     * 模型调用读数：`main.ts:2941` 每个真实轮次必打一行 `[turn N] 模型 Xs`。
     * 计数它 = "这一轮真的调了几次模型"；重试按主入口自己的日志词计数
     * （本门**不**发明一个重试计数器，只数它自己说出来的）。
     */
    const modelLines = [...merged.matchAll(/\[turn \d+\][^\n]*模型[^\n]*?([\d.]+)\s*s/g)]
    const seconds = modelLines.map((match) => Number(match[1]))
    return {
      exitCode: result.status ?? 1,
      ...parsed,
      stdout: merged,
      modelCalls: modelLines.length,
      modelSeconds: seconds.length === 0 ? null : seconds.reduce((sum, value) => sum + value, 0),
      retries: [...merged.matchAll(/重试|retry/gi)].length,
    }
  }

  /** 每个场景的子进程原始输出落到 `local/`（正文只在那里；公开证据只留净化后的读数） */
  const localDir = resolve(process.cwd(), 'artifacts/post-lv2/local/utility-skills-preparation/live', runId)
  const dumpRaw = (id: string, output: string): void => {
    try {
      mkdirSync(localDir, { recursive: true })
      writeFileSync(join(localDir, `${id}.log`), output, 'utf8')
    } catch {
      /* 落盘失败不影响读数 */
    }
  }

  const record = (
    base: Omit<LiveCaseReading, 'status'>,
    status: LiveStatus,
    extra: Partial<LiveCaseReading> = {},
    rawOutput?: string
  ): void => {
    if (cli.only !== undefined && !cli.only.includes(base.capability)) return
    cases.push({ ...base, status, ...extra })
    if (rawOutput !== undefined) dumpRaw(base.id, rawOutput)
  }

  // -------------------------------------------------------------------------
  // 场景 ① 计算 · 成功
  // -------------------------------------------------------------------------
  const mathSuccess = say('math', '帮我算一下 0.1 + 0.2 是多少')
  record(
    {
      id: 'live-math-success',
      capability: 'math',
      kind: 'success',
      title: '明确十进制算式，回答与程序结果一致',
      input: '帮我算一下 0.1 + 0.2 是多少',
      exitCode: mathSuccess.exitCode,
      reply: mathSuccess.reply.slice(0, 400),
      traceId: mathSuccess.traceId,
      appendix: mathSuccess.appendix.slice(0, 400),
      expected: { value: '0.3', appendix: '来源与范围：' },
    },
    mathSuccess.reply.includes('0.3') && mathSuccess.appendix.includes('来源与范围：') ? 'PASS' : 'FAIL',
    {
      modelCalls: mathSuccess.modelCalls,
      modelSeconds: mathSuccess.modelSeconds,
      retries: mathSuccess.retries,
      observed: {
        containsProgramValue: mathSuccess.reply.includes('0.3'),
        appendixPresent: mathSuccess.appendix.includes('来源与范围：'),
      },
      ...(mathSuccess.reply.includes('0.3') && mathSuccess.appendix !== ''
        ? {}
        : { reason: '回复里没有程序结果 0.3，或没有程序生成的来源与范围附录' }),
    },
    mathSuccess.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ② 计算 · 降档（非法函数）
  // -------------------------------------------------------------------------
  const mathDegrade = say('math', '帮我算一下 import("x") 是多少')
  const mathDegradeOk =
    !/我算出来了|算出来了|等于\s*1\b/.test(mathDegrade.reply) && mathDegrade.traceId !== ''
  record(
    {
      id: 'live-math-degrade',
      capability: 'math',
      kind: 'degrade',
      title: '非法函数/表达式，不声称已计算',
      input: '帮我算一下 import("x") 是多少',
      exitCode: mathDegrade.exitCode,
      reply: mathDegrade.reply.slice(0, 400),
      traceId: mathDegrade.traceId,
      expected: { noSuccessClaim: true },
    },
    mathDegradeOk ? 'PASS' : 'FAIL',
    {
      modelCalls: mathDegrade.modelCalls,
      modelSeconds: mathDegrade.modelSeconds,
      retries: mathDegrade.retries,
      observed: { reply: mathDegrade.reply.slice(0, 160) },
      ...(mathDegradeOk ? {} : { reason: '回复里出现了"算出来了"这类成功口吻' }),
    },
    mathDegrade.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ③ 文档 · 成功
  // -------------------------------------------------------------------------
  const docSuccess = say('document', '读一下 doc-zh.pdf')
  const docExpect = fixtures.manifest?.files.find((file) => file.path === 'doc-zh.pdf')?.expect
  const docNeedle = docExpect?.mustContain?.[0] ?? '示例工程科技大学'
  record(
    {
      id: 'live-document-success',
      capability: 'document',
      kind: 'success',
      title: '固定文档中找到指定事实/数字并说明来源',
      input: '读一下 doc-zh.pdf',
      exitCode: docSuccess.exitCode,
      reply: docSuccess.reply.slice(0, 400),
      traceId: docSuccess.traceId,
      appendix: docSuccess.appendix.slice(0, 400),
      expected: { mustContain: docNeedle, appendix: '来源与范围：' },
    },
    docSuccess.reply.includes(docNeedle) && docSuccess.appendix.includes('doc-zh.pdf') ? 'PASS' : 'FAIL',
    {
      modelCalls: docSuccess.modelCalls,
      modelSeconds: docSuccess.modelSeconds,
      retries: docSuccess.retries,
      observed: {
        containsNeedle: docSuccess.reply.includes(docNeedle),
        appendixHasResource: docSuccess.appendix.includes('doc-zh.pdf'),
      },
      ...(docSuccess.reply.includes(docNeedle) && docSuccess.appendix.includes('doc-zh.pdf')
        ? {}
        : { reason: `回复里没有 ${docNeedle}，或附录里没有 doc-zh.pdf` }),
    },
    docSuccess.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ④ 文档 · 降档（扫描件）
  // -------------------------------------------------------------------------
  const docDegrade = say('document', '读一下 doc-scan.pdf')
  const scanExpect = fixtures.manifest?.files.find((file) => file.path === 'doc-scan.pdf')?.expect
  const rasterText = scanExpect?.rasterTextNotExtractable ?? '扫描件：请使用 OCR'
  const docDegradeOk =
    !docDegrade.reply.includes(rasterText) &&
    !/我读到了|读完了|文件里写着/.test(docDegrade.reply) &&
    docDegrade.traceId !== ''
  record(
    {
      id: 'live-document-degrade',
      capability: 'document',
      kind: 'degrade',
      title: '扫描或空文件，不猜测内容',
      input: '读一下 doc-scan.pdf',
      exitCode: docDegrade.exitCode,
      reply: docDegrade.reply.slice(0, 400),
      traceId: docDegrade.traceId,
      expected: { noRasterText: rasterText, noSuccessClaim: true },
    },
    docDegradeOk ? 'PASS' : 'FAIL',
    {
      modelCalls: docDegrade.modelCalls,
      modelSeconds: docDegrade.modelSeconds,
      retries: docDegrade.retries,
      observed: {
        leakedRasterText: docDegrade.reply.includes(rasterText),
        reply: docDegrade.reply.slice(0, 160),
      },
      ...(docDegradeOk ? {} : { reason: '回复里泄漏了栅格层文字，或出现了成功口吻' }),
    },
    docDegrade.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ⑤ 网页 · 成功（真实公开 HTTPS 文章）
  // -------------------------------------------------------------------------
  const webSuccess = say('web', `读一下 ${LIVE_WEB_URL}`)
  const webOk =
    webSuccess.reply.length > 0 &&
    webSuccess.appendix.includes(LIVE_WEB_URL) &&
    !/没拿到|失败了|超时|没有启用/.test(webSuccess.reply)
  /*
   * 程序侧独立读数：同一次真实出站由适配器的**生产获取器**跑（本函数只用它的
   * 纯函数部分做交叉核对）—— 这里记录"这一轮的最终 URL 与正文长度"。
   */
  const webExtraction = await (async () => {
    if (cli.only !== undefined && !cli.only.includes('web')) return { admitted: false as const, reason: '未选择 web' }
    try {
      const admission = admitWebReadUrl(LIVE_WEB_URL)
      if (!admission.ok) return { admitted: false as const, reason: admission.reason }
      const addresses = await createSystemResolver()(admission.host)
      const article = await extractArticle(readFileSync(join(fixtures.dir, 'web-article.html'), 'utf8'))
      return {
        admitted: true as const,
        resolvedAddresses: addresses.length,
        fixtureExtractionOk: article.ok,
      }
    } catch (error) {
      return { admitted: false as const, reason: (error as Error).message }
    }
  })()
  record(
    {
      id: 'live-web-success',
      capability: 'web',
      kind: 'success',
      title: '真实文章的指定段落信息，并给实际来源/范围',
      input: `读一下 ${LIVE_WEB_URL}`,
      exitCode: webSuccess.exitCode,
      reply: webSuccess.reply.slice(0, 400),
      traceId: webSuccess.traceId,
      appendix: webSuccess.appendix.slice(0, 400),
      expected: { appendixHasUrl: LIVE_WEB_URL, noDegradeTone: true },
    },
    webOk ? 'PASS' : 'FAIL',
    {
      modelCalls: webSuccess.modelCalls,
      modelSeconds: webSuccess.modelSeconds,
      retries: webSuccess.retries,
      observed: { appendixHasUrl: webSuccess.appendix.includes(LIVE_WEB_URL), probe: webExtraction },
      ...(webOk ? {} : { reason: '回复里没有来源/范围附录，或出现了降档口吻' }),
    },
    webSuccess.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ⑥ 网页 · 降档（禁止访问的 URL）
  // -------------------------------------------------------------------------
  const webDegrade = say('web', '读一下 https://127.0.0.1/')
  const webDegradeOk =
    !/我读到了|读完了|文章里写/.test(webDegrade.reply) && webDegrade.traceId !== ''
  record(
    {
      id: 'live-web-degrade',
      capability: 'web',
      kind: 'degrade',
      title: '禁止访问的 URL 被程序拒绝，不声称已阅读',
      input: '读一下 https://127.0.0.1/',
      exitCode: webDegrade.exitCode,
      reply: webDegrade.reply.slice(0, 400),
      traceId: webDegrade.traceId,
      expected: { noReadClaim: true },
    },
    webDegradeOk ? 'PASS' : 'FAIL',
    {
      modelCalls: webDegrade.modelCalls,
      modelSeconds: webDegrade.modelSeconds,
      retries: webDegrade.retries,
      observed: { reply: webDegrade.reply.slice(0, 160) },
      ...(webDegradeOk ? {} : { reason: '回复里出现了"我读到了"这类成功口吻' }),
    },
    webDegrade.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ⑦ OCR · 成功
  // -------------------------------------------------------------------------
  const ocrSuccess = say('ocr', '识别一下 img-en.png')
  const ocrExpect = fixtures.manifest?.files.find((file) => file.path === 'img-en.png')?.expect
  const ocrNumbers = ocrExpect?.keyNumbers ?? ['4711']
  const ocrOk =
    ocrNumbers.some((number) => ocrSuccess.reply.includes(number)) &&
    ocrSuccess.appendix.includes('img-en.png')
  record(
    {
      id: 'live-ocr-success',
      capability: 'ocr',
      kind: 'success',
      title: '固定清晰图，复述指定关键文字/数字',
      input: '识别一下 img-en.png',
      exitCode: ocrSuccess.exitCode,
      reply: ocrSuccess.reply.slice(0, 400),
      traceId: ocrSuccess.traceId,
      appendix: ocrSuccess.appendix.slice(0, 400),
      expected: { keyNumbers: ocrNumbers },
    },
    ocrOk ? 'PASS' : 'FAIL',
    {
      modelCalls: ocrSuccess.modelCalls,
      modelSeconds: ocrSuccess.modelSeconds,
      retries: ocrSuccess.retries,
      observed: {
        numbersFound: ocrNumbers.filter((number) => ocrSuccess.reply.includes(number)),
        appendixHasResource: ocrSuccess.appendix.includes('img-en.png'),
      },
      ...(ocrOk ? {} : { reason: ocrNumbers.some((number) => ocrSuccess.reply.includes(number))
        ? '识别数字在回复里；CLI spokenText 未含来源附录，原抓取判据仍 FAIL'
        : '关键数字没有出现在回复里' }),
    },
    ocrSuccess.stdout
  )

  // -------------------------------------------------------------------------
  // 场景 ⑧ OCR · 降档（**资产真的不可用**；判据取程序事实，不取目录存在性）
  // -------------------------------------------------------------------------
  /*
   * ⚠️ 这场景第一版是个**假 PASS**（2026-10-04 实测）：只把语言目录指向空目录，
   *    适配器的懒加载 `ensureOcrLocalAssets()` 就从已安装包**物化**了一份进去，
   *    然后正常识别成功 —— 于是它一边声称"资产缺失"、一边在回复里引用识别文字。
   *    ⇒ 现在：语言目录 / 物化来源 / 缓存**三处**都指向空树，并且
   *      · 先在子进程里**自证**两处路径为空；
   *      · 判据取**程序事实**（失败码 + 没有当轮内容 + 没有成功口吻），
   *        目录存在性只作诊断，**不**当证据。
   */
  const envProbe = spawnSync(
    process.execPath,
    [
      tsxCli,
      '-e',
      "import('./src/infrastructure/action/adapters/rapid-ocr-assets.ts').then(async (m) => {" +
        "console.log('MODELS=' + m.defaultRapidOcrModels());" +
        "const r = await m.verifyRapidOcrAssets();" +
        "console.log('PROBLEMS=' + JSON.stringify(r.problems));" +
        "console.log('LOADED=' + JSON.stringify(r.assets.map(a => a.component)));" +
        "})",
    ],
    {
      cwd: process.cwd(),
      env: { ...childEnv, ...ocrMissingEnv },
      encoding: 'utf8',
    }
  )
  const envProbeOut = `${String(envProbe.stdout ?? '')}\n${String(envProbe.stderr ?? '')}`
  const ocrDegrade = say('ocr', '识别一下 img-zh.png', ocrMissingEnv)
  /*
   * ==========================================================================
   *  **程序事实**四件（判据全部取程序侧读数，不取"回复听起来像不像"）
   * ==========================================================================
   *   ① 适配器把"资产不可用"**说出来**了（`[turn-content-truth] …ocr:failed`
   *      或失败读数里逐字带"本地 OCR 资产不可用"）—— 这是"降档条件真的生效"的证据
   *   ② 这一轮**没有**当轮内容（`turn-content` section 没出现 ⇒ 没有可引用内容）
   *   ③ 上下文编译里没有 `delivered` 态
   *   ④ 回复里**不含**任何识别出来的文字（22.5 / 测试 / 温度 一个都不许出现）
   * 另加一条**姿态**判据：没有"识别出/识别到/图里写的是"这类**完成态**表述。
   * ⚠️ 刻意不拿"识别"这个裸词判：她会说"没识别出来 / 识别这一步没走通" —— 那恰恰是**如实**的。
   */
  const assetFailureNamed =
    /本地 OCR 资产不可用|资产不可用|已安装包里的语言资产读不到/.test(ocrDegrade.stdout) ||
    /\[turn-content-truth\][^\n]*image\.ocr[^\n]*(failed|empty)/.test(ocrDegrade.stdout)
  const noTurnContent = !/sections=\[[^\]]*turn-content/.test(ocrDegrade.stdout)
  const notDelivered = !/\[turn-content-truth\][^\n]*image\.ocr[^\n]*delivered/.test(ocrDegrade.stdout)
  const noRecognizedText = !/22\.5|测\s*试|温\s*度/.test(ocrDegrade.reply)
  const noSuccessClaim = !/识别出|(?<!没有)识别到|图里写的是|识别完了|识别出来了/.test(ocrDegrade.reply)
  const ocrDegradeOk =
    assetFailureNamed &&
    ocrDegrade.reply.includes('本地 OCR 资产不可用') &&
    noTurnContent &&
    notDelivered &&
    noRecognizedText &&
    noSuccessClaim &&
    ocrDegrade.traceId !== ''
  record(
    {
      id: 'live-ocr-degrade',
      capability: 'ocr',
      kind: 'degrade',
      title: '缺语言资产，零出站且如实失败',
      input: '识别一下 img-zh.png（语言目录 / 物化来源 / 缓存三处都指向空树）',
      exitCode: ocrDegrade.exitCode,
      reply: ocrDegrade.reply.slice(0, 400),
      traceId: ocrDegrade.traceId,
      expected: {
        noRecognitionClaim: true,
        programFact: '本地 OCR 资产不可用',
        noTurnContent: true,
      },
      modelCalls: ocrDegrade.modelCalls,
      modelSeconds: ocrDegrade.modelSeconds,
      retries: ocrDegrade.retries,
    },
    ocrDegradeOk ? 'PASS' : 'FAIL',
    {
      observed: {
        reply: ocrDegrade.reply.slice(0, 200),
        /* 程序侧事实（判据） */
        assetFailureNamed,
        noTurnContent,
        notDelivered,
        noRecognizedText,
        noSuccessClaim,
        /* 诊断（**不**当证据）：自证三处路径为空、物化返回什么 */
        envProbe: envProbeOut
          .split('\n')
          .filter((line) => /^(LANG|DATA|PROBLEMS|MATERIALIZED)=/.test(line))
          .map((line) => line.replace(/C:\\Users\\user\\AppData\\Local\\Temp\\[^\\]*/, '<tmp>'))
          .join(' | ')
          .slice(0, 400),
      },
      ...(ocrDegradeOk
        ? {}
        : {
            reason:
              '降档条件没有真的生效或姿态不对：' +
              `noTurnContent=${String(noTurnContent)} notDelivered=${String(notDelivered)} ` +
              `noRecognizedText=${String(noRecognizedText)} noSuccessClaim=${String(noSuccessClaim)}`,
          }),
    },
    `${ocrDegrade.stdout}\n--- envProbe ---\n${envProbeOut}`
  )

  const notRun = cases.filter((item) => item.status === 'NOT RUN').length
  const failed = cases.filter((item) => item.status === 'FAIL').length
  const passed = cases.filter((item) => item.status === 'PASS').length
  const evidence = {
    schemaVersion: 'utility-skills-live@1',
    runId,
    mode: 'live',
    startedAt,
    endedAt: new Date().toISOString(),
    only: cli.only ?? ['math', 'document', 'web', 'ocr'],
    endpoint: {
      baseUrlHost: (() => {
        try {
          return new URL(process.env.OPENAI_BASE_URL ?? '').host
        } catch {
          return '(不可解析)'
        }
      })(),
      model: process.env.OPENAI_LARGE_MODEL ?? '(未设)',
      keyPresent: (process.env.OPENAI_API_KEY ?? '').length > 0,
    },
    isolation: {
      dbDir: dbDir.replace(process.cwd(), '<cwd>'),
      sandboxRoot: sandboxRoot.replace(process.cwd(), '<cwd>'),
      productionDbTouched: false,
    },
    counts: { pass: passed, fail: failed, notRun, total: cases.length },
    cases,
  }
  writeFileSync(join(runDir, 'live.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  cleanupSandbox(work)

  process.stdout.write(`[utility:live] runId = ${runId}\n`)
  process.stdout.write(
    `[utility:live] ${String(cases.length)} 轮：PASS ${String(passed)} · FAIL ${String(failed)} · NOT RUN ${String(notRun)}\n`
  )
  process.stdout.write(`[utility:live] 证据 = artifacts/post-lv2/utility-skills/${runId}/live.json\n`)
  return { runId, runDir, exitCode: failed === 0 && notRun === 0 ? 0 : 1, cases }
}

export { LIVE_WEB_URL, webExpectOf }
