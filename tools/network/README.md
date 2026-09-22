# 网络诊断工具与 api.deepseek.com 故障定位

这些工具用来定位一个真实的、反复出现的问题：**DeepSeek API 请求成簇失败**。

## 已确定的结论

| 事实 | 证据 |
|---|---|
| 失败是**连接级 RST**，不是超时/限流/DNS | `ECONNRESET, errno -54, syscall=read`，全部 <1s 失败 |
| **全新 socket 也失败**，不是 keep-alive 复用旧连接 | `probe-transport.mjs` 关闭 keep-alive 后依旧成簇失败 |
| 失败是**突发窗口**，窗口过了 100% 恢复 | 连续探测：某一分钟内 100% 失败，下一分钟 100% 成功 |
| **同一 IP 换一个 TLS SNI 就通** | `probe-sni2.mjs`：SNI=api.deepseek.com 被 RST；同一秒 SNI=www.example.com 到同一 IP 完成握手（只剩证书校验失败，属预期） |
| 百度在同一秒永远正常 | 同探针控制组 |
| 路由跨运营商 | UDP traceroute：百度走联通骨干（219.158/202.97/222.222），api.deepseek.com 走 58.144.x（移动），中间经 172.18.28.38 运营商 NAT |

**结论**：路径上有一个**按 SNI 选择性干扰的中间设备**（DPI/流控类），对 `api.deepseek.com` 的连接在突发窗口内注入 RST。这解释了"为什么只有 DeepSeek 出问题"：百度走本网路径且不在过滤名单上，DeepSeek 跨网且 SNI 被命中。

## 复现

```bash
cd tools/network
# 基线：默认连接池，突发请求（曾复现 8/30、28/36、连续 100% 失败）
node probe-transport.mjs 12 10
# 关闭 keep-alive 后依旧失败（排除旧连接假说）
STABLE=1 node probe-transport.mjs 12 10
# 分相位 + 假 SNI 对照（失败发生在 read/tls 阶段，假 SNI 同秒正常）
node probe-sni2.mjs 30
```

## 找到"是哪个设备发的 RST"（需要 root）

下面的命令需要在终端里用 `sudo` 跑（我这个环境没有密码无法代跑）。

```bash
# 1. 抓包，复现一次失败后 Ctrl-C
sudo tcpdump -ni en0 -s 0 -w /tmp/ds.pcap 'host 116.169.184.167 or host 58.144.195.181'

# 2. 看 RST 是谁发的
sudo tcpdump -r /tmp/ds.pcap -nn -ttt 'tcp[tcpflags] & tcp-rst != 0'

# 3. TCP traceroute（比 UDP/ICMP 更贴近真实数据路径）
brew install tcptraceroute
sudo tcptraceroute -q 1 -f 1 -m 20 -p 443 api.deepseek.com

# 4. TTL 判远近：同一抓包里，对比服务器 SYN-ACK 与 RST 的 TTL
sudo tcpdump -r /tmp/ds.pcap -nn -v 'tcp and (tcp[tcpflags] & tcp-syn != 0 or tcp[tcpflags] & tcp-rst != 0)' | head
#   RST 的 TTL ≈ 服务器 SYN-ACK 的 TTL（差 ≤2）→ 对端/服务器侧发出；
#   RST 的 TTL 明显更大（差 ≥5）→ 离你更近的设备伪造，对照 traceroute 第 2~8 跳归属。
```

把抓包结果对照 traceroute 每一跳的归属，就能确定是**运营商互联节点、企业出口设备还是 aTrust 类安全软件**。

## 工程化缓解

抓包定位是"知道是谁"，但链路设备通常改不动。工程侧的做法是 **failover**：

- [`packages/dsh-route-failover`](../../packages/dsh-route-failover/README.md)：连续 N 次 TRANSPORT 失败后把会话切到备用路由（如内网 vLLM），主路由恢复后自动切回。它不能阻止 RST，但能让你的回合不再死掉。
- 使用代理（如本机 Clash）：让流量从代理自己的出口出去，绕开被过滤的直连路径。

## 工具清单

| 文件 | 用途 |
|---|---|
| `probe-transport.mjs` | 突发请求 + 空闲间隙，复现成簇失败并打印 errno；`STABLE=1` 时禁用 keep-alive |
| `probe-phases.mjs` | 逐相位计时（connect/tls/write/read）+ 同秒假 SNI 与百度对照 |
| `probe-sni2.mjs` | 五路同秒对照：真 SNI / 假 SNI / 第二个 A 记录 / 明文 HTTP / 百度 |

运行前需要 `DEEPSEEK_KEY=sk-...`（或 `/tmp/dskey.txt`）与仓库根目录（`undici` 依赖）。
