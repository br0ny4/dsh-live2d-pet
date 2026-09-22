# 角色

项目自带两个角色，也接受你自己的。

| | | |
|---|---|---|
| <img src="images/character-whale-maid.png" width="150" /> | **DeepSeek 鲸鱼娘** | 蓝发、鲸尾鳍耳的女仆装 Q 版角色。默认角色 |
| <img src="images/character-penguin.png" width="150" /> | **企鹅 Pip** | 本项目原创的 Q 版企鹅，大头、奶油色脸腹、薄荷围巾 |

两个都是同一条流水线的产物，也都能在插件和外壳里随时切换。

## 换成别的角色

在指令气泡里有一个「角色」下拉框（只有一个角色时它会隐藏）。选择会记住：

- 页面内桌宠记在浏览器 `localStorage`
- 系统全局桌宠记在 Electron 的 `userData/character.json`

## 用你自己的三视图

```bash
node scripts/character.mjs add --from ~/我的角色.png --id my-character --name "我的角色"
```

`--from` 接受：

- **三视图参考稿**（白底，正面在左边）——取最左那一格，这也正是 `add` 名字里"三视图"的意思；
- **已经抠好的透明 PNG**（单角色即可）——直接用它自己的 alpha 通道，不做抠图。

其他可选参数：`--description`、`--author`、`--license`、`--order`（列表排序，越小越前）、`--panel <n>`（改用第 n 格）、`--force`（覆盖同名角色）。

跑完会打印一份报告和一张**调试叠图**：

```
my-character
  sheet     1320x1200 png (white paper), 3 panel(s), used #0
  crop      416x642
  matte     38.6% paper, 64519 softened edge px
  sprite   416x642
  pet      240x370
  rig      derived — 9 influences
  overlay  resources/characters/my-character/debug-overlay.png  <- check this
```

**去看那张叠图。** 它是唯一能告诉你形变区域落在哪的东西：

<img src="images/character-penguin.png" width="120" />

（叠图长这样：每个椭圆是一个形变区域，标注了名字。图在角色目录里。）

## 形变骨架

`puppet.json` 里的每个区域是一个椭圆，带一个动作类型：

| motion | 效果 | 通常给谁 |
|---|---|---|
| `sway` | 左右摆动 | 头发、呆毛、裙摆、腿 |
| `flap` | 上下扇动 | 鳍、耳朵、翅膀 |
| `breathe` | 起伏（呼吸） | 躯干 |
| `blink` | 竖直压缩（眨眼），同时让眼睛跟随光标 | 双眼 |
| `talk` | 张合（说话） | 嘴 / 喙 |

骨架是**自动推导**的（`scripts/lib/rig.mjs`）：先找轮廓，再在头部色带里用自适应阈值找成对的深色团块当眼睛，再找喙/嘴、呆毛、躯干、两侧鳍、脚。推导不出来时会退回到比例估算，并在报告里说一句 `eye detection fell back to proportions`。

推导结果是**起点而不是定论**。要改就写 `rig.overrides.json` 放在角色目录里，按名字替换任意区域，不用动自动推导出来的那份：

```json
{
  "influences": [
    { "name": "eyeL", "cx": 0.338, "cy": 0.321, "rx": 0.09, "ry": 0.06 },
    { "name": "mouth", "cx": 0.501, "cy": 0.392, "rx": 0.05, "ry": 0.04, "amp": 0.01 }
  ]
}
```

改完重新构建即可：`node scripts/character.mjs build --id my-character`

## 目录结构

```
resources/characters/<id>/
  character.json      清单：名字、作者、许可、哪个文件是什么
  source.png          你给的稿子，留着以便复现
  character.png       全尺寸透明立绘
  character-pet.png   桌宠实际内联的小图（240px 宽）
  puppet.json         形变骨架
  rig.overrides.json  可选：手工修正
  debug-overlay.png   骨架叠图，用来核对
```

`character.json` 里的 `builtin: false` 表示这是用户导入的；内置角色是 `true`，界面上会标出来。

## 它是怎么被加载的

插件和外壳都从同一份清单读取，但有两条不同的通路 —— 因为浏览器页面只能请求自己的源，够不到桌宠外壳用的回环桥：

| 宿主 | 通路 |
|---|---|
| 页面内桌宠 | 同源路由 `GET /dsh-live2d-pet/characters[/<id>]`（由插件 Host 半边挂在 harness 自己的 web 载体上） |
| 系统全局桌宠 | 回环桥 `GET /v1/characters[/<id>]`，带 bearer 密钥 |

两条都返回同一份 JSON：清单 + 骨架 + base64 立绘。角色目录按这个顺序查找，先命中的赢：

1. `$DSH_HOME/live2d-pet/characters` —— 你的
2. `<包目录>/characters` —— 内置的，构建时拷进来
3. `<仓库>/resources/characters` —— 开发时的兜底

所以**同一个 id 放在第 1 个位置就能覆盖内置角色**，不用改包。

## 关于内置角色的来源

企鹅 Pip 是为本项目**原创设计**的（`scripts/make-penguin-art.mjs` 可复现），不是任何已有迷因或品牌角色的复制。这一点是刻意的：项目以 MIT 分发，混入来源有争议的形象会同时带来法律问题和许可上的自相矛盾。

鲸鱼娘来自项目使用者的原画，随仓库分发。
