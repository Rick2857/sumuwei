/**
 * persistent-character 插件 —— 把「角色状态」这一层封装成一个 ElizaOS 插件。
 *
 * 这样做的理由（对应 L1 方案第 16 节）：后续层级都以插件形式叠加，不推翻既有结构。
 *
 *   Lv1  state      ← 本插件
 *   Lv2  memory / action
 *   Lv3  avatar
 *   Lv4  voice
 *
 * 插件职责：注册 CHARACTER_STATE provider，把持久化状态注入每轮上下文。
 *
 * ⚠️ 建表与首次建档**不在这里做**。
 *    原因：插件的 `init` 是在 `runtime.initialize()` 内部被调用的，而 core 的
 *    initialize() 会先查 `agents` 表、后跑插件迁移——此时我们的表还没建。
 *    因此建表/建档由 main.ts 在迁移完成之后显式调用（见 src/main.ts 的
 *    `initCharacterState`）。这也是本项目在数据库顺序上踩过的坑之一。
 */

import type { Plugin } from '../infrastructure/runtime/eliza-types.ts'
import {
  createCharacterStateProvider,
  type StateProviderIds,
} from '../state/provider.ts'

export function createPersistentCharacterPlugin(ids: StateProviderIds): Plugin {
  return {
    name: 'persistent-character',
    description:
      'Persistent Character Layer：把角色的情绪与关系状态持久化，并在每轮注入模型上下文',
    providers: [createCharacterStateProvider(ids)],
  }
}

export default createPersistentCharacterPlugin
