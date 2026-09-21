# dsh-live2d-pet

给 **DeepSeek Harness** 用的 Live2D 桌宠。同一只角色有两种存在方式：

| | 在页面里 | 在系统桌面上 |
|---|---|---|
| 实现 | 客户端插件，注册进 `shell.overlay` 插槽 | Electron 外壳，透明 + 置顶 + 鼠标穿透窗口 |
| 覆盖范围 | harness 窗口内 | 整个桌面，浮在其他应用之上 |
| 状态绑定 | `useSessions` 快照 | 插件 Host 半边的本地桥（SSE 实时推送） |
| 适用 | Web GUI、官方桌面端 | 想在脱离 harness 窗口时也看得到 |

两边**共用同一个角色引擎**（`src/client/engine.js`），所以是同一只角色，不是两套实现。

```
                   ┌──────────────────────────────────────────┐
                   │ harness 进程（dsh web / 官方桌面端）        │
   浏览器页面 ──────┤  dsh-live2d-pet                          │
   （插件客户端半边）│   ├─ client：shell.overlay 里的桌宠        │
                   │   └─ host  ：订阅 agent 状态 → 本地桥       │
                   └────────────────┬─────────────────────────┘
                                    │ 127.0.0.1:<随机端口> + 随机密钥
                                    │ 发现文件 $DSH_HOME/live2d-pet/bridge.json (0600)
                   ┌────────────────┴─────────────────────────┐
   系统桌面 ────────┤  dsh-pet-shell（Electron）                │
   （全局悬浮窗口） │   透明 / 置顶 / 逐像素鼠标穿透             │
                   └──────────────────────────────────────────┘
```

## 状态绑定：桌宠怎么"知道" harness 在干什么

状态全部来自 harness 的真实事件，没有轮询私有接口：

| Host 事件 | 推出的状态 | 桌宠表现 |
|---|---|---|
| `agent/status` → running | `thinking` | 快速上下浮动、张嘴 |
| `session/event` `tool/call` | `tool` | 气泡显示正在调用哪个工具 |
| `session/event` `assistant/message` | 取最后一段助手文本 | 气泡显示它在说什么 |
| `session/event` `turn/end` completed | `done` | 跳一下，绿色徽标 |
| `turn/end` error/aborted/blocked | `error` | 抖动，红色徽标 + 原因 |
| `agent/error`、`api-session/error` | `error` | 同上，气泡显示错误信息 |
| running 但 45s 无事件 | `waiting`（搁置） | 几乎静止、呼吸变慢、黄色徽标 |

`waiting` 是刻意做成"看起来就不一样"的：同样的绿/蓝徽标只说明忙，静止 + 黄点才说明卡住了或在等你。

## 快速开始

```bash
pnpm install
pnpm build                      # 构建插件客户端 bundle

# 1) 页面内桌宠
dsh plugin --profile web add ./packages/dsh-live2d-pet
#    重启 dsh 后，界面右下角出现桌宠

# 2) 系统全局桌宠
cd packages/dsh-pet-shell && pnpm start
```

外壳的接入策略是**自动选**：先找已经在跑的 harness（也就是你正在用的那个），找到就直接接上去；找不到才自己起一个 `dsh web --port 0`。

```bash
electron . --attach-only          # 只接入，不自己起 harness
electron . --dsh /path/to/dsh     # 指定 dsh 可执行文件
electron . --profile web          # 指定 profile
```

## 目录

```
packages/dsh-live2d-pet/     插件包（可发布到 npm）
  lib/index.js                 Host 半边：事件订阅 + 回环桥 + 发现文件
  lib/client.js                构建产物（__ModuleLoader__ 工厂格式）
  src/client/pet.js            页面内桌宠：悬浮层 + 指令气泡
  src/client/engine.js         WebGL 网格形变渲染器
  build.mjs                    esbuild → 内联样式表与立绘

packages/dsh-pet-shell/       系统桌面外壳（Electron）
  src/main/index.js            窗口 / 托盘 / 接入策略
  src/main/bridge.js           发现文件 + SSE 客户端
  src/main/harness.js          查找 dsh、拉起 harness、等桥就绪
  src/renderer/pet.js          全局桌宠 UI + 逐像素命中测试

scripts/build-character.mjs   三视图 → 透明立绘（+ 骨架叠图校对）
scripts/fetch-live2d-assets.mjs  Cubism Core + 官方样例模型
resources/character/          立绘与 puppet.json 骨架
```

## 角色是怎么动起来的

默认角色是一张**扁平立绘**（从三视图里裁出的正面），没有分层 PSD，也就没有 Cubism 模型。渲染器把它当成可形变网格：`puppet.json` 用椭圆区域标出头发、呆毛、鲸尾鳍、裙摆、躯干、双眼、嘴巴，每个网格顶点按覆盖它的区域权重位移。

**为什么用 WebGL 而不是多次 `drawImage`**：逐格 2D blit 会让每个格子独立重采样，相邻格永远对不齐，整张图会浮出一层网格缝（这是我实际踩过的坑，改大过绘量只会让缝更明显）。一张纹理网格天然在格子边界连续。

**为什么必须预乘 alpha**：`blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` 会把 alpha 也二次相乘（`dstA = srcA²`），半透明的白色蕾丝和灰色阴影会变成白色雾团和灰色横带。着色器里预乘、配合 `blendFuncSeparate(ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)` 才对。

真 Live2D 模型仍然是更好的答案。渲染后端只需要满足 `setMood` / `setTalking` / `setPointer` / `dispose` 四个方法，换后端不用动 UI。

```bash
pnpm assets:character           # 重新生成透明立绘
pnpm assets:character:debug     # 额外输出骨架叠图，用来核对区域坐标
pnpm assets:live2d              # 拉取 Cubism Core + 官方免费样例模型
```

`fetch-live2d-assets.mjs` 从 Live2D 官方渠道下载，产物不进版本库：Cubism Core 与官方样例模型属于专有素材，可以随应用分发，但不能作为独立文件再分发。

## 安全边界

回环桥是这套设计里唯一新增的对外面：

- 只绑 `127.0.0.1`，端口由内核分配；
- 每个请求都要 `Authorization: Bearer <64 位随机密钥>`，密钥每进程重新生成；
- 密钥与端口写在 `$DSH_HOME/live2d-pet/bridge.json`（0600），插件卸载时删除；
- 暴露的内容就是 GUI 本来就显示的会话元数据；
- 下指令走 `sessionController.prompt`，和浏览器输入框是同一条路径，不绕过审批、策略或日志。

## 真 Live2D 模型（psd2live 流水线）

除了网格形变，仓库里还有一条**从分层 PSD 生产真正 Cubism 模型**的流水线，产物在 `resources/live2d/models/whale-maid/`：

```
whale-maid.moc3            226 KB   MOC3 v5
whale-maid.model3.json             8 个 FileReference 全部可解析
whale-maid.cdi3.json               18 参数 / 6 组 / 7 部件
whale-maid.physics3.json           前发 + 后发 + 果冻眼
whale-maid.idle/blink/nod/shake    6 秒无缝循环待机 + 眨眼/点头/摇头
whale-maid.4096/texture_00.png     4096² 图集
whale-maid.cmo3            2.0 MB   可在 Cubism Editor 里二次编辑
```

流程是：三视图 → 自动语义分层（27 层，按 psd2live 的 See-Through 命名规范）→ PSD → psd2live 绑骨导出。

```bash
pnpm pipeline:live2d        # 全流程；或分步见 scripts/live2d-*.sh
node live2d-pipeline/tools/verify.mjs   # 23 项断言
```

**诚实的边界**：分层里的**像素是精确的**（重新合成与源图逐像素相等，max|Δ|=0），但**语义标签有一部分是近似**——原画没有真正的分层信息，头发前后、头饰、尾鳍、脸的额头都是几何/颜色启发式切出来的；"发丝搭在深蓝衣服上"那一处是最弱的分割。中性姿态下看不出来，让那些部件单独形变时才会露馅。另外原画没有眉毛（被刘海完全遮住），要做眉毛动画得先补画。

## 已知限制

- **壳里换角色要重启**：立绘与骨架在构建时内联进 bundle。
- **官方桌面端还没发安装包**：`deepseek-harness` 仓库里已有 `apps/desktop`，但 npm 上没有包、也没有安装包。插件本身在官方桌面端里能跑（同一套客户端运行时），全局悬浮窗口那部分要等它放出窗口 API。
- **默认角色仍是网格形变**：真 `.moc3` 已经产出并校验，但插件还没有接 Cubism 渲染后端（需要 Cubism Core + `pixi-live2d-display`）；目前两套并存，切换是下一步。
- **模型只在 neutral pose 下验证过像素级正确**：眨眼看/口型/物理在真实渲染器里的表现尚未目视确认——本机没有能跑起来的 Cubism 预览环境。

## 同步到 GitHub

本仓库对应 **https://github.com/br0ny4/dsh-live2d-pet**，更改随做随同步：

```bash
./scripts/sync.sh "fix: 修掉抠图的通道步长 bug"
```

两点须知：

- 仓库自己的 `.git/config` 里把 `http.proxy` 置空了。这台机器的**全局** git 配置指向 `127.0.0.1:7890`，而那个代理并不总在运行——不覆盖的话 `git push` 会直接连不上。全局配置没有被改动。
- `scripts/fetch-live2d-assets.mjs` 抓下来的 Cubism Core 与官方样例模型按 Live2D 的许可**不入库**；`live2d-pipeline/build`（420 MB 的 Gradle 发行版）与中间图层同样不入库。仓库里的 `resources/live2d/models/whale-maid/` 是本项目自己产出的模型。

## 许可

MIT。角色立绘来自使用者提供的原画，请自行确认其可用性。
