/**
 * 第三方插件的模块声明。
 *
 * 为什么需要这个文件：
 *   @elizaos/plugin-sql 的 package.json `exports["."]` 把顶层 `types` 写在了
 *   `browser` / `node` 条件之前，TypeScript 在 `moduleResolution: bundler`
 *   下解析失败（报 TS7016）；@elizaos/plugin-bootstrap 同样无法解析。
 *   这是上游打包问题，不是我们代码的问题，运行时（tsx / node ESM）完全正常。
 *
 * 这里用 `typeof import(...)` 直接指向包内真实类型，
 * 因此不会丢失类型信息，只是绕开 exports 解析。
 */

declare module '@elizaos/plugin-sql' {
  const plugin: import('@elizaos/core').Plugin
  export default plugin
  export const plugin: import('@elizaos/core').Plugin
  export const createDatabaseAdapter: (...args: unknown[]) => unknown
  export class DatabaseMigrationService {
    constructor(...args: unknown[])
  }
}

declare module '@elizaos/plugin-bootstrap' {
  const plugin: import('@elizaos/core').Plugin
  export default plugin
  export const bootstrapPlugin: import('@elizaos/core').Plugin
  export const recentMessagesProvider: import('@elizaos/core').Provider
  export const characterProvider: import('@elizaos/core').Provider
  export const factsProvider: import('@elizaos/core').Provider
  export const relationshipsProvider: import('@elizaos/core').Provider
  export const actionsProvider: import('@elizaos/core').Provider
  export const providersProvider: import('@elizaos/core').Provider
  export const timeProvider: import('@elizaos/core').Provider
  export const settingsProvider: import('@elizaos/core').Provider
}

declare module '@elizaos/plugin-openai' {
  const plugin: import('@elizaos/core').Plugin
  export default plugin
  export const openaiPlugin: import('@elizaos/core').Plugin
}
