import { sql } from 'drizzle-orm'
import { asCharacterId, entityRef } from '../../kernel/contracts/index.ts'
import { IMPRESSION_THRESHOLD, meetsRelationshipThreshold } from '../../kernel/contracts/scope.ts'
import { effectiveRelationship, renderRelationshipGuidance } from '../../kernel/contracts/relationship.ts'
import { getRelationshipProjection } from '../persistence/relationship-store.ts'
import { currentReadScope } from '../persistence/read-scope.ts'
import { exec, type RawDb } from '../persistence/db.ts'

/** Derived relationship impression only. No memory text, citations, secrets or private causes. */
export async function impressionQuery(db: RawDb, characterId: string, text: string): Promise<string | undefined> {
  const scope = currentReadScope()
  if (scope === undefined || !/(?:印象|怎么看|看法)/.test(text) || scope.context.principal.kind === 'system') return undefined
  const asker = scope.context.principal.userId
  const relationship = await getRelationshipProjection(db, asCharacterId(characterId), entityRef('user', asker))
  const effective = relationship === undefined ? undefined : effectiveRelationship(relationship.state, Date.now())
  const privileged = scope.context.principal.kind === 'owner' && scope.context.room.kind === 'private'
  if (!privileged && (effective === undefined || !meetsRelationshipThreshold({ originated: relationship!.state.originated,
    trust: effective.trust, closeness: effective.closeness }, IMPRESSION_THRESHOLD))) {
    return '本轮印象通路：提问者关系尚未达到条件，拒绝评价他人；不能改以记忆原文、秘密细节或来源链接回答。'
  }
  const rows = await exec(db, sql`select m.user_id, m.external_id, u.display_name from user_identity_mappings m
    join user_identities u on u.user_id=m.user_id where m.transport='qq'`, 'impression target resolution')
  const matches = rows.filter(row => text.includes(String(row.external_id)) ||
    (String(row.display_name ?? '').length >= 3 && text.includes(String(row.display_name))))
  const target = matches.length === 1 ? String(matches[0]!.user_id) : /(?:对我|我的印象|怎么看我)/.test(text) ? asker : undefined
  if (target === undefined) return '本轮印象通路：对象不明确，不猜测对象，也不读取其他人的原始记录。'
  const projection = await getRelationshipProjection(db, asCharacterId(characterId), entityRef('user', target))
  if (!projection?.state.originated) return '本轮印象通路：尚无该人的有效关系依据，不编造印象。'
  const view = effectiveRelationship(projection.state, Date.now())
  const qualitative = renderRelationshipGuidance({ effective: view, now: Date.now(), projection })!
    .split('\n').filter(line => /^(?:trust|closeness)（/.test(line))
    .map(line => line.slice(line.indexOf('→') + 1).trim()).join('；')
  return `本轮允许的印象依据（仅派生关系，不授予原文查询权限）：${qualitative}。` +
    '只作概括评价，不展示数值、私聊原文、秘密、情绪起因或可反查的来源引用。'
}
