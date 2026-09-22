#!/usr/bin/env node
/**
 * Fetch the high-quality source art for the built-in whale-maid character.
 *
 * The first version of this character was cropped out of a three-view JPEG
 * found online: low resolution, JPEG ringing, no tail, and a home-made matte.
 * This fetches a purpose-drawn, transparent, two-frame idle instead — the same
 * character, drawn at 1448x1086 with an open-eye and a closed-eye frame, which
 * is what makes a real frame-based blink possible.
 *
 * Source: https://github.com/YunYueSama/codex-deepseek-pet
 * Licence: 大肥鱼项目署名许可 1.0 — free to use, modify and redistribute,
 *          including commercially, provided the author and repository are
 *          credited and the licence text is kept. See the LICENSE-ASSET.md
 *          written beside the art.
 *
 *   node scripts/fetch-whale-maid-art.mjs [--force]
 */
import { mkdir, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'resources', 'characters', 'whale-maid')

const REPO = 'YunYueSama/codex-deepseek-pet'
const BRANCH = 'main'
const ART_PATH = 'design/sources/idle-hq-v1/idle-pair.png'
const LICENCE_PATH = 'LICENSE'

const ART_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${ART_PATH}`
const LICENCE_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${LICENCE_PATH}`

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
  return bytes.length
}

const force = process.argv.includes('--force')
const artPath = join(DIR, 'source.png')

if (!force && (await exists(artPath))) {
  console.log(`source.png already present (${artPath}) — pass --force to refetch`)
} else {
  const bytes = await download(ART_URL, artPath)
  console.log(`source.png   ${(bytes / 1024).toFixed(0)} KB  <- ${REPO}/${ART_PATH}`)
}

const licencePath = join(DIR, 'LICENSE-ASSET.md')
if (force || !(await exists(licencePath))) {
  const licence = await download(LICENCE_URL, join(DIR, 'LICENSE-ASSET.txt'))
  console.log(`LICENSE-ASSET.txt  ${(licence / 1024).toFixed(1)} KB  <- ${REPO}/${LICENCE_PATH}`)

  // The upstream licence must travel with the material it covers, and it also
  // requires that modifications be declared — so the notice is generated here
  // rather than typed by hand, and records exactly what we changed.
  await writeFile(licencePath, `# 素材来源与许可

本目录下的角色素材来自第三方项目，**不是**本项目的原创作品。

| | |
|---|---|
| 作者 | YunYueSama |
| 仓库 | https://github.com/YunYueSama/codex-deepseek-pet |
| 原始文件 | \`${ART_PATH}\` |
| 许可 | 大肥鱼项目署名许可 1.0（全文见同目录 \`LICENSE-ASSET.txt\`） |
| 取得方式 | \`node scripts/fetch-whale-maid-art.mjs\` |

许可允许使用、修改、分享与商用，条件是**保留署名、保留完整许可文本、并说明修改内容**。

## 本项目所做的修改

- 将原始的两格合并图拆成两张独立帧：\`character.png\`（睁眼）与 \`character-blink.png\`（闭眼），
  两者裁切到**同一个包围盒**以保证逐像素对齐；
- 按桌宠尺寸生成 \`character-pet.png\` 与 \`character-pet-blink.png\`（240px 宽）；
- 自动推导形变骨架 \`puppet.json\`，并叠加人工修正（\`rig.overrides.json\`）；
- 未对画面内容本身做任何绘制或改动。

## 关于角色本身

「DeepSeek 鲸鱼娘 / 大肥鱼」是社区二创角色，源自网友对 DeepSeek 模型的二次创作。
上游作者明确指出：本许可**不授予**底层参考作品、角色设计与商标的额外权利，
也**不代表 DeepSeek 官方**授权或认可。使用本素材时请一并遵守上游许可的全部条款。
`)
  console.log(`LICENSE-ASSET.md    written (attribution + modification notice)`)
}
