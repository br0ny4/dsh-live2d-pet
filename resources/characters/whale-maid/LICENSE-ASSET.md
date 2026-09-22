# 素材来源与许可

本目录下的角色素材来自第三方项目，**不是**本项目的原创作品。

| | |
|---|---|
| 作者 | YunYueSama |
| 仓库 | https://github.com/YunYueSama/codex-deepseek-pet |
| 原始文件 | `design/sources/idle-hq-v1/idle-pair.png` |
| 许可 | 大肥鱼项目署名许可 1.0（全文见同目录 `LICENSE-ASSET.txt`） |
| 取得方式 | `node scripts/fetch-whale-maid-art.mjs` |

许可允许使用、修改、分享与商用，条件是**保留署名、保留完整许可文本、并说明修改内容**。

## 本项目所做的修改

- 将原始的两格合并图拆成两张独立帧：`character.png`（睁眼）与 `character-blink.png`（闭眼），
  两者裁切到**同一个包围盒**以保证逐像素对齐；
- 按桌宠尺寸生成 `character-pet.png` 与 `character-pet-blink.png`（240px 宽）；
- 自动推导形变骨架 `puppet.json`，并叠加人工修正（`rig.overrides.json`）；
- 未对画面内容本身做任何绘制或改动。

## 关于角色本身

「DeepSeek 鲸鱼娘 / 大肥鱼」是社区二创角色，源自网友对 DeepSeek 模型的二次创作。
上游作者明确指出：本许可**不授予**底层参考作品、角色设计与商标的额外权利，
也**不代表 DeepSeek 官方**授权或认可。使用本素材时请一并遵守上游许可的全部条款。
