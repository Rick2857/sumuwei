# 可选 3D 与 Omni 语音

本公开副本包含 three-vrm 呈现、Omni 实时 WebSocket 代理、LG 主回复端口及取消/更正接线。没有打包模型、声音、API Key、数据库或原开发环境的生产快照；本副本的真实模型/生产链尚未验证。

## 不需要凭证的预览

在自己的 checkout 中安装独立、锁定的可选依赖：

```powershell
npm --prefix tools/avatar-3d ci --ignore-scripts --no-audit --no-fund
npm --prefix experiments/omni-realtime ci --ignore-scripts --no-audit --no-fund
```

3D 示例需要明确下载；下载器固定上游提交并核对文件摘要。示例模型不随 Git 分发，其许可与源码许可分开：

```powershell
npm --prefix tools/avatar-3d run sample
npm --prefix tools/avatar-3d start
```

打开 <http://127.0.0.1:12403>。可载入自己取得许可的 VRM 文件；本地文件不上传。示例声音是合成测试音，不是角色语音。

独立语音协议演示：

```powershell
npm --prefix experiments/omni-realtime start
```

打开 <http://127.0.0.1:12410>。默认只有预设字幕/提示音，无数据库、工具或真实转写。麦克风手动开启。

## 自己的真实模型与 LG

将 `experiments/omni-realtime/.env.local.example` 复制为同目录 `.env.local`，填写自己的百炼 Key、业务空间和地域；不得提交。`npm --prefix experiments/omni-realtime run live` 仅验证独立真实语音，不连接 LG。

固定模型 `qwen3.8-omni-flash-realtime`、音色 `Liora Mira`；输入为 16 kHz PCM，输出为 24 kHz PCM。模型/账户可用性由自己的提供商确认，源码公开不代表该账户能调用。

LG 隔离入口为 `npm --prefix experiments/omni-realtime run lg`。它需要自行建立的 `lg-omni-isolated-pg` / `lg-omni-isolated-data` / loopback 55434 及 `lg_test_omni_*` 数据库；`setup-lg.ts` 接受自己的凭据文件与 `.env.test`，`compose.isolated.yml` 不复用生产卷。创建容器后先核对实际 Mounts/端口，再启动；任何现有生产数据不得作为测试输入。

生产源码入口为 `pnpm postlv2:avatar:production`，停止为 `pnpm avatar:3d:stop`。它在**当前公开 checkout**运行，不读取开发者的私有 active-release.json。
操作者必须先自行准备 PostgreSQL schema、凭据、模型资产和语义召回资产；参见现有 PostgreSQL Runbook。示例身份约定为 `lg-postgresql-production` / `lg-omni-production-data` / `127.0.0.1:55432/sumuwei`，并在启动时核对实际卷和单持有；`compose.production.yml` 使用固定镜像、关闭自动重启、不会导入任何原开发数据。
新公开卷名与原开发卷不同，不能据此连接原开发实例。启动器不会自动创建/迁移数据库，也不会下载模型或启动 Docker。

集成页面当前期望自己合法取得的 Aoba VRM 位于 `tools/avatar-3d/public/models/aoba.vrm`。本仓库不包含 Aoba；作者规约需要操作者自行确认，不增加商用或再分发许可主张。无该模型时页面显示未就绪；独立 3D 预览可使用官方示例或自己的 VRM。

## 权威与验证边界

- LG 保持 ContextCompiler、正式轮次、人格/记忆、工具网关、账本和回复检查的权威；Omni 的 API tools 为空、云端搜索关闭。
- 原生音频可以先于最终检查播出，LG 检查发现改写时停播并发出更正；不声称保持旧 TTS“检查后才合成”的性质。
- 取消先清空本地 Web Audio 队列，再取消 LG/重建上游；实际播出、核心 ACK 与已提交事实是不同证据。
- 3D 口型使用已排程 PCM 音量，不是音素对齐；当前原生语音未提供 LG 表演标签。每通连接保留十分钟上限，可重新连接。
- QQ 多用户开启且共存令牌已准备时，原生语音与 QQ 外壳接入同一个核心；只有 avatar 入口使用原生语音回复端口，QQ 保留文本回复通路。轮后异步记忆失败的新语音纠正、真人回声、听感和长时 p95 仍需独立验证。设置见 [QQ-GROUPS.md](QQ-GROUPS.md)。
- 公开源码仍保留旧本地语音适配器，但不包含任何本地 ASR/TTS 权重；旧入口需操作者自己安装依赖与模型。

无需模型/数据库的检查：

```powershell
npm --prefix experiments/omni-realtime test
npm --prefix tools/avatar-3d run check
npm --prefix tools/avatar-3d test
pnpm exec tsc -p experiments/omni-realtime/tsconfig.json --noEmit
```

`test-avatar.mjs --live`、麦克风检查与 PG 联调需要自己的资产/测试实例，**不属于无凭证 CI**。最新公开验证见 [PUBLIC-VERIFICATION](PUBLIC-VERIFICATION.md)。
