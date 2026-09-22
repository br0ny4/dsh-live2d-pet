#!/usr/bin/env node
/**
 * Fetch the 咕咕嘎嘎 sprite atlas and prepare it as a built-in character.
 *
 * Provenance, stated plainly:
 *
 *   - The character is the viral "咕咕嘎嘎" chibi penguin, a community meme
 *     based on the Endministrator from Hypergryph's Arknights: Endfield.
 *   - The public asset situation is triple-contested: the B站 creator who
 *     posted the defining image has registered it and pursued commercial users,
 *     and ByteDance has also filed an artwork registration. NOBODY can grant a
 *     clean licence for this character, and the source repository below has no
 *     licence file at all.
 *   - The project owner was informed of all of this and explicitly decided to
 *     ship it anyway. The PROVENANCE.md written beside the asset records the
 *     facts so nobody is misled about what can and cannot be done with it.
 *
 * Technically this is a Codex-pet sprite atlas: 1536x1872, 8 rows x 9 columns
 * of 192x208 cells, one animation per row. The pet renders at 124 CSS px wide,
 * so 192-px frames are native resolution, not an upscale.
 *
 *   node scripts/fetch-gugu-assets.mjs [--force]
 */
import { mkdir, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'resources', 'characters', 'gugu')

const REPO = 'guleguleguru/gugugaga-pet'
const BRANCH = 'main'
const ATLAS_PATH = 'guga-lively/spritesheet.webp'
const ATLAS_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${ATLAS_PATH}`

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

const force = process.argv.includes('--force')
const sourcePath = join(DIR, 'source.webp')

if (!force && (await exists(sourcePath))) {
  console.log(`source.webp already present (${sourcePath}) — pass --force to refetch`)
} else {
  const response = await fetch(ATLAS_URL, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${ATLAS_URL}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await mkdir(DIR, { recursive: true })
  await writeFile(sourcePath, bytes)
  console.log(`source.webp  ${(bytes.length / 1024).toFixed(0)} KB  <- ${REPO}/${ATLAS_PATH}`)
}

// WebP is fine in every renderer this project uses, but PNG keeps the asset
// format uniform and immune to future encoder changes in sharp.
const pngPath = join(DIR, 'atlas.png')
const meta = await sharp(sourcePath).metadata()
await sharp(sourcePath).png().toFile(pngPath)
console.log(`atlas.png    ${meta.width}x${meta.height} -> ${(meta.width * 0 + 1) && ''}converted`)

// The animation rows. Codex atlases carry no machine-readable row labels, so
// these come from the upstream README's behaviour descriptions plus per-row
// motion analysis (see tools/network/../README? no — see the character
// manifest). If a row looks wrong in the pet, fix it here and rebuild.
const animations = {
  idle: { row: 0, frames: 7, fps: 4 },
  working: { row: 1, frames: 9, fps: 6 },
  waiting: { row: 2, frames: 9, fps: 4 },
  done: { row: 3, frames: 5, fps: 6 },
  poke: { row: 4, frames: 6, fps: 8 },
  error: { row: 5, frames: 9, fps: 5 },
  sleep: { row: 6, frames: 7, fps: 2 },
}

const manifest = {
  id: 'gugu',
  name: '咕咕嘎嘎',
  description: '终末地管理员二创企鹅：黑色毛绒外套、白肚皮、黄嘴黄脚。帧动画角色。',
  author: 'guleguleguru/gugugaga-pet',
  license: '无许可证；形象为多方争议 IP。见 PROVENANCE.md。',
  builtin: true,
  order: 20,
  kind: 'atlas',
  atlas: 'atlas.png',
  grid: { cols: 9, rows: 8, cellWidth: 192, cellHeight: 208 },
  animations,
  moodMap: {
    idle: 'idle',
    thinking: 'working',
    working: 'working',
    waiting: 'waiting',
    done: 'done',
    error: 'error',
    sleeping: 'sleep',
  },
}

await writeFile(join(DIR, 'character.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log('character.json written')

await writeFile(join(DIR, 'PROVENANCE.md'), [
  '# 来源与权利说明（如实）',
  '',
  '| | |',
  '|---|---|',
  '| 角色 | 「咕咕嘎嘎」企鹅 —— 社区迷因，形象基础为《明日方舟：终末地》的「管理员」二创企鹅形态 |',
  '| 素材 | ' + ATLAS_PATH + '（Codex 桌宠 8×9 帧图集，192×208/帧） |',
  '| 来源仓库 | https://github.com/' + REPO + ' |',
  '| 仓库许可证 | **无许可证文件**（默认保留所有权利） |',
  '| 取得的许可 | **无**。任何人都无法为这个形象给出干净授权 |',
  '',
  '## 权利现状（本项目已如实告知，仍按所有者决定使用）',
  '',
  '- 该形象的底层 IP 属于 **Hypergryph**（《明日方舟：终末地》）。',
  '- 定义性 AI 图片由 B 站创作者于 2026-02 发布，其已完成**著作权登记**并曾向商用使用者主张权利。',
  '- **字节跳动**随后也对该美术形象登记了著作权，被广泛报道为「抢注」。',
  '',
  '三个主张方并存，因此本项目**不主张、也不暗示**对该形象的任何权利或任何方对本项目的背书。使用这份素材的风险由使用者自行承担；若你分发本项目，请保留本文件。',
  '',
  '## 技术说明',
  '',
  '帧动画图集以原始分辨率使用（桌宠显示宽度 124px，帧宽 192px 是原生分辨率，非放大）。行序无机器可读标签，character.json 的 animations 来自上游 README 行为描述 + 逐行运动特征分析；若某个动作与状态不匹配，改 animations 里的行号重建即可。',
].join('\n') + '\n')
console.log('PROVENANCE.md written')
