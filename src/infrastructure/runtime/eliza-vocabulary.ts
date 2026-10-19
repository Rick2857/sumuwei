/**
 * ElizaOS 形状数据的**取值词表** —— 从 `@elizaos/core` 独立出来（M12 · W2-③）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 两个枚举：`EventType`（事件名）· `ModelType`（模型路由键）。
 *
 * ⚠️ 它们在运行时**全部只是字符串**：
 *   · `EventType` → `runtime.events[event]`（`Record<string, handler[]>` 的**键**）
 *   · `ModelType` → `models[modelType]`（薄宿主 `useModel` 查表，见 thin-host.ts:216）
 * ⇒ 换成同名同值的本地常量，**行为完全不变**。
 *
 * ⚠️ `ChannelType` **不**在这里 —— 理由见文件末尾（它是**类型层**问题，属 W4）。
 *
 * ============================================================================
 *  值从哪来（不是手写，是抄上游 —— 2026-10-19 实测）
 * ============================================================================
 * `@elizaos/core@1.7.2` dist/node/index.node.js：
 *   · `ChannelType`  :25204-25216（TS enum，**自映射**：值 = 名字）
 *   · `ModelType`    :25288-25309（**普通对象**，不是 TS enum；`SMALL`/`MEDIUM`/`LARGE` 是别名）
 *   · `EventType`    :25409-25440（TS enum，**自映射**）
 *
 * ⚠️ `ModelType` 上游是**普通对象**（`var ModelType = {...}`），不是 TS enum ——
 *   差别在于它是**运行时值**（可被 `Object.keys` 遍历、值全是字符串）。
 *   本地保持同样形状（`as const` 对象），不改成 TS enum ——
 *   改成 enum 会给运行时引入一个**真实的对象**（TS enum 会生成反向映射），
 *   那是行为差异，不是等价替换。
 *
 * ============================================================================
 *  只收 LG 真正用到的成员
 * ============================================================================
 * 上游 `EventType` 有 29 个成员、`ModelType` 20 个、`ChannelType` 10 个；
 * LG 只用到 4 / 2 / 1 个。**多抄进来的每个成员都是一处会漂移的地方**。
 * ⇒ 下方只收用到的；`EventType` 的其余成员在需要时再补（补的时候要重新对上游取值）。
 */

/**
 * 事件名 —— 与上游 `EventType` 逐字相同（自映射：值 = 名字）。
 *
 * ⚠️ 这四个是 `attachEventLog()`（main.ts:1341）订阅的四个。
 *    它们是**字符串键**，薄宿主的 `events` 映射（thin-host.ts:108）按同样的键存。
 */
import type { UpstreamChannelType } from './eliza-types.ts'
export const EventType = {
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  MESSAGE_SENT: 'MESSAGE_SENT',
  RUN_STARTED: 'RUN_STARTED',
  RUN_ENDED: 'RUN_ENDED',
} as const
export type EventType = (typeof EventType)[keyof typeof EventType]

/**
 * 模型路由键 —— 与上游 `ModelType` 逐字相同。
 *
 * ⚠️ 上游还有别名 `SMALL: 'TEXT_SMALL'` / `MEDIUM: 'TEXT_LARGE'` / `LARGE: 'TEXT_LARGE'`。
 *   LG 不用别名 ⇒ 不抄（抄了就是多一处会漂移的地方）。
 * ⚠️ 薄宿主的 `useModel` 在查不到时**回落到 `TEXT_LARGE`**（thin-host.ts:216），
 *   所以这里的键必须与 `openai-compatible.ts` 的 `models` 记录键**逐字一致**。
 */
export const ModelType = {
  TEXT_SMALL: 'TEXT_SMALL',
  TEXT_LARGE: 'TEXT_LARGE',
} as const
export type ModelType = (typeof ModelType)[keyof typeof ModelType]

/**
 * 通道判别 —— **值**本地化，**类型**仍指向上游（W4 收尾）。
 *
 * ⚠️ 上游 `ChannelType` 是 **TS enum**（名义类型）。它出现在**两个上游类型字段**里：
 *   · `Memory.content.channelType`（main.ts 的三处消息构造）
 *   · `Room.type`（`ensureRoomExists` 的 `type` 字段）
 * 而 `Memory` / `Room` 这两个**类型**本身要到 W4（删依赖）才替换。
 *
 * ⇒ 所以这里取"**值本地、类型借用**"的折中：
 *   本地的 `ChannelType.DM` 运行时就是字符串 `'DM'`（**与上游逐字相同**），
 *   但它的**类型**标成上游那个 enum ⇒ 可以直接赋给 `Memory.content.channelType`。
 *
 * ⚠️ 这样做的收益：**运行时不再依赖上游包**（W4 删包时这一处不受影响），
 *   剩下的只是**类型**引用（B 档，W4 清）。
 *
 * ⚠️ 与 LG 自己的 `ChatChannel`（`cli` / `qq_private` / `avatar`）**不是一回事**：
 *   `ChatChannel` 是**入口身份**（由认证过的入口提供），
 *   `ChannelType` 是**记忆内容里记的通道形状**。两者不要混。
 */

export const ChannelType = {
  DM: 'DM' as UpstreamChannelType,
} as const
