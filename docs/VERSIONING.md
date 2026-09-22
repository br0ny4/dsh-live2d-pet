# 版本管理计划

## 一句话

仓库用 **`vX.Y.Z` 标签**标记发布，标签版本与 `packages/*` 里的 `version` 字段保持一致；**插件包单独发布到 npm**，外壳不发布。

## 为什么会需要一份计划

这个项目同时依赖三个会独立变化的版本轴：

| 轴 | 谁在变 | 影响 |
|---|---|---|
| **DSH 本体** | `@deepseek-ai/*`，目前是 `0.1.5-rc.2`（预发布） | 客户端插件 API、Slot 契约、Host 事件签名都可能改 |
| **插件自己** | 本仓库 | 通过 `dsh.client.inject` 声明它依赖哪些 harness 包 |
| **桥协议** | 本仓库 | 插件 Host 半边与 Electron 外壳之间的私有契约 |

DSH 还没发 1.0，它的客户端 API 没有兼容承诺。所以"我们的补丁版本"在别人机器上可能因为 harness 升级而失效——这一点必须显式管理，而不是靠 semver 自动推断。

## 版本号规则

预 1.0 阶段（`0.y.z`）沿用 semver 的语义，但**把 harness 兼容性当作 breaking 信号**：

| 变化 | 版本位 | 例子 |
|---|---|---|
| **破坏性**：桥协议字段/语义变更、`shell.overlay` 注册 id 变更、要求的 harness 版本跃迁、配置字段改名或删除 | **minor**（`0.y` 进位） | 桥协议 `version` 从 1 升到 2；最低 harness 从 0.1.5 提到 0.2.0 |
| **新增**：新状态相位、新指令模式、设置项、新角色后端 | **minor** | 加入 `steer` 插话模式 |
| **修复**：不改接口的正确性问题 | **patch** | 修掉抠图的通道步长 bug |
| 进入 1.0 | major | 桥协议与插件公开面冻结，此后按标准 semver |

**判断标准是"别人的使用方式会不会被迫改变"**，不是"我们改了多少代码"。内部重构、渲染算法替换、模型重做都属于 patch。

### 桥协议版本

`bridge.json` 里带一个 `version` 字段（当前为 `1`）。插件与外壳**必须**在这一字段上一致，否则外壳拒绝接入：

- 增删字段或改变字段语义 → `version` 进位，插件 minor 进位；
- 只加可选字段且旧外壳能安全忽略 → `version` 不动。

## 兼容性矩阵

README 里维护一张表，每次发版更新。当前：

| 插件版本 | 最低 DSH | 主机 | 说明 |
|---|---|---|---|
| 0.1.x | `0.1.5-rc.2` | Web GUI | 首个可用版本 |

harness 升级后，若插件的 `dsh.client.inject` 依赖项或 Slot 契约发生变化，**即使插件代码一行没改也要发一个 minor 版本**并在表里标明新的最低版本。

## 发布流程

```bash
# 1. 确认干净且测试通过
pnpm test

# 2. 更新 CHANGELOG.md（把 Unreleased 段落落成具体版本号与日期）

# 3. 三个地方同步版本号
#    - package.json（workspace 根）
#    - packages/dsh-live2d-pet/package.json
#    - packages/dsh-pet-shell/package.json

# 4. 提交、打标签、推送
./scripts/sync.sh "release: v0.2.0"
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0

# 5. 发布插件到 npm（外壳是 private，不发布）
cd packages/dsh-live2d-pet && npm publish

# 6. 在 GitHub 上用 CHANGELOG 对应段落建 Release
```

`v*` 标签触发 `.github/workflows/ci.yml` 的构建检查，但 **npm 发布保持手动**——预发布阶段不想让一次误标自动推包。

## 分支策略

单人维护，**`main` 即发布分支**，没有 develop/release 分支：

- 改动直接提交到 `main`，每个可交付的状态都可发布；
- 大改动可以用短生命周期的 `feat/*` 分支，合并后删除；
- `main` 上的每一次提交都应通过 `pnpm test`（CI 强制）；
- 标签只打在 `main` 上。

## 资产与模型的版本归属

- **角色立绘**（`resources/character/`）：随仓库版本走。`pnpm assets:character` 逐字节可复现，所以它是"可重建的源产物"而非二进制黑盒。
- **Live2D 模型**（`resources/live2d/models/whale-maid/`）：随仓库走，同时记录了生成它的 psd2live 参数（`--atlas 4096 --mesh-spacing 64`）。重做模型＝patch 版本，除非它改变了插件读取的路径或 `model3.json` 契约。
- **下载的官方样例模型**：不入库，不参与版本管理。
- 插件内联的立绘（`lib/client.js` 里的 base64）是构建产物，不入库，由 `pnpm build` 生成。

## 什么不进版本号

- 抠图参数、渲染网格密度、动画频率这类**调参**：改了就是 patch，除非改变了对外表现契约。
- 文档修正、注释、测试补充：不单独发版，搭下一次发布的便车。

## 版本历史

见 [`CHANGELOG.md`](../CHANGELOG.md)。
