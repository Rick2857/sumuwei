/**
 * 门执行器的**自证门**（`pnpm gates:verify`）。
 *
 * ============================================================================
 *  它为什么存在（`AGENTS.md` §6.2 / §6.7 / §6.8）
 * ============================================================================
 * 一个"能把 34 道门并发跑起来"的调度器，如果它自己没被验证过，那么它最坏的
 * 失败方式与"什么都不检查"在输出上**无法区分**：
 *   · 冲突判定写错 ⇒ 两个门同时写同一份证据，但两边都打印 ✅；
 *   · 依赖被忽略 ⇒ 汇总门读到半份数据，打印 ✅；
 *   · 缓存键漏了输入 ⇒ 真红的门被复用成绿；
 *   · 还原白名单写错 ⇒ 把你**故意**重写的证据一起还原掉（§7 的真实事故）。
 *
 * 所以本门对每一类判据都做三段式：
 *   **正控**（合法输入 ⇒ 安静）/ **负控**（注入假象 ⇒ 必须响）/ **恢复**（放回真实现 ⇒ 重新安静）。
 *
 * ---------------------------------------------------------------------------
 *  两条纪律
 * ---------------------------------------------------------------------------
 * ① **不碰真实仓库的证据**：所有"会不会误伤"的试验都在 `mkdtempSync` 出来的
 *    临时 git 仓库里做（`git init` + 一次提交），失败的破坏范围仅限临时目录。
 * ② **measured_count > 0 是判决前提**（§6.8）：本门末尾自己核对"实际检查了多少项"，
 *    为 0 就报 `MEASUREMENT INVALID`，**不是** PASS。
 *
 * 证据：`artifacts/.fast/runner-verification.json`（该目录不进 git —— 见 .gitignore）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cacheability, gateInputKey, inputClosure, sourceTreeKey } from './gates/cache.ts'
import { decideOfflineReuse } from './gates/reuse.ts'
import { REPO_ROOT, ALL_GATES } from './gates/manifest.ts'
import { artifactStatus, restoreNewlyDirtyArtifacts, runGates } from './gates/runner.ts'
import { conflictBetween, validateManifest, type GateSpec } from './gates/types.ts'

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
let measured = 0

function check(name: string, pass: boolean, detail = ''): void {
  measured += 1
  checks.push({ name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail !== '' ? `\n       ${detail}` : ''}`)
}

function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

// ---------------------------------------------------------------------------
// 合成门：不触碰真实仓库，只 sleep（用来测调度行为）
// ---------------------------------------------------------------------------

function sleepGate(id: string, ms: number, resources: GateSpec['resources']): GateSpec {
  return {
    id,
    title: `合成门 ${id}（sleep ${ms}ms）`,
    argv: [process.execPath, '-e', `setTimeout(()=>process.exit(0),${ms})`],
    resources,
  }
}

function failGate(id: string): GateSpec {
  return {
    id,
    title: `合成门 ${id}（必然失败）`,
    argv: [process.execPath, '-e', 'process.exit(3)'],
    resources: { parallel: 'safe' },
  }
}

async function runSynthetic(
  specs: readonly GateSpec[],
  concurrency: number,
  label: string
): Promise<Awaited<ReturnType<typeof runGates>>> {
  return runGates(specs, {
    root: REPO_ROOT,
    lane: `verify:${label}`,
    mode: 'fast',
    concurrency,
    runId: `verify-${label}`,
    evidenceRoot: join(REPO_ROOT, 'artifacts', '.fast', `verify-${label}`),
    keepEvidence: true, // 自证门用合成门，不需要"还原发布证据"；也不许它动 artifacts
    timeoutMsPerGate: 60_000,
  })
}

/** 在临时 git 仓库里造一个"已跟踪的 artifacts 证据文件"。 */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-runner-verify-'))
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.email', 'verify@local')
  git('config', 'user.name', 'verify')
  mkdirSync(join(dir, 'artifacts'), { recursive: true })
  writeFileSync(join(dir, 'artifacts', 'committed.json'), '{"v":"历史证据"}\n', 'utf8')
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')
  return dir
}

// ===========================================================================
// A. 清单自检
// ===========================================================================
section('A. 清单自检（validateManifest）')

const manifestProblems = validateManifest(ALL_GATES)
check(
  'A1 正控：随仓库发布的清单本身合法（无缺声明/无环/路径不逃逸）',
  manifestProblems.length === 0,
  `检查了 ${ALL_GATES.length} 道门，问题 ${manifestProblems.length} 条` +
    (manifestProblems.length > 0 ? `\n       ${manifestProblems.slice(0, 5).map((p) => `${p.id}: ${p.problem}`).join('\n       ')}` : '')
)

const broken: { name: string; specs: GateSpec[]; expect: string }[] = [
  {
    name: '缺 parallel 声明',
    specs: [{ id: 'x', title: 'x', argv: ['node'], resources: {} as GateSpec['resources'] }],
    expect: 'resources.parallel 必须显式声明',
  },
  {
    name: '依赖指向不存在的门',
    specs: [{ id: 'x', title: 'x', argv: ['node'], resources: { parallel: 'safe' }, dependsOn: ['nope'] }],
    expect: 'dependsOn 指向不存在的门',
  },
  {
    name: '依赖环',
    specs: [
      { id: 'x', title: 'x', argv: ['node'], resources: { parallel: 'safe' }, dependsOn: ['y'] },
      { id: 'y', title: 'y', argv: ['node'], resources: { parallel: 'safe' }, dependsOn: ['x'] },
    ],
    expect: '依赖环',
  },
  {
    name: '证据路径逃逸仓库',
    specs: [
      { id: 'x', title: 'x', argv: ['node'], resources: { parallel: 'safe', evidenceWrites: ['../../etc/passwd'] } },
    ],
    expect: 'evidenceWrites 不得逃出仓库',
  },
]
for (const sample of broken) {
  const problems = validateManifest(sample.specs)
  check(
    `A2 负控：人造坏清单「${sample.name}」必须被拦下`,
    problems.some((p) => p.problem.includes(sample.expect)),
    `报出 ${problems.length} 条问题：${problems.map((p) => p.problem).join(' / ')}`
  )
}
check(
  'A2b 恢复：把坏清单里那条修好 ⇒ 重新安静',
  validateManifest([
    { id: 'x', title: 'x', argv: ['node'], resources: { parallel: 'safe' }, dependsOn: ['y'] },
    { id: 'y', title: 'y', argv: ['node'], resources: { parallel: 'safe' } },
  ]).length === 0,
  '修好后问题数 = 0'
)

// ===========================================================================
// B. 冲突判定（纯函数）
// ===========================================================================
section('B. 冲突判定（conflictBetween，纯函数）')

const safeA = sleepGate('safe-a', 10, { parallel: 'safe' })
const safeB = sleepGate('safe-b', 10, { parallel: 'safe' })
check(
  'B1 正控：两道各自独立、都声明 safe 的门 ⇒ 判定为**不冲突**',
  conflictBetween(safeA, safeB) === undefined,
  '返回 undefined（可以同时跑）'
)

const conflictCases: { name: string; a: GateSpec; b: GateSpec; expect: string }[] = [
  {
    name: '都要真实库',
    a: sleepGate('r1', 10, { parallel: 'safe', realDb: true }),
    b: sleepGate('r2', 10, { parallel: 'safe', realDb: true }),
    expect: 'real-db-single-holder',
  },
  {
    name: '证据路径互为父子目录',
    a: sleepGate('e1', 10, { parallel: 'safe', evidenceWrites: ['artifacts/m4.5'] }),
    b: sleepGate('e2', 10, { parallel: 'safe', evidenceWrites: ['artifacts/m4.5/gate-results.json'] }),
    expect: 'evidence-overlap',
  },
  {
    name: '固定端口相同',
    a: sleepGate('p1', 10, { parallel: 'safe', ports: [8787] }),
    b: sleepGate('p2', 10, { parallel: 'safe', ports: [8787] }),
    expect: 'port-overlap',
  },
  {
    name: '同一 scratch 键',
    a: sleepGate('s1', 10, { parallel: 'safe', scratchKey: 'same' }),
    b: sleepGate('s2', 10, { parallel: 'safe', scratchKey: 'same' }),
    expect: 'scratch-overlap',
  },
  {
    name: '任一方声明 serial',
    a: sleepGate('x1', 10, { parallel: 'serial' }),
    b: safeA,
    expect: 'declared-serial',
  },
  {
    name: '任一方缺声明（失败关闭）',
    a: { id: 'u1', title: 'u1', argv: ['node'], resources: {} as GateSpec['resources'] },
    b: safeB,
    expect: 'missing-declaration',
  },
  {
    name: '会改写 git 工作树',
    a: sleepGate('g1', 10, { parallel: 'safe', mutatesGitWorktree: true }),
    b: safeB,
    expect: 'git-worktree-mutation',
  },
]
for (const c of conflictCases) {
  const got = conflictBetween(c.a, c.b)
  check(
    `B2 负控：「${c.name}」必须被判为冲突，且理由是 ${c.expect}`,
    got?.reason === c.expect,
    got === undefined ? '❌ 判成了不冲突（这正是最危险的组合）' : `reason=${got.reason}（${got.detail}）`
  )
}
check(
  'B2b 恢复：把 serial 声明改回 safe ⇒ 重新判定为不冲突',
  conflictBetween(sleepGate('x1', 10, { parallel: 'safe' }), safeA) === undefined,
  '返回 undefined'
)

// ===========================================================================
// C. 调度行为（真 spawn 合成门）
// ===========================================================================
section('C. 调度行为（真 spawn，但都是合成门）')

const serialWall = await runSynthetic([sleepGate('c1', 1500, { parallel: 'safe' }), sleepGate('c2', 1500, { parallel: 'safe' })], 1, 'serial')
const parallelWall = await runSynthetic(
  [sleepGate('c3', 1500, { parallel: 'safe' }), sleepGate('c4', 1500, { parallel: 'safe' })],
  4,
  'parallel'
)
const serialSeconds = serialWall.seconds
const parallelSeconds = parallelWall.seconds
const parallelOverlap = parallelWall.results.some((r) => r.overlappedWith.length > 0)
check(
  'C1 正控：两道 safe 门在并发档里**真的同时跑**（有重叠区间）',
  parallelOverlap,
  parallelWall.results.map((r) => `${r.id} ∥ ${r.overlappedWith.join('|') || '（无）'}`).join('；')
)
check(
  'C1b 正控：并发档墙钟**快于**串行档（同一对门、同一台机器上自比）',
  parallelSeconds < serialSeconds,
  `并发 ${parallelSeconds}s < 串行 ${serialSeconds}s`
)
check(
  'C2 负控：并发上限 = 1 ⇒ 任何门都没有重叠（证明"墙钟变快"不是因为门变短了）',
  serialWall.results.every((r) => r.overlappedWith.length === 0),
  serialWall.results.map((r) => `${r.id} ∥ ${r.overlappedWith.join('|') || '（无）'}`).join('；')
)

const serialPairWall = await runSynthetic(
  [sleepGate('d1', 400, { parallel: 'safe' }), sleepGate('d2', 200, { parallel: 'serial' })],
  4,
  'declared-serial'
)
const d1 = serialPairWall.results.find((r) => r.id === 'd1')
const d2 = serialPairWall.results.find((r) => r.id === 'd2')
check(
  'C3 负控：申报 serial 的门在并发档里也**不与他人重叠**',
  d1 !== undefined && d2 !== undefined && d1.overlappedWith.length === 0 && d2.overlappedWith.length === 0,
  `d1 ∥ [${d1?.overlappedWith.join(',') ?? '?'}] · d2 ∥ [${d2?.overlappedWith.join(',') ?? '?'}]` +
    ` · d2.serializedAgainst=[${d2?.serializedAgainst.join(',') ?? '?'}]`
)

const depWall = await runSynthetic(
  [
    { ...sleepGate('dep-first', 600, { parallel: 'safe' }) },
    { ...sleepGate('dep-second', 100, { parallel: 'safe' }), dependsOn: ['dep-first'] },
  ],
  4,
  'depends'
)
const first = depWall.results.find((r) => r.id === 'dep-first')
const second = depWall.results.find((r) => r.id === 'dep-second')
check(
  'C4 正控：dependsOn 真的把顺序钉住了（后门开始时间 ≥ 前门结束时间）',
  first !== undefined && second !== undefined && Date.parse(second.startedAt) >= Date.parse(first.finishedAt),
  `first 结束 ${first?.finishedAt ?? '?'} → second 开始 ${second?.startedAt ?? '?'}`
)

const failWall = await runSynthetic([failGate('boom'), { ...sleepGate('after-boom', 100, { parallel: 'safe' }), dependsOn: ['boom'] }], 4, 'failclosed')
const afterBoom = failWall.results.find((r) => r.id === 'after-boom')
check(
  'C5 负控：前门失败 ⇒ 下游门记 SKIPPED（**不是** PASS），整体判决 FAIL',
  failWall.verdict === 'FAIL' && afterBoom?.status === 'SKIPPED' && afterBoom.blockedBy === 'boom',
  `verdict=${failWall.verdict} · after-boom=${afterBoom?.status ?? '?'}（blockedBy=${afterBoom?.blockedBy ?? '?'}）`
)

const refused = await runGates(
  [
    { id: 'bad', title: 'bad', argv: ['node'], resources: {} as GateSpec['resources'] },
    safeA,
  ],
  {
    root: REPO_ROOT,
    lane: 'verify:refused',
    mode: 'fast',
    concurrency: 3,
    runId: 'verify-refused',
    evidenceRoot: join(REPO_ROOT, 'artifacts', '.fast', 'verify-refused'),
    keepEvidence: true,
  }
)
check(
  'C6 负控：清单有问题 ⇒ 整个运行判 REFUSED（拒绝启动，而不是"挑着跑"）',
  refused.verdict === 'REFUSED' && refused.manifestProblems.length > 0,
  `verdict=${refused.verdict} · 问题 ${refused.manifestProblems.length} 条`
)

// ===========================================================================
// D. 证据还原白名单（全程在临时 git 仓库里做，不碰真实仓库）
// ===========================================================================
section('D. 证据还原白名单（临时 git 仓库）')

const tmpRepo = makeTempRepo()
try {
  // 运行前就已经脏的路径：必须被**保留**（§7 的真实事故：无差别还原会把"你故意重写的证据"一起冲掉）
  writeFileSync(join(tmpRepo, 'artifacts', 'pre-dirty.json'), '{"v":"run 之前就改了"}\n', 'utf8')
  const before = artifactStatus(tmpRepo)

  // 本次运行"新弄脏"的两种形态：改已跟踪文件 + 新增未跟踪文件
  writeFileSync(join(tmpRepo, 'artifacts', 'committed.json'), '{"v":"被本次运行改写"}\n', 'utf8')
  mkdirSync(join(tmpRepo, 'artifacts', 'newdir'), { recursive: true })
  writeFileSync(join(tmpRepo, 'artifacts', 'newdir', 'brand-new.json'), '{}\n', 'utf8')

  const restore = restoreNewlyDirtyArtifacts(tmpRepo, before)
  const committedNow = readFileSync(join(tmpRepo, 'artifacts', 'committed.json'), 'utf8')
  check(
    'D1 正控：本次新改写的**已跟踪**证据被还原成原样',
    restore.restored.includes('artifacts/committed.json') && committedNow.includes('历史证据'),
    `restored=[${restore.restored.join(', ')}] · 内容=${committedNow.trim()}`
  )
  check(
    'D2 正控：本次新增的**未跟踪**证据被删除',
    restore.deleted.some((p) => p.startsWith('artifacts/newdir')) && !existsSync(join(tmpRepo, 'artifacts', 'newdir', 'brand-new.json')),
    `deleted=[${restore.deleted.join(', ')}]`
  )
  check(
    'D3 负控·白名单纪律：运行前就脏的路径**必须保留**（不许无差别还原）',
    existsSync(join(tmpRepo, 'artifacts', 'pre-dirty.json')) &&
      !restore.restored.includes('artifacts/pre-dirty.json') &&
      restore.preserved.includes('artifacts/pre-dirty.json'),
    `preserved=[${restore.preserved.join(', ')}]`
  )
  check(
    'D4 复核：还原之后不应再有"新增的脏路径"（复核不通过 ⇒ 运行判 FAIL）',
    restore.failed.length === 0,
    `failed=[${restore.failed.join(', ')}]`
  )

  // 恢复段：把环境放回"干净"⇒ 再调一次必须什么都不做
  spawnSync('git', ['checkout', '--', 'artifacts/pre-dirty.json'], { cwd: tmpRepo, stdio: 'ignore' })
  const clean = artifactStatus(tmpRepo)
  const noop = restoreNewlyDirtyArtifacts(tmpRepo, clean)
  check(
    'D4b 恢复：已经干净时调用 ⇒ 什么都不动（restored/deleted 都为空）',
    noop.restored.length === 0 && noop.deleted.length === 0 && noop.failed.length === 0,
    `restored=${noop.restored.length} · deleted=${noop.deleted.length}`
  )
} finally {
  rmSync(tmpRepo, { recursive: true, force: true })
}

// ===========================================================================
// E. 缓存键与可缓存性
// ===========================================================================
section('E. 缓存键（内容键）与可缓存性')

const salt = 'verify-salt'
const realGate = ALL_GATES.find((g) => g.id === 'm4:test')
check(
  'E0 前置：找到一个真实门来做键试验（m4:test）',
  realGate !== undefined,
  realGate === undefined ? 'MEASUREMENT INVALID：找不到 m4:test' : `entry=${realGate.entry ?? '(无)'}`
)

if (realGate !== undefined) {
  const k1 = gateInputKey(REPO_ROOT, realGate, salt)
  const k2 = gateInputKey(REPO_ROOT, realGate, salt)
  check(
    'E1 正控：同一棵树、同一个盐 ⇒ 键相同（且覆盖的文件数 > 0）',
    k1.key === k2.key && k1.filesHashed > 0,
    `files=${k1.filesHashed} · scope=${k1.scope} · key=${k1.key.slice(0, 16)}…（${k1.detail}）`
  )
  /*
   * E1b 的由来（真实踩到）：第一版 `inputClosure` 把 `evals/`/`docs/` 整棵目录
   * **每个提到它的文件都 push 一遍**，于是 reason 里报"闭包 2712 个文件"、
   * 实际去重后只有 352 个。覆盖是对的，但**报出来的数字是灌水的** ——
   * 这正是 §6.8 那一类"看起来量了很多，其实说不清量了什么"。
   * 所以这里把"报出的数字"与"实际哈希的个数"钉在一起。
   */
  check(
    'E1b 负控：报出的覆盖文件数必须与**实际哈希**的个数一致（防止数字灌水）',
    k1.scope !== 'closure' || k1.detail.includes(`去重后 ${k1.filesHashed} 个文件`),
    `detail=「${k1.detail}」· filesHashed=${k1.filesHashed}`
  )

  // 用临时 git 仓库验证"闭包真的会跟着被 import 的文件变"
  const closureRepo = mkdtempSync(join(tmpdir(), 'gate-cache-verify-'))
  try {
    writeFileSync(join(closureRepo, 'dep.ts'), 'export const v = 1\n', 'utf8')
    writeFileSync(join(closureRepo, 'entry.ts'), "import { v } from './dep.ts'\nexport const x = v\n", 'utf8')
    writeFileSync(join(closureRepo, 'unrelated.ts'), 'export const y = 0\n', 'utf8')
    const spec: GateSpec = {
      id: 'synth',
      title: 'synth',
      argv: [process.execPath, 'entry.ts'],
      entry: 'entry.ts',
      resources: { parallel: 'safe' },
    }
    const before = gateInputKey(closureRepo, spec, salt)
    writeFileSync(join(closureRepo, 'dep.ts'), 'export const v = 2\n', 'utf8')
    const afterDep = gateInputKey(closureRepo, spec, salt)
    writeFileSync(join(closureRepo, 'unrelated.ts'), 'export const y = 1\n', 'utf8')
    const afterUnrelated = gateInputKey(closureRepo, spec, salt)

    check(
      'E2 负控：改一个**被闭包覆盖**的依赖 ⇒ 键必须变（漏掉它 = 真红被复用成绿）',
      before.key !== afterDep.key,
      `before=${before.key.slice(0, 12)}… → after=${afterDep.key.slice(0, 12)}…`
    )
    check(
      'E3 正控（粗粒度声明）：改一个**不在闭包内**的文件 ⇒ 键不变（这是允许的过近似，但要显式记录）',
      afterDep.key === afterUnrelated.key,
      '闭包只覆盖 entry.ts + dep.ts；unrelated.ts 不在闭包内'
    )

    writeFileSync(join(closureRepo, 'dynamic.ts'), "import(process.env.X ?? './dep.ts')\n", 'utf8')
    const dyn = inputClosure(closureRepo, 'dynamic.ts')
    check(
      'E4 负控：出现非字面量动态 import ⇒ 闭包必须退化为全仓输入（不许假装知道依赖）',
      dyn.scope === 'repo',
      `scope=${dyn.scope}（${dyn.reason}）`
    )
  } finally {
    rmSync(closureRepo, { recursive: true, force: true })
  }

  check(
    'E5 负控：声明 serial 的门不可缓存',
    cacheability({ ...realGate, resources: { parallel: 'serial' } }, '').ok === false,
    cacheability({ ...realGate, resources: { parallel: 'serial' } }, '').ok === false ? '已拒绝' : '❌ 竟然允许缓存'
  )
  check(
    'E6 负控：真实库相关的门不可缓存（INV-DB-01）',
    cacheability({ ...realGate, resources: { parallel: 'safe', realDb: true } }, '').ok === false,
    '已拒绝'
  )
  check(
    'E7 负控：脚本里引用 data/ 的门不可缓存（输入不在键的覆盖范围内）',
    cacheability({ ...realGate, resources: { parallel: 'safe' } }, "const p='data/x.json'").ok === false,
    '已拒绝'
  )
  check(
    'E8 正控：合法门可缓存',
    cacheability({ ...realGate, resources: { parallel: 'safe' } }, 'const p=1').ok === true,
    '允许缓存（但只复用成功的读数）'
  )
}

// ===========================================================================
// F. Tier 1 的两个部件：离线输入指纹 + 复用判定
// ===========================================================================
section('F. Tier 1（离线段复用）的两个部件')

const treeRepo = mkdtempSync(join(tmpdir(), 'gate-reuse-verify-'))
try {
  mkdirSync(join(treeRepo, 'src'), { recursive: true })
  mkdirSync(join(treeRepo, 'scripts'), { recursive: true })
  mkdirSync(join(treeRepo, 'evals', 'fixtures'), { recursive: true })
  mkdirSync(join(treeRepo, 'evals', 'm4', 'promptfoo'), { recursive: true })
  writeFileSync(join(treeRepo, 'package.json'), '{ "name": "probe" }\n', 'utf8')
  writeFileSync(join(treeRepo, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  writeFileSync(join(treeRepo, 'scripts', 'b.ts'), 'export const b = 1\n', 'utf8')
  writeFileSync(join(treeRepo, 'evals', 'fixtures', 'x.json'), '{}\n', 'utf8')
  writeFileSync(join(treeRepo, 'evals', 'm4', 'promptfoo', 'gen.yaml'), 'seed: 1\n', 'utf8')

  const k0 = sourceTreeKey(treeRepo)
  const k0again = sourceTreeKey(treeRepo)
  check(
    'F1 正控：同一棵树两次采样 ⇒ 指纹相同，且覆盖文件数 > 0',
    k0.key === k0again.key && k0.files > 0,
    `files=${k0.files} · key=${k0.key.slice(0, 16)}…（${k0.detail}）`
  )

  /*
   * F2 是**最关键的一条负控**：`evals/m4/promptfoo/` 是
   * `build-m4-promptfoo-config` 在离线链里**每一步都会重写**的生成物。
   * 第一版把它算进指纹 ⇒ 两步之间的指纹"稳定地变了"，复用永远不成立
   * （判据看起来在工作，实际上永远不会触发 —— 与"没有这个功能"在输出上一样）。
   */
  writeFileSync(join(treeRepo, 'evals', 'm4', 'promptfoo', 'gen.yaml'), 'seed: 2\n', 'utf8')
  const kAfterGenerated = sourceTreeKey(treeRepo)
  check(
    'F2 负控（关键）：改**生成物** evals/m4/promptfoo/** ⇒ 指纹必须**不变**（否则复用永远不成立）',
    kAfterGenerated.key === k0.key,
    kAfterGenerated.key === k0.key ? '指纹未变 ✓' : `❌ 指纹变了：${k0.key.slice(0, 12)}… → ${kAfterGenerated.key.slice(0, 12)}…`
  )

  writeFileSync(join(treeRepo, 'src', 'a.ts'), 'export const a = 2\n', 'utf8')
  const kAfterSrc = sourceTreeKey(treeRepo)
  check(
    'F3 负控：改 `src/**` 下的源码 ⇒ 指纹**必须变**（漏掉它 = 用旧读数冒充新读数）',
    kAfterSrc.key !== k0.key,
    `${k0.key.slice(0, 12)}… → ${kAfterSrc.key.slice(0, 12)}…`
  )

  writeFileSync(join(treeRepo, 'package.json'), '{ "name": "probe2" }\n', 'utf8')
  const kAfterConfig = sourceTreeKey(treeRepo)
  check(
    'F4 负控：改 `package.json`（配置盐）⇒ 指纹**必须变**',
    kAfterConfig.key !== kAfterSrc.key,
    `${kAfterSrc.key.slice(0, 12)}… → ${kAfterConfig.key.slice(0, 12)}…`
  )

  writeFileSync(join(treeRepo, 'scripts', 'b.ts'), 'export const b = 2\n', 'utf8')
  const kAfterScripts = sourceTreeKey(treeRepo)
  check(
    'F5 负控：改 `scripts/**` ⇒ 指纹**必须变**（门自己的实现也在覆盖范围里）',
    kAfterScripts.key !== kAfterConfig.key,
    `${kAfterConfig.key.slice(0, 12)}… → ${kAfterScripts.key.slice(0, 12)}…`
  )
} finally {
  rmSync(treeRepo, { recursive: true, force: true })
}

const steadyKey = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888'

const reusePositive = decideOfflineReuse({
  noReuse: false,
  offlinePassed: true,
  offlineKeyAtRun: steadyKey,
  currentKey: steadyKey,
})
check(
  'F6 正控：四个条件全满足 ⇒ 复用（只跑 smoke）',
  reusePositive.reuse === true,
  reusePositive.reason
)

const reuseNegatives: { name: string; input: Parameters<typeof decideOfflineReuse>[0]; expect: string }[] = [
  {
    name: '传了 --no-reuse-offline',
    input: { noReuse: true, offlinePassed: true, offlineKeyAtRun: steadyKey, currentKey: steadyKey },
    expect: '--no-reuse-offline',
  },
  {
    name: '上一步 m4.5:ci 没成功',
    input: { noReuse: false, offlinePassed: false, offlineKeyAtRun: steadyKey, currentKey: steadyKey },
    expect: '未成功',
  },
  {
    name: '根本没有采到起跑时的指纹',
    input: { noReuse: false, offlinePassed: true, offlineKeyAtRun: undefined, currentKey: steadyKey },
    expect: '没有采到',
  },
  {
    name: '源码树在两步之间变了',
    input: { noReuse: false, offlinePassed: true, offlineKeyAtRun: steadyKey, currentKey: 'ffff0000ffff0000ffff0000' },
    expect: '变了',
  },
]
for (const n of reuseNegatives) {
  const decision = decideOfflineReuse(n.input)
  check(
    `F7 负控：「${n.name}」⇒ **不**复用，且理由说得出来`,
    decision.reuse === false && decision.reason.includes(n.expect),
    `reuse=${String(decision.reuse)} · ${decision.reason}`
  )
}
check(
  'F7b 恢复：把指纹改回一致 ⇒ 重新复用（证明上面那几条不是因为"永远不复用"而通过）',
  decideOfflineReuse({ noReuse: false, offlinePassed: true, offlineKeyAtRun: steadyKey, currentKey: steadyKey })
    .reuse === true,
  'reuse=true'
)

// ===========================================================================
// G. 清单 ↔ `package.json` ↔ 文件系统：三方一致
// ===========================================================================
/*
 * ⚠️ 这一节是 M10 登记册 `U-22` 的落成，它来自一次**真实发生**的缺陷：
 *    `m10:scale:verify` 登记进了清单（`--lane m10` 走清单自己的 argv，**能跑**），
 *    却**忘了加 `package.json` 脚本** ⇒ 文档里写的 `pnpm m10:scale:verify`
 *    报 `Command not found`。
 *
 * 清单文件的注释里早就记过同类（"`argv`/`entry` 的脚本存在性没有任何判据"，
 * M9.5 的一次错别字让门"0.2 秒就失败、看起来像门坏了"）。
 * ⇒ 两者**都要**变成常设判据，而不是"记得手工跑一下"。
 */
section('G. 清单 ↔ package.json ↔ 文件系统')

const pkgScripts: Record<string, string> = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
).scripts as Record<string, string>

/** ① 每个登记的门都要有一条**同名**的 npm 脚本（文档里写的就是它） */
const missingScripts = ALL_GATES.filter((gate) => !(gate.id in pkgScripts)).map((g) => g.id)
check(
  'G1 每个 `GateSpec.id` 都在 `package.json.scripts` 里（否则文档里的命令跑不了）',
  missingScripts.length === 0,
  missingScripts.length === 0
    ? `全部 ${String(ALL_GATES.length)} 道门都有同名脚本`
    : `缺脚本：${missingScripts.join(', ')}`
)

/** ② 每个 `argv` 里出现的仓库内 `.ts` 都要**真的存在**（错别字 = 门坏了） */
const missingFiles: string[] = []
for (const gate of ALL_GATES) {
  for (const arg of gate.argv) {
    if (!arg.endsWith('.ts')) continue
    const rel = arg.replace(/\\/g, '/')
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) continue
    if (!existsSync(join(REPO_ROOT, rel))) missingFiles.push(`${gate.id}→${rel}`)
  }
}
check(
  'G2 每个 `argv` 里的仓库内 `.ts` 都真实存在（错别字会让门"0.2 秒就失败"）',
  missingFiles.length === 0,
  missingFiles.length === 0 ? '全部存在' : `缺文件：${missingFiles.join(', ')}`
)

/** ③ `m10:*` 脚本不得**只存在于 package.json**（那是一条没有任何判据的命令） */
const m10Scripts = Object.keys(pkgScripts).filter((name) => name.startsWith('m10:'))
const gateIds = new Set(ALL_GATES.map((gate) => gate.id))

/**
 * **具名例外**：有 npm 脚本但**有意**不当门。
 *
 * ⚠️ 例外必须**逐条带理由**（M10 WP10 轮次收紧）：第一版是"两条硬编码的探针门"，
 *    那条判据的好处正是**每个例外都被写下来了**。若改成"以某个后缀结尾就放行"，
 *    例外就变成一个**形状**，而形状会被人顺手利用（下次想绕过 G3 只要改个名）。
 */
const M10_SCRIPT_EXCEPTIONS: readonly { id: string; why: string }[] = [
  { id: 'm10:baseline', why: 'WP0 的一次性基线探针（不是可重复的常规门）' },
  { id: 'm10:wp0:admission', why: 'WP0 的一次性准入探针（同上）' },
  {
    id: 'm10:review:score',
    why:
      '**人驱动的审阅工具**：输入是"用户填好的审片文件"，没有那个文件就没有读数 —— ' +
      '跑不起来的命令不能当门；它的**算术**由 `m10:review:materials` 的 `S1`–`S6` 已知答案自证覆盖',
  },

]
const exceptionIds = new Set(M10_SCRIPT_EXCEPTIONS.map((entry) => entry.id))
const orphanM10 = m10Scripts.filter((name) => !gateIds.has(name) && !exceptionIds.has(name))
check(
  'G3 每条 `m10:*` 脚本都在某个 `GateSpec` 里（"有命令但没有门"是一种要命的形状：它没有任何判据）'
    + ` —— 具名例外 ${String(M10_SCRIPT_EXCEPTIONS.length)} 条，每条都有理由`,
  orphanM10.length === 0,
  orphanM10.length === 0
    ? `无孤儿脚本（例外均已具名：${M10_SCRIPT_EXCEPTIONS.map((entry) => entry.id).join(', ')}）`
    : `未登记：${orphanM10.join(', ')}`
)

// ===========================================================================
// 汇总
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
section('汇总')
for (const c of checks) {
  console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`)
}

const measuredEnough = measured > 0
const verdict = !measuredEnough ? 'MEASUREMENT INVALID' : failed.length === 0 ? 'PASS' : 'FAIL'
console.log(
  `\n门执行器自证：${verdict}（检查 ${measured} 项 · 失败 ${failed.length}）` +
    (measuredEnough ? '' : '  ← 检查了 0 项 ⇒ **不是** PASS（§6.8）')
)

const evidencePath = join(REPO_ROOT, 'artifacts', '.fast', 'runner-verification.json')
mkdirSync(join(REPO_ROOT, 'artifacts', '.fast'), { recursive: true })
writeFileSync(
  evidencePath,
  `${JSON.stringify(
    {
      gate: 'gates:verify',
      generatedAt: new Date().toISOString(),
      verdict,
      measuredCount: measured,
      failedCount: failed.length,
      checks: checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.detail })),
      note:
        '三段式自证（§6.7）：A/B 纯逻辑、C 真 spawn 合成门、D 在临时 git 仓库里验还原白名单、E 验缓存键。' +
        'measuredCount=0 ⇒ MEASUREMENT INVALID（§6.8）。本证据落在 artifacts/.fast/（不进 git）。',
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log(`证据：artifacts/.fast/runner-verification.json`)

process.exit(verdict === 'PASS' ? 0 : 1)
