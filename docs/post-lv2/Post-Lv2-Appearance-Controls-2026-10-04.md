# 皮套服装与特效控制（2026-10-04）

用户授权：「好补上吧」。已加入当前皮套测试页：[打开页面](http://127.0.0.1:12393/)。右上角展开 **服装与特效**，选择服装、勾选特效；再次点击标题收起面板查看皮套。

## 已实现

- 原始服装，以及包内 `衣装1/2/3` 的三个有效预设；空的 `costume_v0100` 不作为新服装展示。
- 13 个独立特效开关：爱心、脸色发青、音符、汗滴、动态汗滴、惊讶线、问号、感叹号、转圈、黄色跳线、闪光、睡眠、生气符号。
- 特效可以叠加，支持逐项关闭或「清除特效」。清除特效保留选定服装。
- 语音播放、自动表情复位、头部动作、打断和下一轮聊天保留本页的手动选择。

手动选择只保留在当前页面会话内；刷新页面恢复原始服装、关闭特效。本步没有加入跨重启保存，也没有加入新的手动脸部表情面板。

## 接入方式

资源已经在本机皮套包内，不新增依赖或模型下载。构建脚本从三个服装和十三个特效的原始 `.exp3.json` 提取受控定义；分别只涉及 5 个服装参数和 13 个特效参数。

服装与特效直接在 Cubism 更新前叠加到相应参数，使用模型默认值加预设偏移，夹紧模型范围，并在更新后恢复基线。因此不会受单一 expression 槽替换影响，也不会逐帧累加。只作用于 `ulvm2_0001.moc3`，模型未加载时控件禁用；模型释放后停用旧覆盖层。

它不改 LG 的认知、记忆、回复守卫、语音指令或实际播放时机。既有模型表达旁路仍只接受 neutral/smile/surprised，不能借该旁路改变服装。VTube Studio 的快捷键没有直接移植到网页。

可重放安装仍使用 `scripts/postlv2-avatar.cmd`。前端构建由 [构建脚本](../../scripts/postlv2-expression-frontend.py) 管理，重建时同时接入 [控制器](../../scripts/postlv2_appearance_client.js) 和 [面板](../../scripts/postlv2_appearance_panel.jsx)，其指纹与生成的资源定义纳入本轮构建回执。

## 验证与边界

- `pnpm postlv2:appearance:verify`：9/9。使用真实资源定义，Cubism/音频为 stub；涵盖互斥换装、原始服装恢复、全部特效开关、组合与清除、点头/口型/眨眼共存、结束/打断保留选择、未知命令拒绝，以及嵌套播放钩子内释放覆盖层。
- `pnpm postlv2:expression:verify`：既有 TS 16/16 + Python 11/11，通过。
- 前端 browser renderer 构建通过；实际页面验证三个服装和十三个特效开关。
- 实际 Qwen3-TTS / Ono_Anna 播放：reassuring 的微笑/点头结束后保留服装和爱心；playful 播放中切换服装、点击打断，音频/头部动作复位而新服装/特效保持。后续 natural 新一轮正常播放结束，服装仍保持。
- `pnpm m4.5:ci` 仍 FAIL：M3.5 `FC-T04` 的既有 S8 跨模块 storyline 依赖未通过；本步不修改该冻结边界，不宣称整库验收通过。
- 最新共享工作树的 `pnpm typecheck` PASS；各命令退出码见 [checks.json](../../artifacts/post-lv2/appearance-controls-20261004/checks.json) 与日志。并行任务曾引入 `scripts/m10.1-gate-select.ts` 的 `SelectionBasis` 错误，原失败日志保留。
- 前端原有全量 TypeScript 问题本轮未重新测量；browser 构建和页面验证不替代该检查。特效的视觉自然度、语音听审仍待真人体验；不新增实时合成速度主张。

证据目录：[appearance-controls-20261004](../../artifacts/post-lv2/appearance-controls-20261004/)。完整 CI 大日志按仓库约定留在本机 Temp，路径与摘要见 `ci-summary.json`。本步使用现有 sandbox-copy 服务，不写回真人记忆，不迁移生产库，不修改生产 `.env`。整库检查期间历史证据只按具名白名单保留/恢复，记录见 `historical-restored.json`。

![控制面板](../../artifacts/post-lv2/appearance-controls-20261004/panel-final.png)

![服装 3 实际页面](../../artifacts/post-lv2/appearance-controls-20261004/appearance-final.png)
