/**
 * 门（gate）执行器的**纯逻辑层** —— 类型、冲突判定、清单校验。
 *
 * ============================================================================
 *  为什么把它和"真的去 spawn 进程"分开
 * ============================================================================
 * 并行是**唯一一种"看起来在正常工作"却可能让读数失真的加速方式**：
 *   · 两个门同时写同一个证据文件 ⇒ 后写的覆盖先写的，判决读到半份数据；
 *   · 两个门抢同一个固定端口 ⇒ 一个门静默失败或连到了另一个门的服务；
 *   · 两个门同时开真实库 ⇒ 违反 `INV-DB-01`（跨进程单持有）；
 *   · 一个门在 `git checkout` 冻结证据、另一个门正在读它 ⇒ 读到"中间态"。
 *
 * 因此"哪些门可以同时跑"这条判断必须是**纯函数**，才能被
 * 「正控 / 负控 / 恢复」三段式直接测（`AGENTS.md` §6.7）——
 * 只做正控的调度器与"什么都不检查"在输出上无法区分。
 *
 * 本文件**不碰文件系统、不 spawn 任何东西**。
 */

/** 一个门的并行类别。**必须显式声明**：缺声明按"不可并行"处理（失败关闭）。 */
export type ParallelClass = 'safe' | 'serial'

/** 运行档位。`release` = 发布档（串行、不缓存、保留证据）；`fast` = 快车道。 */
export type RunMode = 'release' | 'fast'

export interface GateResources {
  /**
   * 这道门的并行安全性。
   *   'safe'   —— 只用自己的沙箱/临时目录，只写自己那一个证据文件，不占固定端口，
   *               不改 git 工作树，不碰真实库 ⇒ 可以与其他 `safe` 门同时跑。
   *   'serial' —— 上述任一条不成立，或**任何不确定**的情形（宁可串行）。
   */
  parallel: ParallelClass
  /**
   * 这道门**会写**的证据路径（仓库相对路径；可以是文件也可以是目录）。
   * 两条用途：① 同时跑的两道门若路径重叠 ⇒ 判为冲突；② 快车道跑完用它做还原白名单。
   */
  evidenceWrites?: readonly string[]
  /** 是否触碰真实库（租约 / `data/pglite` / 真实库路径判定）。为真 ⇒ 只允许串行且永不缓存。 */
  realDb?: boolean
  /** 占用的固定端口（同端口的两道门不得同时跑）。 */
  ports?: readonly number[]
  /** 独占的临时/沙箱键（键相同表示共享同一 scratch 目录 ⇒ 冲突）。 */
  scratchKey?: string
  /** 是否会改写 git 工作树（例如 `git checkout --` 冻结证据）。 */
  mutatesGitWorktree?: boolean
}

export interface GateSpec {
  /** 稳定 id。优先用 `package.json` 里的脚本名（例如 `m4:verify`）。 */
  id: string
  /** 人读的标题（中文，和现有门的措辞保持一致）。 */
  title: string
  /** 完整 argv（argv[0] = 可执行文件）。**等价于** `package.json` 里那条脚本。 */
  argv: readonly string[]
  /** 入口脚本（仓库相对路径）。用于近似算"这道门的输入闭包"（缓存键）。缺省 ⇒ 按全仓输入处理。 */
  entry?: string
  /** 必须先成功的门。用于表达"读别人的证据"这类真实顺序（不是资源冲突）。 */
  dependsOn?: readonly string[]
  /** 分类标签（`offline` / `summaries` / `live` / `m6` …）。 */
  tags?: readonly string[]
  /**
   * 除 0 之外**也算通过**的退出码。
   *
   * 为什么需要它：有几道汇总门**按设计**非零（例如 `inc-01:gates` 在首次真实快照
   * 授权前会如实报"有门未运行"）。把它当失败会让运行器把"如实降档"读成红 ——
   * 但它也**不能**被静默忽略：所以要求**逐条显式登记**（与 `inc-01-regression.ts` 的
   * `expectZero:false` + `knownNonZeroBecause` 同一纪律），并且理由必须写进 `why`。
   */
  acceptExitCodes?: readonly number[]
  resources: GateResources
  /** 为什么把它判成这个并行类别（写给下一个人看，也是复核判据的入口）。 */
  why?: string
}

/** 两条门之间的资源冲突。`reason` 是机器可读的稳定标识。 */
export interface Conflict {
  reason:
    | 'declared-serial'
    | 'missing-declaration'
    | 'real-db-single-holder'
    | 'port-overlap'
    | 'evidence-overlap'
    | 'scratch-overlap'
    | 'git-worktree-mutation'
  detail: string
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 两条路径是否重叠（相等 / 互为父子目录）。 */
export function pathsOverlap(a: string, b: string): boolean {
  const x = normalizePath(a)
  const y = normalizePath(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

function overlapPaths(a: readonly string[], b: readonly string[]): string | undefined {
  for (const x of a) {
    for (const y of b) {
      if (pathsOverlap(x, y)) return `${x} ∩ ${y}`
    }
  }
  return undefined
}

/** 门是否可并行。缺声明 ⇒ **不是**（失败关闭）。 */
export function isParallelSafe(spec: GateSpec): boolean {
  return spec.resources?.parallel === 'safe'
}

/**
 * 两条门能否**同时**在跑。返回 `undefined` = 可以。
 *
 * 判定顺序是稳定的（便于负控断言"它是因为正确的那条理由被串行的"）。
 */
export function conflictBetween(a: GateSpec, b: GateSpec): Conflict | undefined {
  if (a.id === b.id) return { reason: 'declared-serial', detail: `${a.id} 与自己` }

  // ① 缺声明：失败关闭。宁可串行，也不猜。
  const undeclared = [a, b].filter((s) => s.resources?.parallel !== 'safe' && s.resources?.parallel !== 'serial')
  if (undeclared.length > 0) {
    return {
      reason: 'missing-declaration',
      detail: `${undeclared.map((s) => s.id).join(', ')} 没有声明 resources.parallel ⇒ 按不可并行处理（失败关闭）`,
    }
  }

  // ② 任一方显式声明串行 ⇒ 它与任何门都不同时跑。
  const serial = [a, b].filter((s) => s.resources.parallel === 'serial')
  if (serial.length > 0) {
    return {
      reason: 'declared-serial',
      detail: `${serial.map((s) => s.id).join(', ')} 声明了 parallel='serial'（${serial[0]?.why ?? '未写理由'}）`,
    }
  }

  // ③ 真实库是跨进程单持有资源（INV-DB-01）。
  if (a.resources.realDb === true && b.resources.realDb === true) {
    return { reason: 'real-db-single-holder', detail: `${a.id} 与 ${b.id} 都要真实库` }
  }

  // ④ 固定端口。
  const aPorts = a.resources.ports ?? []
  const bPorts = b.resources.ports ?? []
  const sharedPort = aPorts.find((p) => bPorts.includes(p))
  if (sharedPort !== undefined) {
    return { reason: 'port-overlap', detail: `端口 ${sharedPort}：${a.id} ∩ ${b.id}` }
  }

  // ⑤ 证据文件重叠（同文件或父子目录）。
  const sharedPath = overlapPaths(a.resources.evidenceWrites ?? [], b.resources.evidenceWrites ?? [])
  if (sharedPath !== undefined) {
    return { reason: 'evidence-overlap', detail: sharedPath }
  }

  // ⑥ 共享 scratch/沙箱目录。
  const ka = a.resources.scratchKey
  const kb = b.resources.scratchKey
  if (ka !== undefined && ka !== '' && ka === kb) {
    return { reason: 'scratch-overlap', detail: `scratchKey=${ka}` }
  }

  // ⑦ 改写 git 工作树 ⇒ 与任何同时读工作树的门冲突。
  if (a.resources.mutatesGitWorktree === true || b.resources.mutatesGitWorktree === true) {
    const who = a.resources.mutatesGitWorktree === true ? a.id : b.id
    return { reason: 'git-worktree-mutation', detail: `${who} 会改写工作树` }
  }

  return undefined
}

export interface ManifestProblem {
  id: string
  problem: string
}

/**
 * 清单自检。任何一条问题 ⇒ 调用方必须**拒绝运行**（而不是挑着跑）。
 *
 * 覆盖：id 唯一 / argv 非空 / 并行类别必须显式 / 依赖存在 / 无环 /
 *       证据路径不得逃出仓库。
 */
export function validateManifest(specs: readonly GateSpec[]): ManifestProblem[] {
  const problems: ManifestProblem[] = []
  const byId = new Map<string, GateSpec>()

  for (const spec of specs) {
    if (spec.id === '') problems.push({ id: spec.id, problem: 'id 为空' })
    if (byId.has(spec.id)) problems.push({ id: spec.id, problem: 'id 重复' })
    byId.set(spec.id, spec)
    if (spec.argv.length === 0 || spec.argv[0] === '') {
      problems.push({ id: spec.id, problem: 'argv 为空' })
    }
    if (spec.resources?.parallel !== 'safe' && spec.resources?.parallel !== 'serial') {
      problems.push({ id: spec.id, problem: 'resources.parallel 必须显式声明 safe / serial' })
    }
    for (const p of spec.resources?.evidenceWrites ?? []) {
      if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
        problems.push({ id: spec.id, problem: `evidenceWrites 必须是仓库相对路径：${p}` })
      }
      if (p.split(/[\\/]/).includes('..')) {
        problems.push({ id: spec.id, problem: `evidenceWrites 不得逃出仓库：${p}` })
      }
    }
  }

  for (const spec of specs) {
    for (const dep of spec.dependsOn ?? []) {
      if (!byId.has(dep)) problems.push({ id: spec.id, problem: `dependsOn 指向不存在的门：${dep}` })
      if (dep === spec.id) problems.push({ id: spec.id, problem: 'dependsOn 指向自己' })
    }
  }

  // 依赖环（DFS 三色）。有环 ⇒ 永远没有"可以启动"的门 ⇒ 必须拒绝运行。
  const state = new Map<string, 0 | 1 | 2>()
  const visit = (id: string, trail: string[]): void => {
    const s = state.get(id) ?? 0
    if (s === 1) {
      problems.push({ id, problem: `依赖环：${[...trail, id].join(' → ')}` })
      return
    }
    if (s === 2) return
    state.set(id, 1)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep)) visit(dep, [...trail, id])
    }
    state.set(id, 2)
  }
  for (const spec of specs) visit(spec.id, [])

  return problems
}

/**
 * 一个门集合在给定并发上限下的**冲突图**（只用于报告与自证，不参与调度决策本身）。
 * 返回两两冲突的对数，便于"这道门为什么没能和那道门并行"这类追问。
 */
export function conflictPairs(specs: readonly GateSpec[]): { a: string; b: string; conflict: Conflict }[] {
  const out: { a: string; b: string; conflict: Conflict }[] = []
  for (let i = 0; i < specs.length; i += 1) {
    for (let j = i + 1; j < specs.length; j += 1) {
      const a = specs[i]
      const b = specs[j]
      if (a === undefined || b === undefined) continue
      const conflict = conflictBetween(a, b)
      if (conflict !== undefined) out.push({ a: a.id, b: b.id, conflict })
    }
  }
  return out
}
