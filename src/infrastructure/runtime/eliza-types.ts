/**
 * LG 本地类型 —— 替代 `@elizaos/core` 的**类型**层（M12 · W4）。
 *
 * ============================================================================
 *  为什么**不抄**上游的声明
 * ============================================================================
 * 上游 `AgentRuntime` 实际是**类**（`dist/runtime.d.ts` 16 KB），
 * 它的每个成员都拖着自己的一串类型（`Memory` → `Content` → `MemoryMetadata` → …）。
 * 抄一个就要抄它的**传递闭包** ⇒ 等于把整包类型搬进本仓。
 *
 * ⇒ 这里采取的路线：**按"本仓真正用到的面"定义本地类型**，
 *   并且 —— 关键 —— `AgentRuntime` **直接就是薄宿主自己**：
 *   W4 之后本仓只有**一个**运行时实现，那个类型**就是它**，
 *   不存在"类型描述的对象与实际运行的对象不是同一个"的可能。
 *
 * ============================================================================
 *  ⚠️ 代价（如实记，不藏）
 * ============================================================================
 * · `Memory` / `State` 用了**索引签名**（`[k: string]: unknown`）
 *   ⇒ **拼错字段名不会报错**。上游是严格字段。
 *   ⇒ 这是"卸掉依赖"与"保留编译期严格性"之间的**真实取舍**，
 *     本仓选了前者。若日后要收紧，按**实际用到的字段**逐个列出即可
 *     （`pnpm typecheck` 会立刻指出所有越界用法）。
 * · 这些类型**只描述形状，不产生任何运行时代码** ⇒ 删包对运行时**零影响**。
 */

import type { ThinHostRuntime, ThinMemory } from './thin-host.ts'

/**
 * 运行时宿主 —— **就是薄宿主本身**。
 *
 * ⚠️ 不是"像薄宿主的接口"，而是**同一个类**。
 *   ⇒ 任何 `const r: AgentRuntime = createThinHostRuntime(...)` 都**必然**成立；
 *   ⇒ 也不可能出现"类型说有这个方法、实际没有"。
 * ⚠️ 代价：需要旧宿主的少数门（`thinhost-equivalence-verify` 等）
 *   **无法**再用这个类型 —— 它们在 W4 一并**退役**（理由见计划 §W4）。
 */
export type AgentRuntime = ThinHostRuntime

/** 上游的 `IAgentRuntime` 只有一个；本仓的对应物就是宿主本身 */
export type IAgentRuntime = ThinHostRuntime

/** 上游 `UUID` 是带品牌的字符串类型；本仓一律用普通字符串（`UuidString` 是本地已有的形态） */
export type UUID = string

/** 通道判别（值在 `eliza-vocabulary.ts`，这里是它的**类型**侧） */
export type ChannelType = string

/**
 * ⚠️ 兼容别名：`eliza-vocabulary.ts` 原来从上游导入 `ChannelType` 并起名叫
 * `UpstreamChannelType`，用来给本地常量**标注类型**（`{ DM: 'DM' as UpstreamChannelType }`）。
 * ⇒ 本地化后**类型**在这里，名字保留成别名，让那一行不用改。
 */
export type UpstreamChannelType = ChannelType

/**
 * 插件 —— 薄宿主**不解释插件**；这个类型只为"仍要声明形状的调用点"而存在。
 *
 * ⚠️ `models` 必须**显式列出**且给元素一个类型：第一版只靠索引签名
 *   ⇒ `models[ModelType.TEXT_LARGE]` 的元素类型退化成 `{}`
 *   ⇒ 报 `expression of type '"TEXT_LARGE"' can't be used to index type '{}'`（2 处）。
 */
export interface Plugin {
  name?: string
  description?: string
  priority?: number
  models?: Record<string, ModelHandler>
  [key: string]: unknown
}

/**
 * 角色定义 —— 薄宿主只用 `name` / `id` / `system` 三个字段；
 * 但**投影层**（`seed-projection.ts`）要读 bio / traits / style / topics。
 *
 * ⚠️ 这些字段**必须显式列出**，不能只靠索引签名：
 *   第一版只留索引签名 ⇒ `character.bio` 的类型退化成 `{}` ⇒ typecheck 报
 *   `Type '{}' is missing … from type 'string[]'`（5 处）。
 *   索引签名给的是 `unknown`/`{}`，**收窄信息全丢**。
 * ⇒ 显式字段保住收窄，索引签名只负责"未知的额外字段不报错"。
 */
export interface Character {
  name: string
  id?: string
  system?: string
  bio?: string | string[]
  adjectives?: string[]
  topics?: string[]
  style?: { all?: string[]; chat?: string[] }
  // ⚠️ `messageExamples` / `postExamples` 是**对话对数组**：每个元素是一组
  //   `[用户消息, 角色消息]`（苏沐薇.ts:90-99 实测），元素本身是 `{name, content}` 对象。
  //   我第一版写成 `Array<{…}>`（少一层）⇒ 报 `Type '[{…},{…}]' is not assignable to
  //   type '{…}'`；写成 `string[]` 也错（那是名字误导）。
  messageExamples?: Array<Array<{ name: string; content: { text: string } }>>
  postExamples?: Array<Array<{ name: string; content: { text: string } }>>
  knowledge?: string[]
  plugins?: string[]
  settings?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * 一条记忆 —— **直接复用本仓已有的 `ThinMemory`**（`thin-host.ts`）。
 *
 * ⚠️ 不是这里新造的宽松副本：第一版我在本文件里写了一个带索引签名的 `Memory`，
 *   结果 `pnpm typecheck` 立刻抓到 `Argument of type 'Memory' is not assignable to
 *   parameter of type 'ThinMemory'` ⇒ **本仓早就为这件事准备了精确类型**
 *   （`thin-host.ts` 的注释原文："定义结构相同但自有的类型，调用点靠结构兼容"）。
 *   ⇒ 复用它，比再造一个**更宽松**的版本更安全。
 */
export type Memory = ThinMemory

/** 上游 `State`（对话状态）—— 本仓只在 `readStateIfExists` 一类签名里用到 */
export type State = Record<string, unknown>

/** provider 描述（本仓薄宿主不实现 provider 体系；仅为形状保留） */
export interface Provider {
  name?: string
  [key: string]: unknown
}

/**
 * `useModel` 的参数面。
 *
 * ⚠️ `prompt` 是**必填**（第一版写成 `prompt?: string` ⇒ 变成 `string | undefined`
 *   ⇒ `openai-compatible.ts:126` 报
 *   `Type 'string | (…)[] | undefined' is not assignable to type 'string | object[]'`）。
 *   实际上**每个** `useModel` 调用点都传了 prompt。
 */
export interface GenerateTextParams {
  prompt: string
  images?: Array<{ dataUrl: string }>
  [key: string]: unknown
}

/**
 * 一个模型处理器。
 *
 * ⚠️ 需要它是因为：上游的 `Plugin` 类型给 `models` 提供了**上下文类型**，
 *   于是处理器函数的参数能被推断。改成本地 `Plugin`（宽松）后上下文没了
 *   ⇒ `async (runtime, params) => …` 的两个参数变成隐式 `any`（4 处 TS7006）。
 * ⇒ 给 `models` 一个明确类型，参数类型就回来了 —— 这比"把 Plugin 抄回来"小得多。
 */
export type ModelHandler = (runtime: AgentRuntime, params: GenerateTextParams) => Promise<unknown>
