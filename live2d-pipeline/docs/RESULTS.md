# RESULTS — measured evidence

All numbers below were produced by the scripts in `../tools/` and can be reproduced with them.
Nothing here is estimated.

---

## 1. Artefacts

### PSD (input to psd2live)

| path | bytes | verified |
|---|---:|---|
| `live2d-pipeline/out/whale-maid.psd` | 2,415,054 | ✅ 8BPS v1, 484×853, depth 8, colourMode 3 (RGB), 4 channels, 27 layers, `noBackground` |
| `live2d-pipeline/out/layer-*.png` | 27 files | ✅ per-layer alpha identical to the PSD's own layer channels |
| `live2d-pipeline/out/layer-stats.json` | — | pixel counts + bboxes per layer |
| `live2d-pipeline/debug/psd-report.json` | — | independent re-parse of the written PSD |

### Model (`resources/live2d/models/whale-maid/`)

| file | bytes | verified |
|---|---:|---|
| `whale-maid.moc3` | **225,856** | ✅ magic `MOC3`, version 5, endianness flag 0 |
| `whale-maid.model3.json` | 757 | ✅ parses; Version 3; all 8 FileReferences exist |
| `whale-maid.cdi3.json` | 4,583 | ✅ parses; 18 parameters, 6 groups, 7 parts |
| `whale-maid.physics3.json` | 8,561 | ✅ parses; Version 3; 3 settings, 10 inputs, 3 outputs, 7 vertices |
| `whale-maid.4096/texture_00.png` | 813,324 | ✅ 4096×4096 PNG, 4 channels, 260,230 non-transparent px |
| `whale-maid.idle.motion3.json` | 2,282 | ✅ 6.0 s loop, 5 curves / 64 segments |
| `whale-maid.blink.motion3.json` | 1,155 | ✅ parses |
| `whale-maid.nod.motion3.json` | 1,751 | ✅ parses |
| `whale-maid.shake.motion3.json` | 1,571 | ✅ parses |
| `whale-maid.cmo3` | 1,996,345 | ✅ present (editable Cubism project) |
| `whale-maid.psd2live.json` | 5,115 | ✅ parses; 30 drawables, 26 deformers, 18 parameters, 1 atlas page |

`resources/live2d/models/manifest.json` got one appended entry
(`whale-maid` → `whale-maid/whale-maid.model3.json`); the seven existing sample
entries are byte-identical to before.

---

## 2. Verification log

`node live2d-pipeline/tools/verify.mjs` → **23 passed, 0 failed**, exit 0:

```
PASS  PSD dimensions 484x853 (expect 484x853)
PASS  PSD bit depth 8 (expect 8)
PASS  PSD colour mode 3 (expect 3 = RGB)
PASS  PSD layer count 27 (expect 27)
PASS  top-most PSD layer is "front hair 2" (expect the ahoge = "front hair 2")
PASS  bottom-most PSD layer is "back hair" (expect "back hair")
PASS  PSD per-layer alpha matches source PNGs for 27/27 layers
PASS  model3.json parses (757 bytes), Version=3
PASS  all 8 FileReferences exist on disk
PASS  moc3 magic "MOC3" (expect "MOC3")
PASS  moc3 size 225856 bytes (>20 KB)
PASS  moc3 version byte=5, endianness flag=0
PASS  texture whale-maid.4096/texture_00.png decodes: 4096x4096 png 4ch (813324 bytes)
PASS  atlas has 260230 non-transparent pixels of 16777216
PASS  whale-maid.cdi3.json parses (4583 bytes) keys=[Version,Parameters,ParameterGroups,Parts,CombinedParameters]
PASS  whale-maid.physics3.json parses (8561 bytes) keys=[Version,Meta,PhysicsSettings]
PASS  whale-maid.idle.motion3.json parses (2282 bytes) keys=[Version,Meta,Curves]
PASS  whale-maid.blink.motion3.json parses (1155 bytes) keys=[Version,Meta,Curves]
PASS  whale-maid.nod.motion3.json parses (1751 bytes) keys=[Version,Meta,Curves]
PASS  whale-maid.shake.motion3.json parses (1571 bytes) keys=[Version,Meta,Curves]
PASS  whale-maid.psd2live.json parses (5115 bytes) keys=[version,model,generator,runtimeTarget,mocVersion]
PASS  cdi3: 18 parameters, 6 groups
PASS  physics3: 3 physics settings
```

Additional assertions made inside the pipeline:

* **Lossless layering** — `segment.mjs` recomposites the 27 layers and compares
  against the source RGB over the whole silhouette:
  `mean|Δ| = 0.0000  max|Δ| = 0` (exact).
* **PNG decode** — a hand-written decoder matched `sharp` on 1,651,408 bytes,
  0 mismatches.
* **PSD round-trip** — reading the written PSD back through ag-psd's reader
  compared each layer's alpha plane against the source PNG: 27/27 identical.

---

## 3. What psd2live did with the PSD

```
PSD2Live: out/whale-maid.psd -> resources/live2d/models/whale-maid
  4%  Reading PSD
 18%  Semantic classification and left-right splitting
 96%  Generating texture atlas
 57%  Generating parameters and keyforms
 77%  Exporting MOC3 file family
 91%  Exporting CMO3 project
100%  Validation complete
Complete: 11 files
```

Every one of the 27 layers was recognised (`"type": "preset"`) — **zero `unknown`
layers**. Side detection came out correct under the spec's
"character's own left = viewer's right" convention:

| PSD layer | x-range | tag | side psd2live assigned |
|---|---|---|---|
| `footwear-r` | 186–248 (viewer left) | `footwear` | `RIGHT` ✅ |
| `footwear-l` | 249–294 (viewer right) | `footwear` | `LEFT` ✅ |
| `ears-r` | 14–109 (viewer left) | `ears` | `RIGHT` ✅ |
| `ears-l` | 377–476 (viewer right) | `ears` | `LEFT` ✅ |

Generated rig: 30 drawables, 26 deformers, 18 parameters, 1 atlas page.
Detected face rig: `centerX=243.45, centerY=313.12, radiusX=114.25, radiusY=127.78,
initialAngleZ=-0.274°` — consistent with the measured face oval (x 150–335, y 224–392).

Parameters: `ParamAngleX/Y/Z`, `ParamBodyAngleX/Y/Z`, `ParamEyeLOpen/ROpen`,
`ParamEyeBallX/Y`, `ParamEyeBallForm` (jelly eye), `ParamBrowLY/RY`,
`ParamMouthForm`, `ParamMouthOpenY`, `ParamBreath`, `ParamHairFront`, `ParamHairBack`.

Physics: `PhysicsHairFront`, `PhysicsHairBack`, `PhysicsEyeJelly`
(4 + 4 + 2 inputs → 3 outputs, 7 pendulum vertices, gravity (0,−1)).

---

## 4. Known limits of the delivered model

1. **No eyebrow layer** — the art has none (hidden by the bangs). `ParamBrowLY/RY`
   are unbound. A human must paint brows + forehead to enable brow motion.
2. **Hair-over-clothing split is heuristic.** Where navy cloth and mid-blue hair are
   colourimetrically close, drape pixels may sit in `handwear`/`bottomwear` instead of
   `back hair`. Invisible in the neutral pose; wrong when those parts deform.
3. **Face forehead under the bangs is invented** (nearest-skin diffusion). Only shows
   if `front hair` is displaced far.
4. **Fluke ears absorb ~5 px of neighbouring hair** (outline dilation).
5. **`eyelash` covers the upper lash only** (spec requirement); the lower lid line was
   moved into `facedetail`, which therefore mixes two meanings.
6. **`topwear` merges blouse + corset; `handwear` merges sleeve + ruffle + hand** —
   the flat art has no separate parts.
7. **The apron is `bottomwear 2`** because the spec's 31 tags have no apron tag.
8. **No closed-eye / closed-mouth texture**; psd2live synthesises both.
9. `meshSpacing` 64 / `atlas` 4096 were used for the delivered build. For a sharper
   mesh, re-run with `--mesh-spacing 32`.
