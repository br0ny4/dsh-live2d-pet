# dsh-route-failover

**当 `api.deepseek.com` 不可达时，让回合不死掉。**

## 它解决什么问题

这个插件针对一个被实测确认的现象：到 `api.deepseek.com` 的连接在**突发窗口**内被路径上的设备以 `ECONNRESET` 掐断（全新 socket、<1s、按 TLS SNI 选择性命中）。窗口可以持续几分钟到十几分钟，任何有限的重试预算都会被耗尽，每个失败的回合都是一次损失。

完整诊断证据见 [`tools/network/README.md`](../../tools/network/README.md)。

## 行为

| 阶段 | 动作 |
|---|---|
| 会话连续 `threshold` 次 `TRANSPORT` 失败 | 调用 `sessionController.selectModel` 把该会话切到 `fallback` 路由（默认内网 vLLM），模型选择器与日志里可见 |
| 会话已降级 | 不再重复切换；其余失败按正常语义处理 |
| 主路由探测（默认每 60s）连续两次健康 | 自动切回会话**原来的**路由（从会话日志最后一个 `request/header` 读出，不是猜测） |
| 非 `TRANSPORT` 失败（限流/鉴权/配额…） | 重置计数器，绝不切换 |

降级只发生在"网络到不了对端"时；业务错误不会触发误切换。

## 安装

```bash
dsh plugin --profile web add ./packages/dsh-route-failover
# 或发布后：dsh plugin --profile web add dsh-route-failover
```

## 配置

默认值在 `cordis.patch.yml`；在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: route-failover
  config:
    threshold: 3                 # 连续几次 TRANSPORT 后降级
    fallback:
      provider: vllm             # 备用路由（需在 llm-pi-ai 等适配器里已注册）
      model: qwen3.8-27b
    probeIntervalMs: 60000       # 主路由健康探测间隔
    restore: true                # 主路由恢复后自动切回
```

`fallback` 通常填一个**内网/本机**端点（不跨运营商），比如已配好的
`llm-pi-ai` vLLM。如果备用路由不可路由，`selectModel` 会失败并原样记录，
插件不会静默吞掉错误。

## 测试

```bash
node packages/dsh-route-failover/test/failover.test.mjs
```

mock ctx 驱动：阈值行为、按会话隔离、非 TRANSPORT 重置、降级后不再重复切换。

## 边界（如实）

- **第一次触发窗口的头几次失败仍会失败**：降级发生在第 `threshold` 次失败之后，
  当前这一步的重试仍走原路由。它救的是"接下来"，不是"已经发生的"。
- **切换会话模型的同时也会更新全局默认**（`selectModel` 的既有行为）。
- 恢复后切回的是日志里记录的上一路由；会话从未出过 `request/header`
  （空会话）时无法恢复原路由，保持降级状态。
