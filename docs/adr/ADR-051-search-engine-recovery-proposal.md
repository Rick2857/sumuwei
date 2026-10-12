# ADR-051 — 搜索上游恢复提案

状态：**NOT APPROVED / NOT IMPLEMENTED / NOT ACTIVATED**。

用户本轮裁定：**“保留原引擎组，仅保留诊断与失败证据”**。以下方案仅作为诊断期间的提案记录，不执行。

日期：2026-09-22。范围：解除 M6 WP10b 的真实搜索阻塞。

## 复现

同一代码 HEAD `6cdd34e7960d`、既有测试模型和冻结搜索配置下，第一轮 M5.5 Live 24/0，但 M5.5.1 C2 零次搜索导致 19/1；第二轮 M5.5 Live 再次失败（17/7），两条生产搜索终态均为 timeout。第一轮 C2 的原始判定原因未被旧门保留；单独复测同一句输入时现有判定器返回 allowed，不能用后一次结果推断第一次原因。

相同两条公开查询、六个请求参数、5 秒超时的带外比较：

| 引擎组 | 科技新闻查询 | 注入示例查询 |
|---|---|---|
| duckduckgo,wikipedia,wikidata | 5009ms 超时 | 2225ms，0 条，duckduckgo 解析错误 |
| google,wikipedia,wikidata | 4075ms，0 条，验证码 | 939ms，0 条，暂停服务：验证码 |
| brave,wikipedia,wikidata | 2084ms，20 条有效 HTTPS 结果 | 840ms，23 条有效 HTTPS 结果 |

这只证明本次可用性，不保证 Brave 后续不会限流。探针返回候选也不等于证据已入模。

## 待裁定的最小变更

把 ADR-047 D-31a 的固定引擎组从 `duckduckgo,wikipedia,wikidata` 替换为 `brave,wikipedia,wikidata`。这是本机 SearXNG 的 Brave 引擎，不是迁回需 API key 的 Brave 托管 API。

此变更会让后续真实聊天的显式搜索词经 SearXNG 发给 Brave，替代 DuckDuckGo；因此是出站接收方变更，须明确批准。ADR-047 原文作为历史保留，通过本 ADR 修订该条裁定。

保留固定 loopback endpoint、每轮一次 provider 请求、零自动重试、5000ms 硬超时、六参数、唯一 accept 头、零 body、HTTPS 来源、最多五条以及所有认知与隐私约束。不采用实例默认引擎集，不增加动态回退。

## 实施范围与验证

1. 修改 `src/infrastructure/search/search-config.ts` 的常量，并同步 provider 注释。
2. 更新 `scripts/verify-m5.5-measurement.ts` 与 `scripts/verify-m5.5-smoke-live.ts` 中精确引擎集合断言；重复项、未批准引擎、缺失项负控继续有效。不得把断言改成任意非空列表。
3. 原始失败证据独立保留，受影响旧里程碑证据按本轮原始字节备份、归档和还原。
4. 重新冻结候选；运行 typecheck、M5.5 量具及相关离线门、M4.5 完整回归和真实模型档、两道受影响 Live、M6 WP10b。生产配置改变后，不能继续沿用 WP10b 当前“只改 scripts”的证据等价结论，也不能只豁免 R1。
5. C2 零出站若复现，保留诊断并单独调查；替换搜索引擎不解决搜索前的模型判定失败，不降低 C2 判据。

## 回退

按原裁定恢复 DuckDuckGo 固定组及其对应精确量具。保留所有失败历史；不进行数据库迁移或恢复，不改长期记忆。

## 当前结论

本提案未获批准，生产代码、引擎配置和验收判据未修改；M6 WP10b 不能声明 PASS，也不能据此进入已通过状态的 WP11 收口。
