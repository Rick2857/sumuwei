/**
 * 兼容再导出（S8 / ADR-094 R-2 选项 A，2026-10-03）。
 *
 * 内容包的权威形态已上移到生产资产位：
 *   src/content/storyline/jichuang-interview-two/story-pack.ts   <-- 权威
 *   evals/storyline/jichuang-interview-two/story-pack.ts         <-- 本文件，只再导出
 *
 * 为什么是再导出而不是复制：复制会让两份内容各自漂移，而 storyVersion / CONTENT_DIGEST
 * 的存在意义正是"内容变了必须能被发现"（两份一样的包会让"改了哪一份"不可判定）。
 * 为什么保留这个路径：既有若干道门（postlv2:story|world|source|source-root|s8:*）都从这里取包。
 * 方向是 evals -> src（正确方向）；反方向（src/** 依赖 evals/**）仍然禁止。
 *
 * 新代码请直接 import src/content/storyline/jichuang-interview-two/story-pack.ts。
 */

export * from '../../../src/content/storyline/jichuang-interview-two/story-pack.ts'
