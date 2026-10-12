/**
 * sandbox-filesystem —— M4.5 唯一的真实副作用适配器（§15 / §17）。
 *
 * ============================================================================
 *  "沙箱"在这里是一个**路径约束**，不是一个虚拟机
 * ============================================================================
 * 进程内、无 shell、无网络。能做的只有两件事：
 *
 * ```text
 * sandbox.file.read    读沙箱根内的一个文件
 * sandbox.file.write   在沙箱根内创建/覆盖一个文件
 * ```
 *
 * 三道守卫，缺一不可：
 *
 *   1. **语法守卫**（`target-resolver.ts`）：绝对路径 / 盘符 / `..` / NUL
 *      在任何 IO 之前就被否掉 —— 越界永远不会变成一次真实的文件系统访问
 *   2. **包含性守卫**（本文件）：`realpath` 之后再比较，
 *      防止**符号链接**把路径引到根之外（语法检查看不见 symlink）
 *   3. **大小守卫**：读 256KB / 写 64KB 上限，防止一次动作把内存撑爆
 *
 * ⚠️ 沙箱根由**装配层**注入（`ACTION_SANDBOX_ROOT`），适配器不自己推导。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import type { AdapterExecuteInput, AdapterOutcome, CapabilityAdapter } from '../../../kernel/action/executor-port.ts'
import type { PayloadStagingPort } from '../../../kernel/action/payload-staging.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import { SANDBOX_FILE_READ, SANDBOX_FILE_WRITE } from '../../../kernel/action/capability-registry.ts'
import type { SandboxEntry } from '../../../kernel/action/target-resolver.ts'
import { fnv1a64Hex } from '../../../kernel/action/idempotency.ts'

export const DEFAULT_MAX_READ_BYTES = 256 * 1024
export const DEFAULT_MAX_WRITE_BYTES = 64 * 1024
/** 目标解析时最多枚举多少个条目（防止一个巨大的沙箱把解析拖死） */
export const DEFAULT_MAX_ENTRIES = 2000

export interface SandboxFilesystemOptions {
  /** 沙箱根（绝对路径，可以由相对路径解析而来） */
  root: string
  maxReadBytes?: number
  maxWriteBytes?: number
  maxEntries?: number
  /**
   * 私有暂存端口（**可选**：装了它，写入就同时接受执行环改写后的 `payloadRef`）。
   *
   * ⚠️ 缺省 `undefined` ⇒ 只认字面 `content`（旧行为逐字不变）。
   * ⚠️ 装配层必须传**与执行环同一个实例**（先例：`spec_not_staged` 生产缺陷
   *    —— 两处各建一个暂存，写的时候取不到）。
   */
  staging?: PayloadStagingPort
}

/**
 * 把沙箱相对路径解析成**根内**的绝对路径。
 *
 * 越界时抛 `permission_denied`（而不是 `not_found`）：
 * 对用户而言"我不被允许"与"它不存在"是**不同**的信息（ADR-032）。
 */
export async function resolveSandboxPath(
  options: SandboxFilesystemOptions,
  relativePath: string
): Promise<string> {
  const rootAbs = resolve(options.root)
  const candidate = resolve(rootAbs, relativePath)

  // 第一层：纯字符串包含性（不依赖文件系统）
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + sep)) {
    throw new ActionFailureError(
      actionFailure('permission_denied', `路径越出沙箱根：${relativePath}`)
    )
  }

  /*
   * 第二层：realpath 之后再比较。
   *
   * 语法检查看不见 symlink —— 沙箱里一个指向 C:\Users 的链接
   * 会让"根内"的路径真的读到根外的文件。因此这里对**已存在**的部分
   * 做一次 realpath 并重新比较。
   */
  const rootReal = existsSync(rootAbs) ? await realpath(rootAbs) : rootAbs
  const candidateReal = existsSync(candidate) ? await realpath(candidate) : await realpathOfParent(candidate)
  if (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + sep)) {
    throw new ActionFailureError(
      actionFailure('permission_denied', `路径经符号链接越出沙箱根：${relativePath}`)
    )
  }

  return candidate
}

/** 目标还不存在（新建）时，检查它**最近的已存在祖先**是否在根内 */
async function realpathOfParent(candidate: string): Promise<string> {
  const parent = dirname(candidate)
  if (parent === candidate) return candidate
  if (existsSync(parent)) return realpath(parent)
  return realpathOfParent(parent)
}

/**
 * 枚举沙箱内的条目（供 TargetResolver 使用）。
 *
 * ⚠️ 它只列**相对路径与名字**，不读内容 —— 目标解析不需要内容，
 *    而"读内容"是适配器在执行阶段才做的事。
 */
export async function listSandboxEntries(
  options: SandboxFilesystemOptions
): Promise<readonly SandboxEntry[]> {
  const rootAbs = resolve(options.root)
  if (!existsSync(rootAbs)) return []
  const max = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const out: SandboxEntry[] = []

  async function walk(dir: string, prefix: string): Promise<void> {
    if (out.length >= max) return
    const dirents = await readdir(dir, { withFileTypes: true })
    for (const entry of dirents) {
      if (out.length >= max) return
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relative)
      } else if (entry.isFile()) {
        out.push({ relativePath: relative, basename: entry.name })
      }
    }
  }

  await walk(rootAbs, '')
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

/** 内容指纹（"外部状态真的变了吗"的机器判据） */
export function contentFingerprint(text: string): string {
  return fnv1a64Hex(text)
}

export function createSandboxReadAdapter(options: SandboxFilesystemOptions): CapabilityAdapter {
  const maxRead = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES
  return {
    capabilityId: SANDBOX_FILE_READ,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const absolute = await resolveSandboxPath(options, pathOf(input))
      const info = await stat(absolute)
      if (!info.isFile()) {
        throw new ActionFailureError(
          actionFailure('target_not_found', `目标是目录，不是文件：${pathOf(input)}`)
        )
      }
      if (info.size > maxRead) {
        throw new ActionFailureError(
          actionFailure('validation_failed', `文件超过读取上限 ${maxRead} 字节：${info.size}`)
        )
      }
      // 读不到就让 fs 的错误抛出去（ENOENT → target_not_found，见 errors.ts 的归一）
      const content = await readFile(absolute, 'utf8')
      return {
        effect: {
          kind: 'content_read',
          detail: `读取 ${pathOf(input)}（${Buffer.byteLength(content, 'utf8')} 字节）`,
          fingerprint: contentFingerprint(content),
          bytes: Buffer.byteLength(content, 'utf8'),
        },
        evidence: [
          { kind: 'filesystem', detail: `读自沙箱内 ${pathOf(input)}`, ref: pathOf(input) },
        ],
      }
    },
  }
}

/**
 * 沙箱写入：**同时接受字面 `content` 与执行环改写后的暂存引用**（`payloadRef`）。
 *
 * ============================================================================
 *  为什么必须两条路都认（用户 2026-10-05 裁定：`L-RTD-17` 按推荐方案修）
 * ============================================================================
 * ```text
 * 任务执行环把计划里的 `content` **换成** `payloadRef` / `payloadBytes` /
 * `payloadFingerprint`（`TASK_STAGED_ARG_KEYS` —— 账本里永远只有引用，正文不进账本）。
 * 而在那之前，本适配器**只认字面 `content`** ⇒ 角色自选工具那条路上，
 * `sandbox.file.write` **永远**以 `validation_failed`（"缺少 content 参数"）结束：
 * 能力登记了、能被选中、也真的进了授权集合，却**写不了任何东西**。
 *
 * 修法与 `local.file.write` **逐字同形**（复用同一份 `PayloadStagingPort` 语义）：
 *   ① 有 `payloadRef` ⇒ 从**私有暂存**取回载荷（取不到就如实拒绝，绝不写空文件）
 *   ② 否则回落到字面 `content`（旧行为**逐字不变** ⇒ 既有调用点与全部旧断言不受影响）
 * ```
 * ⚠️ 大小上限对两条路一视同仁；指纹仍按**最终写下去的字节**算。
 * ⚠️ 这**不是**权限放开：域仍是动作沙箱根（`options.root`），风险等级、策略、
 *    目标解析一个字节都没动 —— 变的只是"正文怎么递进来"。
 */
export function createSandboxWriteAdapter(options: SandboxFilesystemOptions): CapabilityAdapter {
  const maxWrite = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES
  const rootAbs = resolve(options.root)
  return {
    capabilityId: SANDBOX_FILE_WRITE,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const relative = pathOf(input)
      /*
       * 优先级刻意是"暂存引用优先"：执行环给出 `payloadRef` 时，`content` 已经**不在** args 里
       * （被改写了），因此两条不会同时出现；万一同时出现，引用是更具体、更可能是本意的那一个。
       */
      const payloadRef = stringArg(input.args, 'payloadRef')
      let content: string | undefined
      if (payloadRef !== undefined) {
        const staging = options.staging
        if (staging === undefined) {
          throw new ActionFailureError(
            actionFailure(
              'validation_failed',
              `这一步带的是暂存引用 ${payloadRef}，但本适配器没有装暂存端口 —— 装配错误，不是用户错误`
            )
          )
        }
        const staged = staging.read(payloadRef)
        if (staged === undefined) {
          throw new ActionFailureError(
            actionFailure(
              'validation_failed',
              `载荷 ${payloadRef} 不在私有暂存里（过期或从未放入）—— 拒绝凭引用写一个取不到内容的文件`
            )
          )
        }
        content = staged.kind === 'text' ? staged.text : staged.kind === 'base64' ? staged.base64 : staged.json
      } else {
        content = stringArg(input.args, 'content')
      }
      if (content === undefined) {
        throw new ActionFailureError(
          actionFailure('validation_failed', '写文件缺少 content 参数，不知道要写什么')
        )
      }
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > maxWrite) {
        throw new ActionFailureError(
          actionFailure('validation_failed', `内容超过写入上限 ${maxWrite} 字节：${bytes}`)
        )
      }

      const absolute = await resolveSandboxPath(options, relative)
      const existed = existsSync(absolute)
      await mkdir(rootAbs, { recursive: true })
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, content, 'utf8')

      return {
        effect: {
          kind: existed ? 'file_overwritten' : 'file_created',
          detail: `${existed ? '覆盖' : '创建'} ${relative}（${bytes} 字节）`,
          fingerprint: contentFingerprint(content),
          bytes,
        },
        evidence: [
          {
            kind: 'filesystem',
            detail: `写入沙箱内 ${relative}`,
            ref: relative,
          },
        ],
      }
    },
  }
}

function pathOf(input: AdapterExecuteInput): string {
  const canonical = input.target.canonicalId
  if (canonical !== undefined && canonical !== '') return canonical
  const fromArgs = stringArg(input.args, 'path')
  if (fromArgs !== undefined && fromArgs !== '') return fromArgs
  throw new ActionFailureError(
    actionFailure('validation_failed', '适配器没有拿到路径：目标与参数里都没有 path')
  )
}
