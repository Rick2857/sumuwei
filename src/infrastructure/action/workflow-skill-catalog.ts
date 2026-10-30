/**
 * P3 —— **技能目录资产加载器**（基础设施层，只读）。
 *
 * ============================================================================
 *  它证明的是"资产没有被动过"，不是"技能已经可用"
 * ============================================================================
 * ```text
 * ① 目录 JSON 形状/语义（`parseWorkflowSkillCatalog` 闭集校验）
 * ② 每个版本声明的 `contentFingerprint` == **实测** SKILL.md 字节 sha256
 * ③ 旧 `manifest.json`（ADR-119）与目录的迁移映射**逐字一致**
 *    —— 不一致 ⇒ 失败关闭，而不是"两个指纹取一个"
 * ④ 目录整体摘要（catalogDigest）由规范 JSON 算出，写进发布状态登记
 * ```
 * ⚠️ 可用性（发布状态 / 当前版本 / 依赖求交）**不在这里判**：那需要持久层，
 *    在 `createManagedWorkflowSkillAdapter()` 里按请求逐次判（状态可能在两轮之间被挂起）。
 *
 * ⚠️ 本文件不做 I/O 之外的判断；它不读数据库、不读环境变量、不写任何文件。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import {
  canonicalJson,
  parseWorkflowSkillCatalog,
  type WorkflowSkillCatalog,
  type WorkflowSkillCatalogCode,
  type WorkflowSkillRelease,
} from '../../kernel/contracts/workflow-skill-catalog.ts'

const DEFAULT_SKILL_ROOT = fileURLToPath(new URL('../../../resources/workflow-skills/', import.meta.url))

/** 旧流程包允许的最大说明长度（与 `loadWorkflowSkills()` 逐字相同：1800）。 */
export const WORKFLOW_SKILL_INSTRUCTIONS_MAX = 1800

export interface LoadedWorkflowSkillRelease {
  readonly release: WorkflowSkillRelease
  /** SKILL.md 去掉 frontmatter 后的正文（= 进 prompt 的受信说明） */
  readonly instructions: string
}

export interface LoadedWorkflowSkillCatalog {
  readonly catalog: WorkflowSkillCatalog
  /** 规范 JSON（含各版本 releaseDigest）的 sha256 */
  readonly catalogDigest: string
  /** `skillId@version` → 已核对的版本资产 */
  readonly releases: ReadonlyMap<string, LoadedWorkflowSkillRelease>
  /** 旧 manifest 中登记过、且与目录核对一致的技能 id（迁移映射登记） */
  readonly migratedSkillIds: readonly string[]
}

export type WorkflowSkillCatalogAssetCode =
  | 'catalog_asset_missing'
  | 'catalog_json_invalid'
  | 'catalog_parse_failed'
  | 'catalog_content_missing'
  | 'catalog_content_fingerprint_mismatch'
  | 'catalog_content_size_invalid'
  | 'catalog_legacy_manifest_invalid'
  | 'catalog_legacy_manifest_mismatch'

export type LoadWorkflowSkillCatalogResult =
  | { readonly ok: true; readonly loaded: LoadedWorkflowSkillCatalog }
  | {
      readonly ok: false
      readonly code: WorkflowSkillCatalogAssetCode
      readonly detail: string
      /** 目录解析失败时的**闭集**子码（便于门逐条断言） */
      readonly parseCode?: WorkflowSkillCatalogCode
    }

export interface LoadWorkflowSkillCatalogOptions {
  /** 资产根（缺省 = 仓库 `resources/workflow-skills/`；门可指向临时目录） */
  readonly root?: string
  /** 缺省读取同目录 `manifest.json`；显式传 null ⇒ 跳过旧 manifest 核对（只给结构门用） */
  readonly legacyManifestPath?: string | null
}

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 与旧 `loadWorkflowSkills()` 逐字相同的 frontmatter 剥离规则。 */
function instructionsOf(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
}

export function loadWorkflowSkillCatalog(
  options: LoadWorkflowSkillCatalogOptions = {}
): LoadWorkflowSkillCatalogResult {
  const root = options.root ?? DEFAULT_SKILL_ROOT
  const catalogPath = resolve(root, 'catalog.json')

  let rawText: string
  try {
    rawText = readFileSync(catalogPath, 'utf8')
  } catch {
    return { ok: false, code: 'catalog_asset_missing', detail: `读不到 ${catalogPath}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch (error) {
    return {
      ok: false,
      code: 'catalog_json_invalid',
      detail: `catalog.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const parsed = parseWorkflowSkillCatalog(raw)
  if (!parsed.ok) {
    return { ok: false, code: 'catalog_parse_failed', detail: parsed.detail, parseCode: parsed.code }
  }

  /*
   * 旧 manifest 的迁移映射核对（ADR-119 / plan §3 约束 6）。
   *
   * ⚠️ 它证明的是"目录里的内容指纹与旧清单登记的那一个**逐字相同**"。
   *    反过来**不**成立：目录新增的元数据（适用说明 / 所需能力 / 输入边界 /
   *    结果核验契约）**不在**旧内容指纹覆盖范围内 —— 它们由 releaseDigest 覆盖。
   */
  const legacyManifestPath = options.legacyManifestPath === undefined
    ? resolve(root, 'manifest.json')
    : options.legacyManifestPath
  let legacyManifest: Record<string, string> = {}
  if (legacyManifestPath !== null) {
    try {
      const parsedManifest: unknown = JSON.parse(readFileSync(legacyManifestPath, 'utf8'))
      if (parsedManifest === null || typeof parsedManifest !== 'object' || Array.isArray(parsedManifest)) {
        return { ok: false, code: 'catalog_legacy_manifest_invalid', detail: 'manifest.json 必须是对象' }
      }
      for (const [key, value] of Object.entries(parsedManifest as Record<string, unknown>)) {
        if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
          return {
            ok: false,
            code: 'catalog_legacy_manifest_invalid',
            detail: `manifest.json 的 ${key} 不是 64 位小写 hex`,
          }
        }
        legacyManifest[key] = value
      }
    } catch {
      return { ok: false, code: 'catalog_legacy_manifest_invalid', detail: `读不到 ${legacyManifestPath}` }
    }
  }

  const releases = new Map<string, LoadedWorkflowSkillRelease>()
  const migratedSkillIds: string[] = []
  for (const skill of parsed.catalog.skills) {
    const legacyFingerprint = legacyManifest[skill.skillId]
    if (legacyFingerprint !== undefined) migratedSkillIds.push(skill.skillId)
    for (const release of skill.releases) {
      const contentPath = resolve(root, release.contentPath)
      let buffer: Buffer
      try {
        buffer = readFileSync(contentPath)
      } catch {
        return {
          ok: false,
          code: 'catalog_content_missing',
          detail: `读不到 ${release.contentPath}（${skill.skillId}@${String(release.version)}）`,
        }
      }
      const actualFingerprint = sha256(buffer)
      if (actualFingerprint !== release.contentFingerprint) {
        return {
          ok: false,
          code: 'catalog_content_fingerprint_mismatch',
          detail:
            `${release.contentPath} 实际 sha256=${actualFingerprint}` +
            `，目录登记=${release.contentFingerprint}（内容被改而版本号未变）`,
        }
      }
      const instructions = instructionsOf(buffer.toString('utf8'))
      if (instructions.length === 0 || instructions.length > WORKFLOW_SKILL_INSTRUCTIONS_MAX) {
        return {
          ok: false,
          code: 'catalog_content_size_invalid',
          detail: `${skill.skillId}@${String(release.version)} 的说明长度 ${String(instructions.length)} 不在 1..${String(WORKFLOW_SKILL_INSTRUCTIONS_MAX)}`,
        }
      }
      /*
       * 旧 manifest 的迁移映射只约束 **version 1**（ADR-119 的既有内容身份）。
       * 候选/修订版本（v≥2）**不在**旧清单里：它们的内容身份由 catalog 自己的
       * contentFingerprint + releaseDigest 覆盖，不能被"旧指纹"冒充。
       */
      if (release.version === 1 && legacyFingerprint !== undefined && legacyFingerprint !== release.contentFingerprint) {
        return {
          ok: false,
          code: 'catalog_legacy_manifest_mismatch',
          detail:
            `${skill.skillId}@${String(release.version)} 的内容指纹与旧 manifest 不一致` +
            `（目录=${release.contentFingerprint}，manifest=${legacyFingerprint}）`,
        }
      }
      releases.set(`${skill.skillId}@${String(release.version)}`, { release, instructions })
    }
  }

  return {
    ok: true,
    loaded: {
      catalog: parsed.catalog,
      catalogDigest: sha256(canonicalJson(parsed.catalog)),
      releases,
      migratedSkillIds: migratedSkillIds.sort(),
    },
  }
}

/** 目录里某技能的**当前版本**资产（没有 ⇒ undefined；不判状态）。 */
export function currentLoadedRelease(
  loaded: LoadedWorkflowSkillCatalog,
  skillId: string
): LoadedWorkflowSkillRelease | undefined {
  const skill = loaded.catalog.skills.find((item) => item.skillId === skillId)
  if (skill === undefined) return undefined
  return loaded.releases.get(`${skillId}@${String(skill.currentVersion)}`)
}

/** 按版本取资产（门与"回退到旧版本"的读取用）。 */
export function loadedReleaseOf(
  loaded: LoadedWorkflowSkillCatalog,
  skillId: string,
  version: number
): LoadedWorkflowSkillRelease | undefined {
  return loaded.releases.get(`${skillId}@${String(version)}`)
}
