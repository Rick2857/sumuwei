/**
 * P3-3 —— **修订候选 / 冻结验证集资产加载器**（基础设施层，只读）。
 *
 * ============================================================================
 *  它核对什么（不够成"这个候选可以发布"，只回答"资产自洽"）
 * ============================================================================
 * ```text
 * ① revisions.json 形状（`parseRevisionRegistry` 闭集）
 * ② 冻结验证集：`frozen/` 下每份 JSON（`parseVerificationSet`，含自校验 specDigest）
 * ③ 提议 ↔ 目录：候选版本**在目录里**、`initialState=candidate`、
 *    `release.predecessorVersion === proposal.parentVersion`（只核**两个登记值彼此一致**）
 * ④ 提议 ↔ 验证集：dev/holdout setId 都真实存在、kind 正确、skillId 一致、两集**不相交**
 * ```
 * ⚠️ "能不能发布"**不在这里判**：那需要持久层状态 + 验证包 + 历史
 *    （`workflow-skill-revision-publisher.ts` 组合 kernel 纯判定）。
 * ⚠️ "父版本是不是**此刻**的当前版本"也**不在这里判**：资产里的 `catalog.currentVersion`
 *    只是登记种子，运行期当前版本以持久层 `isCurrent` 为准（否则候选永远被判 stale）。
 *
 * ⚠️ 本文件不读数据库、不写任何文件；`root` 可指向临时目录（门里的负控候选）。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import {
  assertSetsAreDisjoint,
  parseRevisionRegistry,
  parseVerificationSet,
  type WorkflowSkillRevisionProposal,
  type WorkflowSkillRevisionRegistry,
  type WorkflowSkillVerificationSet,
} from '../../kernel/contracts/workflow-skill-revision.ts'
import { loadWorkflowSkillCatalog, type LoadedWorkflowSkillCatalog } from './workflow-skill-catalog.ts'

const DEFAULT_ROOT = fileURLToPath(new URL('../../../resources/workflow-skills/', import.meta.url))

export interface LoadedWorkflowSkillRevisionAssets {
  readonly catalog: LoadedWorkflowSkillCatalog
  readonly registry: WorkflowSkillRevisionRegistry
  readonly sets: ReadonlyMap<string, WorkflowSkillVerificationSet>
}

export type RevisionAssetCode =
  | 'catalog_asset_failed'
  | 'revisions_asset_missing'
  | 'revisions_json_invalid'
  | 'revisions_parse_failed'
  | 'frozen_dir_missing'
  | 'frozen_json_invalid'
  | 'frozen_parse_failed'
  | 'frozen_duplicate_set_id'
  | 'proposal_candidate_not_in_catalog'
  | 'proposal_candidate_not_candidate_state'
  | 'proposal_parent_mismatch'
  | 'proposal_dev_set_missing'
  | 'proposal_holdout_set_missing'
  | 'proposal_set_kind_invalid'
  | 'proposal_sets_overlap'

export type LoadRevisionAssetsResult =
  | { readonly ok: true; readonly loaded: LoadedWorkflowSkillRevisionAssets }
  | {
      readonly ok: false
      readonly code: RevisionAssetCode
      readonly detail: string
      /** 目录/登记/验证集解析失败的**闭集子码**（门逐条断言用） */
      readonly subCode?: string
    }

export interface LoadRevisionAssetsOptions {
  readonly root?: string
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; detail: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) as unknown }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

export function loadWorkflowSkillRevisionAssets(
  options: LoadRevisionAssetsOptions = {}
): LoadRevisionAssetsResult {
  const root = options.root ?? DEFAULT_ROOT
  const catalogResult = loadWorkflowSkillCatalog({ root })
  if (!catalogResult.ok) {
    return {
      ok: false,
      code: 'catalog_asset_failed',
      detail: catalogResult.detail,
      subCode: catalogResult.code,
    }
  }
  const catalog = catalogResult.loaded

  const revisionsPath = resolve(root, 'revisions.json')
  const revisionsRaw = readJson(revisionsPath)
  if (!revisionsRaw.ok) {
    return { ok: false, code: 'revisions_asset_missing', detail: `读不到 ${revisionsPath}：${revisionsRaw.detail}` }
  }
  const registryResult = parseRevisionRegistry(revisionsRaw.value)
  if (!registryResult.ok) {
    return {
      ok: false,
      code: 'revisions_parse_failed',
      detail: registryResult.detail,
      subCode: registryResult.code,
    }
  }
  const registry = registryResult.registry

  const frozenDir = resolve(root, 'frozen')
  let frozenFiles: string[]
  try {
    frozenFiles = readdirSync(frozenDir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return { ok: false, code: 'frozen_dir_missing', detail: `读不到冻结验证集目录 ${frozenDir}` }
  }
  const sets = new Map<string, WorkflowSkillVerificationSet>()
  for (const name of frozenFiles) {
    const raw = readJson(resolve(frozenDir, name))
    if (!raw.ok) return { ok: false, code: 'frozen_json_invalid', detail: `${name}：${raw.detail}` }
    const parsed = parseVerificationSet(raw.value)
    if (!parsed.ok) {
      return { ok: false, code: 'frozen_parse_failed', detail: `${name}：${parsed.detail}`, subCode: parsed.code }
    }
    if (sets.has(parsed.set.setId)) {
      return { ok: false, code: 'frozen_duplicate_set_id', detail: `重复的验证集 id：${parsed.set.setId}` }
    }
    sets.set(parsed.set.setId, parsed.set)
  }

  for (const proposal of registry.proposals) {
    const skill = catalog.catalog.skills.find((item) => item.skillId === proposal.skillId)
    const candidate = skill?.releases.find((release) => release.version === proposal.version)
    if (skill === undefined || candidate === undefined) {
      return {
        ok: false,
        code: 'proposal_candidate_not_in_catalog',
        detail: `${proposal.skillId}@${String(proposal.version)} 不在目录里`,
      }
    }
    if (candidate.initialState !== 'candidate') {
      return {
        ok: false,
        code: 'proposal_candidate_not_candidate_state',
        detail: `${proposal.skillId}@${String(proposal.version)} 的目录登记状态不是 candidate`,
      }
    }
    /*
     * ⚠️ 这里**只**核对"候选的 predecessor 与提议的 parentVersion 一致"。
     *    "父版本是否仍是目录当前版本"是**运行期**判据（发布器按持久层状态判），
     *    不能在这里判：否则"父版本已过期"（stale parent）这类负控连资产都装不进来。
     *    资产加载器只回答"资产自洽"，不回答"现在能不能发布"。
     */
    if (candidate.predecessorVersion !== proposal.parentVersion) {
      return {
        ok: false,
        code: 'proposal_parent_mismatch',
        detail:
          `${proposal.skillId}@${String(proposal.version)} 的 predecessor=${String(candidate.predecessorVersion)}` +
          ` 与提议 parentVersion=${String(proposal.parentVersion)} 不一致`,
      }
    }
    const dev = sets.get(proposal.devSetId)
    const holdout = sets.get(proposal.holdoutSetId)
    if (dev === undefined) {
      return { ok: false, code: 'proposal_dev_set_missing', detail: `${proposal.skillId}@${String(proposal.version)} 的开发集 ${proposal.devSetId} 不存在` }
    }
    if (holdout === undefined) {
      return { ok: false, code: 'proposal_holdout_set_missing', detail: `${proposal.skillId}@${String(proposal.version)} 的留出集 ${proposal.holdoutSetId} 不存在` }
    }
    if (dev.kind !== 'development' || holdout.kind !== 'holdout' || dev.skillId !== proposal.skillId || holdout.skillId !== proposal.skillId) {
      return {
        ok: false,
        code: 'proposal_set_kind_invalid',
        detail: `${proposal.skillId}@${String(proposal.version)} 的 dev/holdout 集合 kind 或 skillId 不匹配`,
      }
    }
    const disjoint = assertSetsAreDisjoint(dev, holdout)
    if (!disjoint.ok) {
      return { ok: false, code: 'proposal_sets_overlap', detail: `${proposal.skillId}@${String(proposal.version)}：${disjoint.detail}` }
    }
  }

  return { ok: true, loaded: { catalog, registry, sets } }
}

/** 按 (skillId, version) 取候选提议（门/发布器用）。 */
export function proposalOf(
  loaded: LoadedWorkflowSkillRevisionAssets,
  skillId: string,
  version: number
): WorkflowSkillRevisionProposal | undefined {
  return loaded.registry.proposals.find((proposal) => proposal.skillId === skillId && proposal.version === version)
}
