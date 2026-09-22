# Changelog

本文件记录本项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)，具体规则见
[`docs/VERSIONING.md`](docs/VERSIONING.md)。

## [Unreleased]

### 变更

- **鲸鱼娘换成高清原画**：改用 1448×1086 透明底的专项立绘，替代原先从
  三视图 JPEG 裁出的低清版本（线条更干净、渐变正确，并补上了原图没有的
  **鲸尾**）。素材来自第三方项目，按其署名许可分发，`LICENSE-ASSET.md`
  记录了来源、许可与修改内容
- **真眨眼**：新素材带睁眼/闭眼两帧，渲染器改为在两帧间交叉淡入，
  而不是把眼睛压扁。两帧剪影必须一致，不一致会直接报错
- **骨架修正会写回 `puppet.json`**：此前 `rig.overrides.json` 只影响调试叠图，
  运行时读到的仍是未修正的推导结果
- 鲸鱼娘骨架增至 11 个区域（新增鲸尾、裙摆，侧发从「鳍」改回摆动）

### 新增

- **多角色**：内置两个角色可在界面上随时切换，选择会被记住
  - `DeepSeek 鲸鱼娘`（原默认角色）
  - `企鹅 Pip`——为本项目原创设计的 Q 版企鹅，随 MIT 分发
- **导入自己的角色**：`node scripts/character.mjs add --from <图> --id <名>`
  - 白底三视图与已抠好的透明 PNG 都支持（后者直接用自身 alpha，不抠图）
  - 自动绑骨：轮廓 → 自适应阈值找成对眼睛 → 暖色团块找喙/嘴 → 躯干/鳍/脚
  - 输出骨架叠图供核对，`rig.overrides.json` 可按名字局部修正
- **行为层**：打盹（长时间待命闭眼、飘 `z`）、戳一下（起跳 + 感叹号）、
  拖动时下半身滞后、闲置时自主东张西望、完成冒星、报错冒汗滴
- **状态徽记**：思考/执行时浮出 `…`，搁置时显示 `?`，让状态一眼可辨
- **角色注册表**：用户目录可覆盖内置角色；页内走同源路由，桌面外壳走回环桥

### 修复

- 徽记（`z`、感叹号、星、汗滴）从未真正绘制过：WebGL 画布拿不到 2D
  上下文，`getContext('2d')` 返回 null，每帧抛异常但界面看起来正常。
  改为独立的覆盖画布，并让渲染进程错误直接判定冒烟测试失败
- 面板/内容框检测硬编码 3 字节步长，PNG 参考稿是 4 通道，
  导致三视图被识别成 1 个面板、crop 横跨整张图
- `add --force` 在目标文件只读时 EACCES（导出的稿子常是 0400）
- 从角色自己的源文件重新导入时，会先删源再复制
- 自适应阈值变量在其使用点之后声明
- `<select id="character">` 与画布 `id="character"` 撞名，
  导致 `getElementById` 返回下拉框、画布 `getContext` 不是函数

### 变更

- **新内置角色「咕咕嘎嘎」**（替换已移除的「企鹅 Pip」）：帧动画后端上线，
  直接播放 Codex 8×9 图集（192×208/帧，对 124px 桌宠是原生分辨率）。
  权利状态见 `resources/characters/gugu/PROVENANCE.md`——形象三方主张并存、
  素材仓库无许可证，按所有者明确决定使用
- **引擎新增帧动画后端**：与网格形变后端同接口（setMood/react/sleep…），
  角色清单的 `kind: "atlas"` 决定用哪条路；打盹/戳一下/状态徽记对两者同样生效
- 外壳命中检测对图集角色改用待机第一帧轮廓做蒙版

### 计划中

- 接入 Cubism 渲染后端，让桌宠真正加载 `resources/live2d/models/whale-maid/`
  里的 `.moc3`（目前仍是 WebGL 网格形变）
- 在 Cubism 渲染后端上线后，用真实的眨眼/口型/物理表现回归验证模型

## [0.1.0] - 2026-09-22

首个可用版本。

### 新增

- **插件 `dsh-live2d-pet`**
  - 页面内桌宠：注册进 `shell.overlay` 插槽的悬浮角色，可拖动、点击弹出指令气泡
  - 指令投递：走 `sessionController.prompt`，与浏览器输入框同一条路径，支持
    `queue` 排队与 `steer` 插话两种模式
  - 状态派生：订阅 `agent/status`、`session/event`、`agent/error`、
    `api-session/*`，推出 `idle` / `thinking` / `tool` / `waiting` / `done` /
    `error` 六种相位
  - Host 半边：仅回环、随机密钥鉴权的本地桥（`GET /v1/state`、`GET /v1/events`
    的 SSE 推送、`POST /v1/prompt`），发现文件写入
    `$DSH_HOME/live2d-pet/bridge.json`（0600），随插件卸载清理
- **外壳 `dsh-pet-shell`**
  - 系统全局桌宠：透明、置顶、逐像素鼠标穿透的 Electron 窗口
  - 自动选接入：检测到已有 harness 就直接接上，否则自行拉起 `dsh web --port 0`
  - 系统托盘：连接状态、重连、开关桌宠、打开 Harness 界面
- **角色渲染**
  - WebGL 顶点网格形变：把单张扁平立绘当作可形变网格，按椭圆区域权重位移，
    实现头发摆动、尾鳍扇动、呼吸、真正闭合的眨眼、说话时的口型、视线跟随
- **资产流水线**
  - `scripts/build-character.mjs`：三视图 → 透明立绘，两段式抠图
    （严格白泛洪定轮廓 + 邻近光环软化），逐字节可复现
  - `scripts/fetch-live2d-assets.mjs`：按机器抓取 Cubism Core 与 8 个官方免费样例模型
- **模型生产流水线**（`live2d-pipeline/`）
  - 扁平立绘 → 27 层语义分层 PSD（符合 psd2live 的 See-Through 命名规范）
  - 构建 psd2live 并导出真 `.moc3` 模型族，含 `.model3.json`、`.cdi3.json`、
    `physics3.json`、6 秒循环待机与眨眼/点头/摇头动作、4096² 图集、
    可在 Cubism Editor 二次编辑的 `.cmo3`
- **测试**：`pnpm test` 共 88 项断言
  - Host 桥自测 41 项（发现文件、鉴权、SSE、状态派生、指令转发、卸载清理）
  - 外壳端到端冒烟 13 项（真启 Electron 接 mock 桥，校验接入日志、画布、截图）
  - 真 harness 端到端 11 项（真起 `dsh web`，验证插件在真载体上的路由）
  - 模型结构校验 23 项

### 修复

- 抠图脚本按 3 字节步长读取 4 通道缓冲，导致头发/脸/袜子被误判为背景，
  角色整体以约 75% 不透明度渲染，呆毛被抹掉
- WebGL 渲染的 alpha 混合用了单一 `blendFunc`，目标 alpha 变成 `srcAlpha²`，
  半透明白色蕾丝与灰色阴影渲染成白色雾团与灰色横带
- `session/event` 的会话身份取自事件对象，而真实契约是 `(session, event)`
- 错误相位的详情仍显示上一条助手文本，而非错误信息
- 外壳的接入/拉起 harness 等生命周期事件被 `--dev` 门控，生产路径下静默

### 已知限制

- 默认角色是网格形变而非真 Live2D 模型；`.moc3` 已产出并结构校验，但渲染后端尚未接入
- 模型只在中性姿态下验证过像素级正确，眨眼/口型/物理未在真实渲染器里目视确认
- PSD 的像素精确，但部分语义标签是启发式近似（头发前后、头饰、尾鳍、额头）
- 原画没有眉毛（被刘海遮住），要做眉毛动画需先补画

[Unreleased]: https://github.com/br0ny4/dsh-live2d-pet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/br0ny4/dsh-live2d-pet/releases/tag/v0.1.0
