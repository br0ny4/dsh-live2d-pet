# 架构

## 为什么是两层

需求是"桌面上有一只角色，能看出 harness 在干什么，也能给它下指令"。这两件事落在两个不同的进程里：

- **状态与指令**住在 harness 进程里。它掌握会话、agent 状态、模型路由。
- **系统桌面**只有 OS 级窗口能占。浏览器页面的物理边界就是页面本身，无论往哪个插槽里注册 UI，都出不了 harness 窗口。

所以：**插件**负责把 harness 的事实拿出来，**Electron 外壳**负责把它画到桌面上。两边共用同一份角色引擎，是同一只角色而不是两套实现。

```
                  ┌───────────────────────────────────────────────┐
                  │ harness 进程（dsh web / 官方桌面端）            │
   浏览器页面 ─────┤  dsh-live2d-pet                                │
  （页内桌宠）     │   client 半边 → shell.overlay 悬浮层           │
                  │   host   半边 → 订阅事件 → 回环桥 → 发现文件    │
                  └───────────────────┬───────────────────────────┘
                                      │  127.0.0.1:<内核分配端口>
                                      │  Authorization: Bearer <64 位随机密钥>
                                      │  $DSH_HOME/live2d-pet/bridge.json (0600)
                  ┌───────────────────┴───────────────────────────┐
   系统桌面 ───────┤  dsh-pet-shell（Electron）                     │
  （全局悬浮）     │   透明 / 置顶 / 逐像素鼠标穿透                  │
                  └───────────────────────────────────────────────┘
```

## 插件在 harness 里的接入点

| 用途 | 接入点 | 为什么是它 |
|---|---|---|
| 页内桌宠的落点 | `shell.overlay` 插槽 | 产品预留的"整帧浮层"锚点，本就给徽标/吐司/状态胶囊用；该层默认鼠标穿透，由内容决定是否接管指针，所以桌宠浮在所有栏位之上又不会挡住应用 |
| 会话状态 | `props.useSessions` 标准钩子 | 与侧边栏、输入框同源，不额外拉一条 RPC |
| 下发指令 | `ctx.sessions.binding(id).session.prompt(...)` | 与浏览器输入框完全同一条路径，不绕过审批、策略或日志 |
| 后端状态（给外壳用） | `ctx.on(...)` 订阅 Host 事件 | 见下表；全是真实事件，没有轮询私有接口 |

选择器只返回字符串这类原始值。会话列表在流式输出期间每个事件都会更新，选对象会让桌宠跟着重渲染。

## 状态派生

| Host 事件 | 相位 | 桌宠表现 |
|---|---|---|
| `agent/status` → `running` | `thinking` | 快速上下浮动、张嘴 |
| `session/event` `tool/call` | `tool` | 气泡显示正在调用哪个工具 |
| `session/event` `assistant/message` | 不变，取最后一段助手文本 | 气泡显示它在说什么 |
| `session/event` `turn/end` `completed` | `done` | 跳一下，绿色徽标 |
| `turn/end` `error` / `aborted` / `blocked` | `error` | 抖动，红色徽标 + 原因 |
| `agent/error`、`api-session/error` | `error` | 同上，气泡显示错误信息 |
| `running` 且 45 秒无事件 | `waiting`（搁置） | 几乎静止、呼吸变慢、黄色徽标 |
| 其余 | `idle` | 常态呼吸 + 随机眨眼 |

`waiting` 是刻意做成"看起来就不一样"的：忙是动的，卡住是静的。两种窗口期可配置：

```yaml
# profile 的 cordis.patch.yml
- id: live2d-pet
  config:
    waitingAfterMs: 45000    # 多久没事件算搁置
    phaseLingerMs: 20000     # 完成/报错在屏幕上停留多久
```

另外，`turn/end` 与 `agent/error` 必须**覆盖**上一条助手文本，否则报错时气泡里还挂着上一轮的话——这是早期真实踩过的 bug，测试里有专门一条断言。

## 桥协议

外壳从不说 harness 的 web RPC，只跟插件自己的这个小接口打交道，因此不受 harness 内部协议变化影响。

### 发现文件

`$DSH_HOME/live2d-pet/bridge.json`，权限 `0600`，插件卸载时删除：

```json
{
  "version": 1,
  "name": "dsh-live2d-pet",
  "port": 51421,
  "secret": "<64 位十六进制>",
  "pid": 27196,
  "startedAt": 1789984150985
}
```

`version` 是协议版本。外壳会拒绝不认识的版本；只有"新增可选字段且旧外壳能安全忽略"时才不进位。

### 路由

全部要求 `Authorization: Bearer <secret>`，否则 `401`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/state` | 当前完整快照 |
| `GET` | `/v1/events` | SSE 流；先发一份完整快照，之后每次状态变化推一份 |
| `POST` | `/v1/prompt` | `{ sessionId, text, mode }` → 转发给 `sessionController.prompt` |

快照形状：

```json
{
  "ok": true,
  "version": 1,
  "revision": 12,
  "at": 1789984150985,
  "waitingAfterMs": 45000,
  "focus": "session-...",
  "sessions": [
    { "id": "session-...", "title": "…", "cwd": "…", "running": true,
      "phase": "tool", "detail": "bash", "updatedAt": 1789984150000 }
  ]
}
```

`focus` 是最近有动静的会话；`detail` 按相位取不同的事实（报错时是错误信息，调用工具时是工具名，其余是最后的助手文本）。

### 安全边界

- 只绑 `127.0.0.1`，端口由内核分配；
- 每个请求都要随机密钥，密钥每进程重新生成；
- 暴露的内容就是 GUI 本来就显示的会话元数据；
- 下指令走 `sessionController.prompt`，与浏览器输入框同一条路径；
- 全部生命周期挂在 Cordis fiber 上，插件卸载即关闭服务并删除发现文件。

## 角色注册表

角色是「一个目录 + 一份 `character.json`」。三个根按顺序查找，先命中的赢，所以把同 id 的角色放进用户目录就能覆盖内置的：

1. `$DSH_HOME/live2d-pet/characters` —— 用户导入的
2. `<插件包>/characters` —— 随包分发的内置角色（构建时从 `resources/characters` 拷入）
3. `<仓库>/resources/characters` —— 开发时（link 安装）的兜底

两个宿主读的是同一份注册表，但通路不同，因为**浏览器页面只能请求自己的源**，够不到桌宠外壳用的回环桥：

| 宿主 | 通路 | 鉴权 |
|---|---|---|
| 页面内桌宠 | `webServer.register({kind:'prefix'})` 挂到 `/dsh-live2d-pet/characters` | 同源，浏览器已有会话 |
| 系统全局桌宠 | 回环桥 `/v1/characters[/<id>]` | bearer 随机密钥 |

两条都返回 `{ manifest, rig, sprite(base64) }`。同源路由只暴露角色素材——这些素材本来就在包里公开分发——因此不需要额外的授权层；它绑在回环地址上，作用域仅限本机。

## 渲染

角色是一张扁平立绘（从三视图裁出的正面），没有分层 PSD，也就没有 Cubism 模型。渲染器把它当作可形变网格：骨架 `puppet.json` 用椭圆区域标出头发、呆毛、鳍、裙摆、躯干、双眼、嘴，每个网格顶点按覆盖它的区域权重位移。

**为什么是 WebGL 而不是多次 `drawImage`**：逐格 2D blit 会让每个格子独立重采样，相邻格永远对不齐，整张图会浮出一层网格缝。当时把过绘量从 1px 加到 3px 反而让缝更明显，因为根因不是缝隙而是重采样。一张纹理网格天然在格子边界连续。

**为什么必须预乘 alpha**：`blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` 会把 alpha 也二次相乘（`dstA = srcA²`），半透明的白色蕾丝和灰色阴影会变成白色雾团与灰色横带。正确做法是着色器里预乘、配合 `blendFuncSeparate(ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`。

### 行为层

形变之上还有一层「什么时候动」的调度——表现力主要来自时机，而不是幅度：

| 状态 | 来源 | 表现 |
|---|---|---|
| 情绪 | 会话相位 | 思考 / 执行 / 搁置 / 完成 / 报错各有体态 |
| 打盹 | 待命超过 `sleepAfterMs`（默认 120s） | 闭眼、呼吸减到 0.22 倍、飘 `z` |
| 戳 | 点击（非拖动） | 起跳 + 感叹号，并唤醒 |
| 拖动 | 窗口移动速度 | 摆动区域按 `(1 - v)` 权重滞后，松开后按 0.86 衰减 |
| 视线 | 光标，或无人时的随机目标 | 眼睛跟随；闲置时每 1.8–5s 换一个注视点 |

徽记（`z`、感叹号、星、汗滴）画在一张**独立的覆盖画布**上：拥有 WebGL 上下文的 canvas 永远拿不到 2D 上下文，早期把它们画在主画布上的代码每帧抛异常却看不出异常——现在渲染进程的任何错误都会让冒烟测试失败。

渲染后端只需要满足这几个方法，换后端不用动 UI：

```js
createCharacter(canvas, { rig, sprite }) -> {
  setMood(mood), setTalking(bool), setPointer(x, y, active),
  react(kind), setDragging(active, vx, vy), setSleepAfter(ms), dispose()
}
```

骨架是自动推导的（`scripts/lib/rig.mjs`）：轮廓包围盒 → 头部色带内用**自适应阈值**（最暗的 12%，而不是固定亮度，否则换一种画风就失效）找成对的深色团块当眼睛 → 暖色团块当喙/嘴 → 其余按比例。推导不出来会退回比例估算并在报告里说明。角色目录里的 `rig.overrides.json` 可以按名字替换任意区域。

真 Live2D 模型仍然是更好的答案，`.moc3` 已经产出（见 `live2d-pipeline/`），接入 Cubism 后端是下一步。

## 窗口行为

桌宠窗口默认 `setIgnoreMouseEvents(true, { forward: true })`——整窗鼠标穿透，但仍接收转发的移动事件。渲染进程拿精灵图自己的 alpha 通道做**逐像素命中测试**，只在光标真正落在角色身上（或指令面板上）时把窗口切回可交互。因此它浮在所有应用之上，却从不挡住任何一次点击。
