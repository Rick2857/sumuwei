# LG 3D 独立预览

> 2026-10-14 更新：3D 与 Omni 已合并并生产激活。当前事实见 `docs/post-lv2/Avatar-3D-Omni-Production-Activation-2026-10-14.md`；下文保留独立原型/隔离验证的历史范围。

独立 worktree `codex/avatar-3d`，来源提交 `faa08659`。此包先完成不依赖换库的 3D 呈现，
不启动 LG 核心，不连接 PGlite/PostgreSQL，不读取 `.env`，不接管生产 Live2D。
主项目的 package.json、pnpm 锁文件、桥接和共存启动器均未修改。

## 运行

在本 worktree 的 `tools/avatar-3d` 目录运行（Node 22.13+）：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run sample
npm start
```

打开 <http://127.0.0.1:12403>。Ctrl+C 正常退出。
`sample` 是显式下载命令；依赖和示例下载完成后，页面只请求本机静态文件。
此包使用自己的 npm 锁文件和 node_modules，以免改动正在迁移的根 pnpm 依赖图。

可以导入本地 `.vrm` 和音频文件；文件在浏览器读取，不上传到服务器。
没有音频时播放 4 秒合成测试音，不是 TTS，不代表苏沐薇的声音。
存在本机 `public/models/local.json` 时，默认载入其中第一个模型；否则使用 pixiv 示例。
2026-10-13 已接入用户提供的 Aoba 1.4（VRM0）戴帽/无帽版，可以在“本机模型”中切换。
默认仍是独立预览；显式连接语音外壳时，可使用 3D 聊天界面。尚未替换生产 Live2D 启动入口。

在新检出中恢复这两个本机模型：

```powershell
python -X utf8 import-aoba.py "C:\Users\user\Downloads\aoba.ver1.4.zip"
```

导入器只接受本次检查过的归档摘要，验证两个 VRM 的 CRC32 和 SHA-256 后才写本机副本。
此原包的 ZIP 目录偏移有误，导入器按已验证的本地文件头取出所需 VRM；原 ZIP 不改动。
二进制和本机模型清单均被 gitignore，不随代码分发。

## 已实现的范围

- three-vrm 载入、视角旋转/缩放、VRM 表情与骨骼适配。
- 自动眨眼、胸部待机呼吸；已有 `neutral/smile/surprised` 映射为 VRM 的中性/happy/surprised。
- 已有 `none/nod/tilt` 映射为头部骨骼动作，动画有结束边界。
- 复用 `lg-expression@1` 的 generation、replyId、segmentId、cue、expression、gesture 字段。
  预览按钮产生明确的模拟指令；聊天档消费 LG 已检查的真实分段。
- 只在 HTMLAudioElement 的 `playing` 事件开始表演。Web Audio 实测音量驱动 aa 口型。
  自然结束、打断、失败、替代、页面离开均复位；迟到/重复/无效段拒播。
- 服务只绑定 loopback。默认仅静态文件；聊天档只代理语音外壳的四个白名单 HTTP 路由和 `/client-ws`。

## 连接已有语音外壳

```powershell
node server.mjs --shell-url http://127.0.0.1:12393 --runtime-root "当前核心源码的绝对路径"
```

此命令只起 3D 页面，不启动核心或打开数据库。`12393` 对应隔离外壳；正式外壳是 `12394`，
必须显式选择。页面从外壳读回运行模式并标注是否写真实记忆。
核心源码目录仅用于读取 `scripts/postlv2_speech_client.js` 的播放工厂；服务不暴露其余源码。
页面复用现有 PCM 缓冲、Web Audio 时钟、取消 ACK 与播放事实回报，未另写 TTS/回复生成器。
文字聊天、实际音量口型、逐段表情/动作、打断和结束复位共用原有协议。
点击“点击说话”才请求麦克风权限，再次点击提交；最多 60 秒。录音提交前保留在本地，取消即丢弃。
采集为 16kHz 单声道 float PCM，提交后由原有 SenseVoice 识别。它是点击录音，不是自动 VAD 或全双工通话。

`shell-connected.py` 使用既有 Python 外壳的认证 TCP 连接档；连接信息从忽略的私有 JSON 读取。
不调用会复制 PGlite/覆盖前端的旧安装启动脚本，不改共享 `postlv2-deps` 的配置与源码。

## 隔离 PostgreSQL 联调

`snapshot-runtime.mjs` 只冻结指定源码目录，不复制 `.env`、数据库、模型或 Git 历史；拒绝覆写旧副本。
`test/pg-session.mjs` 必须经仓库 `with-test-model` 包装器调用，创建全新的 `lg_test_avatar3d_…` 库，
读回库身份，再运行真实 `main.ts --coexist`、Python/CosyVoice 外壳与 Edge/Aoba 页面。
数据库凭据只读取本地私有文件，不进页面或证据。默认可读取既有
`artifacts/post-lv2/local/pg-migration/pg-trial.env`；专用实例通过 `AVATAR3D_PG_CREDENTIALS_FILE` 指定。
需要环境变量 `AVATAR3D_RUNTIME_ROOT`（冻结副本）、`AVATAR3D_SOURCE_ROOT`（主检出）、
`AVATAR3D_DEPS_ROOT`（既有语音依赖）和 `TEST_MODEL_ENV_FILE`（主检出 `.env.test`）。
设置 `AVATAR3D_CORE_ONLY=1` 可单验实际核心的 PG 启动/退出；完整档还验证真实 TTS 与麦克风识别链。
每轮新建库和证据目录，保留失败；测试库保留供核对，不混用正式 `sumuwei` 库。

需要完全分离容器/卷时运行 `node test/start-pg.mjs`（先设 `AVATAR3D_RUNTIME_ROOT`）。
它复用已安装的固定镜像、新建命名卷与随机账号密码，仅绑定 `127.0.0.1:55433`，不开自动重启。
输出 `server.json` 指定本次实例身份；据此设置 `LG_PG_CONTAINER`、`LG_PG_HOST_PORT` 和
`AVATAR3D_PG_CREDENTIALS_FILE` 再运行联调。它不会挂载正式卷，也不恢复共享实例的数据目录。
验证结束使用 `docker stop <本次名字>` 有序停止；保留命名卷与私有凭据以供审计，代码不自动删除它们。

本轮发现 PG 退出死锁：资格锁持有的池连接在 `afterRun` 才归还，但 `pool.end()` 正等它归还。
`patches/postgresql-shutdown.patch` 是可审阅的核心修复，`git apply --check` 已对主检出通过；
尚未写入共享主检出。`patch-pg-shutdown.mjs <冻结副本>` 将该修复应用到联调副本并记录前后摘要。
修复在唯一数据库关闭函数前归还资格连接，覆盖 `ChatSession.close()` 与外层关闭句柄两条调用路径。
`test/pg-shutdown.mjs` 验顺序、跨句柄幂等和准备阶段失败仍关库；另有实际 PG 核心退出 0 的读数。

## 验证

```powershell
npm run check
npm test
npm run test:browser
npm run test:browser -- aoba.vrm
npm run test:browser -- aoba-hatless.vrm
```

浏览器检查使用已安装的 Microsoft Edge（Playwright，不额外下载浏览器）。
示例回归需要先运行 `npm run sample`，Aoba 回归需要先执行本地导入器。
每轮结果和截图放入 `evidence/local/<时间>/`，旧失败档不覆盖。
`test:browser` 实际检查 WebGL 绘制、VRM 表情权重、头/胸骨骼、音频播放与复位、错误拒收及恢复，
并核对页面没有向远程 HTTP(S) 地址请求。部件测试另查身份、代次、重复和迟到边界。

## 上游与资产

- [three-vrm](https://github.com/pixiv/three-vrm)：3.5.5，MIT；
  [Three.js](https://github.com/mrdoob/three.js)：0.180.0，MIT。完整依赖版本/完整性见 package-lock.json。
- 示例来自 three-vrm 提交 `ff42fae4fcee1fcbca2cd262c7f5f8cbddeaf5ab` 的
  `packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm`，pixiv Inc.，模型版本 v1.0.1。
  SHA-256：`12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2`。
  模型内声明 [VRM Public License 1.0](https://vrm.dev/licenses/1.0/)，使用条件与代码 MIT 分开；
  原始元数据随下载文件保留。模型二进制不入 Git，下载器固定提交并验证摘要，不使用 latest。
- 本实现参考上游基本载入范式和 LG 原有呈现生命周期；未引入 AIRI/Amica 的 Agent、记忆或语音框架。

## 后续接入边界

2026-10-13 已使用迁移后的当前源码冻结副本和新建 PG 测试库，接通真实语音段与播放回报。
角色、会话、取消与播放账归属仍由 LG 持有。现有 PGlite `sandbox-copy` 启动脚本不作为 PG 入口；
Python 外壳的 `sandbox-copy` 模式名在连接档只选择测试端口，不复制或打开 PGlite。

已验证官方 VRM 1.0 示例、Aoba 1.4 两个 VRM0 版本和 4 秒测试音。长音频、真人听感、
QQ 共存、生产切换、真人声音设备和完整回归须按最新 WP3 交接报告分列读取。
音量口型不等于音素口型；不同模型缺少的表情/骨骼不会凭空补齐。
Aoba 有口型、眨眼和微笑，但没有注册 surprised；界面与诊断读数明确显示中性替代。
VRM0/1 的手臂按实际骨骼方向放下，加载后的 SpringBone 状态按变换后的世界坐标重置。
作者来源：[Aoba 商品页](https://booth.pm/ja/items/7090519)。完整利用规约在该页独立下载，本轮未取得。
资产内权限元数据保留原样；当前技术验证不作为商用或再分发许可结论。

早期来源提交的 18 个类型错误是 WP1 历史读数；迁移后冻结副本的 `pnpm typecheck` 已通过。
当前完整核心回归与各档证据见 `docs/post-lv2/Avatar-3D-PG-WP3-Handoff-2026-10-14.md`。
本包在根 tsconfig 扫描范围之外，另有自己的语法、部件与真实浏览器检查。
