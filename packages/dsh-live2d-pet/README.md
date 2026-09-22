# dsh-live2d-pet

给 **DeepSeek Harness** 用的桌宠插件：一只浮在界面上的角色，点一下弹出指令气泡，把你要说的话直接送进选中的会话；它会一边看你干活一边动——思考和执行时轻轻晃，流式输出时张嘴，回合报错时抖一下。

在 Web GUI 和官方 Electron 桌面端里都能跑，因为两边是同一套客户端运行时。

## 两种存在方式

这个包含两半，对应两种用法：

- **页面内桌宠（客户端半边）** —— 注册进 `shell.overlay` 插槽，浮在 harness 窗口里。装上就能用，本节以下都在讲它。
- **系统全局桌宠（Host 半边 + 外壳）** —— 浏览器页面的物理边界就是页面本身，无论怎么注册插槽都出不了窗口。所以 Host 半边会开一个**仅回环、带随机密钥**的本地桥，把会话状态实时推出去；配套的 Electron 外壳 [`dsh-pet-shell`](../dsh-pet-shell/) 用透明置顶窗口把同一只角色画到系统桌面上。

两条路共用同一个角色引擎，所以是同一只角色。桥的协议规格与安全边界见 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)。

## 角色

自带两个，界面上可随时切换，选择会记住：**DeepSeek 鲸鱼娘**（默认）与**企鹅 Pip**（本项目原创，MIT）。

用自己的三视图导入：

```bash
node scripts/character.mjs add --from ~/我的角色.png --id my-character --name "我的角色"
```

白底参考稿和已抠好的透明 PNG 都支持，会自动抠图、自动绑骨并输出骨架叠图。完整说明见仓库的 [`docs/CHARACTERS.md`](../../docs/CHARACTERS.md)。

## 它长什么样

- 右下角浮着角色，**可拖到任意位置**（位置只存在当前页面里）
- **点一下**打开指令气泡，右上角小圆点表示状态：灰=待命、蓝闪=执行中、绿=刚完成、红=出错
- 气泡里可以切换目标会话（下拉框里是当前可见的会话，`●` 表示正在跑）
- 支持**排队**（默认，排在当前回合之后）和**插话**（`steer`，打断正在执行的回合）两种投递模式
- `⌘/Ctrl + Enter` 直接发送
- 角色会**用眼睛跟着鼠标**；没人理它时会自己东张西望
- 长时间待命会**打盹**（闭眼、呼吸变慢、飘 `z`）
- **戳一下**会跳起来冒感叹号；拖动时下半身会滞后于身体

## 安装

从仓库本地安装（当前方式）：

```bash
pnpm build
dsh plugin --profile web add ./packages/dsh-live2d-pet
```

发布到 npm 之后可以直接按包名安装：

```bash
dsh plugin --profile web add dsh-live2d-pet
```

装完重启 DSH 即可。卸载：

```bash
dsh plugin --profile web remove dsh-live2d-pet
```

## 它是怎么工作的

页面内这一半不新开端口、不起进程、不碰私有接口。它只做两件事：

**1. 在 `shell.overlay` 插槽里注册一个悬浮层**

`shell.overlay` 是产品自己留的"整帧浮层"锚点，本来就是给徽标、吐司、状态胶囊这类东西用的，且这一层默认鼠标穿透、由内容自己决定要不要接管指针。所以桌宠既能浮在所有栏位之上，又不会挡住下面的应用。

**2. 通过产品自己的会话服务发指令**

点发送时调用的是与输入框同一条路径：

```js
const binding = ctx.sessions.binding(sessionId)
await binding.session.prompt(
  [{ type: 'text', text }],
  'queue',                    // 或 'steer' 插话打断
  undefined,
  requestId,
)
```

`requestId` 会作为 `rpcId` 落到会话日志里，和你在输入框里手敲一条消息没有区别——所以会话列表、轨迹、统计都照常认它。

角色状态也来自同一个快照（`useSessions` 标准钩子），没有轮询、没有额外 RPC：

```js
const runningId = props.useSessions((s) => s.ids.find((id) => s.byId[id]?.running) || '')
```

> 选择器只返回字符串这类原始值。会话列表在流式输出期间每个事件都会更新，选对象会让桌宠跟着重渲染。

## 角色是怎么动起来的

默认角色是一张**扁平立绘**（三视图里裁出来的正面），没有分层 PSD，也就没有 Cubism 模型。所以渲染器把它当成一张可形变的网格：`puppet.json` 用一组椭圆区域标出头发、呆毛、鲸尾鳍、裙摆、躯干、双眼、嘴巴，渲染时把图切成网格逐格重绘，每格按覆盖它的区域权重做位移。

这样就有了"活着"所需要的全部小动作——头发飘、尾鳍扇、胸腔呼吸、**真正闭合的眨眼**、以及 agent 说话时一张一合的嘴——而且不需要 Cubism 运行时、不需要 Cubism Core 二进制、不需要有人去 Cubism Editor 里绑一次骨。

```
src/client/engine.js   # 网格形变渲染器
puppet.json            # 区域骨架（归一化坐标，椭圆 +  feather 权重）
```

真 Live2D 模型仍然是更好的答案。渲染后端只需要满足 React 层用到的那四个方法（`setMood` / `setTalking` / `setPointer` / `dispose`），换后端不用动 UI。

## 开发

```bash
pnpm install
pnpm --filter dsh-live2d-pet build     # 产出 lib/client.js
```

客户端产物不是普通 ESM：DSH 的客户端插件是交给 `window.__ModuleLoader__` 的自注册工厂，`require` 由加载器提供（React 加上 `dsh.client.inject` 里声明的包）。`build.mjs` 用 esbuild 打包并把**样式表和角色立绘一起内联**，所以运行时不会去取任何外部资源。

本地调试时把包装进 profile 用的是 link，改完重新 build、重启 DSH 即可：

```bash
dsh plugin --profile web add /绝对路径/packages/dsh-live2d-pet
```

## 许可

MIT。角色立绘来自使用者提供的原画，请自行确认其可用性。
