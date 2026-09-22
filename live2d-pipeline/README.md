# whale-maid → Live2D Cubism 4 model pipeline

Turns the flat front-view illustration `resources/characters/whale-maid/character.png`
(484×853 RGBA) into a working Cubism 4 model via **[psd2live](https://github.com/tsunehimatoi/psd2live)**,
built from source on macOS.

**Status: the full pipeline runs end-to-end and produces a real, loadable model.**
See `docs/RESULTS.md` for byte sizes and the exact verification evidence, and
`docs/FINDINGS.md` for the two blocking defects found in the input art.

---

## Reproduce everything

```bash
cd dsh-live2d-pet

# 0. one-time: extra Node dep used to write the PSD
pnpm add -D ag-psd

# 1. segmentation + PSD  (no Python, no numpy/PIL)
node live2d-pipeline/tools/segment.mjs      # -> out/layer-*.png + debug/labelmap.png
node live2d-pipeline/tools/build-psd.mjs    # -> out/whale-maid.psd  (+ self-parse report)

# 2. build psd2live from source on this Mac
bash scripts/live2d-build-psd2live.sh

# 3. run the rig generator
bash scripts/live2d-run-psd2live.sh        # -> resources/live2d/models/whale-maid/

# 4. verify
node live2d-pipeline/tools/verify.mjs       # 23 assertions, exits non-zero on failure
```

Or all four in one: `bash scripts/live2d-pipeline-all.sh`

---

## Directory layout

```
live2d-pipeline/
├── tools/
│   ├── analyze.mjs       palette + connected components + row/point probes
│   ├── pngcheck.mjs      hand-written PNG decoder — cross-checks sharp
│   ├── ink.mjs           ink map (255-min(r,g,b)) used to rebuild the silhouette
│   ├── cells.mjs         flat-colour cell decomposition experiment (superseded)
│   ├── diag-alpha.mjs    alpha-channel diagnostics + over-white/over-black views
│   ├── sample.mjs        mean-colour probes at named landmarks
│   ├── eyescan.mjs       ASCII class map of the eye rows
│   ├── scan2.mjs         flukes / sleeves / hem / gold-trim scans
│   ├── diag2.mjs         why a given predicate accepted/rejected a pixel
│   ├── crop.mjs          zoomed crops over magenta (reveals real alpha)
│   ├── grid.mjs          coordinate-grid overlays for reading landmarks
│   ├── segment.mjs       ★ the segmentation engine
│   ├── build-psd.mjs     ★ packs layer PNGs into the spec-compliant PSD, re-parses it
│   ├── verify.mjs        ★ verifies PSD + model3/moc3/textures/physics/motions
│   └── psdtest.mjs       ag-psd write-capability probe
├── docs/                 psd2live's own spec/guide docs (fetched, unmodified)
│   ├── PSD_LAYER_SPEC.md  DEFORMER_AND_PARAMETER_SPEC.md
│   └── USER_GUIDE.md      CUBISM_SDK_SETUP.md
├── build/psd2live/       psd2live source (tarball of master)
├── build/gradle-dist/    standalone Gradle 9.6.1 (see "Gradle" below)
├── out/                  whale-maid.psd + layer-*.png + layer-stats.json
└── debug/                label map, contact sheets, crops, validation JSON
```

---

## How the segmentation works

### Step 1 — the silhouette is rebuilt from RGB, not from alpha

`character.png`'s alpha channel is **broken** (`docs/FINDINGS.md`): the ahoge and
headdress sit at alpha 0–85, most of the head/hair at 113–198, only the torso at 255.
Its RGB is straight and correct, so:

```
ink        = 255 - min(r,g,b)            # 0 on the white paper, high on any ink
outside    = flood fill from the canvas border through ink <= 9
silhouette = NOT outside                 # then drop specks < 24 px, fill enclosed holes
```

This recovers the complete character including the nearly-invisible ahoge.
Verified with a hand-written PNG decoder (`tools/pngcheck.mjs`) that agrees with
`sharp` byte-for-byte, so the defect is in the file, not in the reading of it.

### Step 2 — strict partition, so the stack is lossless

Every silhouette pixel is claimed by **exactly one** layer, in z-order, by
colour predicates + geometric boxes read off zoomed crops. `segment.mjs` asserts
the result: recompositing the layers reproduces the source RGB with `max|Δ| = 0`.

One deliberate exception: the `face` layer also receives an **inpainted** forehead
under the bangs (nearest-skin diffusion, `faceExtra`). It is not registered in the
partition, and `front hair` sits above `face`, so the composite is unchanged while
the rig gets a face that is not full of holes.

### Step 3 — PSD layer order

psd2live's own `PsdReader.kt` documents PSD storage as *"bottom-to-top (the reverse
of ...)"*, and ag-psd maps `children[0]` to the first stored record — so
`children[0]` must be the **bottom** layer. `build-psd.mjs` reverses the top-first
`LAYERS` array and sets `noBackground: true` (no opaque background layer, per spec).

---

## PSD layer list (27 layers, record order = bottom → top)

| layer | px | bbox (x0,y0,x1,y1) |
|---|---:|---|
| `back hair` | 73803 | 12,8,468,707 |
| `footwear-r` | 1263 | 186,815,248,842 |
| `footwear-l` | 1072 | 249,815,294,841 |
| `legwear-r` | 3562 | 175,741,233,814 |
| `legwear-l` | 3622 | 246,741,307,814 |
| `bottomwear` | 23222 | 64,580,417,740 |
| `bottomwear 2` | 27179 | 138,488,342,664 |
| `handwear-r` | 8120 | 54,446,158,600 |
| `handwear-l` | 7039 | 328,446,434,600 |
| `topwear` | 10366 | 171,378,322,514 |
| `neck` | 316 | 206,380,271,392 |
| `neckwear` | 5948 | 194,384,288,454 |
| `face` | 7308 | 150,224,335,379 |
| `front hair` | 27795 | 130,186,354,400 |
| `headwear 2` | 3466 | 356,212,416,288 |
| `ears-r` | 2098 | 14,318,109,366 |
| `ears-l` | 2319 | 377,286,476,366 |
| `headwear` | 11090 | 95,80,396,216 |
| `facedetail` | 1318 | 150,309,336,368 |
| `mouth` | 534 | 225,348,258,367 |
| `eyewhite-r` | 1001 | 162,292,218,346 |
| `eyewhite-l` | 863 | 269,286,323,346 |
| `irides-r` | 1441 | 169,284,210,331 |
| `irides-l` | 1365 | 274,287,316,331 |
| `eyelash-r` | 530 | 150,270,218,308 |
| `eyelash-l` | 624 | 269,270,336,310 |
| `front hair 2` | 2499 | 185,14,286,100 |

Note the spec's side convention: **`-l` = the character's own left = the viewer's
right**. `ears-l` is at x 377–476 (viewer right) — correct.

### Exact vs approximated

**Pixel-exact** (the shape is literally what the artist drew, colours untouched):
every layer's *pixels*. The composite assertion guarantees that.

**Semantically approximate** (the *label* is inferred; the flat art has no such split):

| layer | how it was decided | what is wrong with it |
|---|---|---|
| `back hair` / `front hair` | geometric: hair inside the face box (130,186)–(354,400) = front | the art is one undivided hair mass; back strands crossing the face box are mislabelled as front hair and vice versa |
| `front hair 2` (ahoge) | box (172,14)–(300,100) | box edges cut the curl's tail |
| `headwear`, `headwear 2` | box + "is pale" (min channel > 112) | the lace's darker scallop outlines are picked up by the 5 px dilation, not by colour |
| `ears-l` / `ears-r` (whale flukes) | largest pale blobs in each fluke box, dilated 5 px into the outline | a ~5 px rim of adjacent hair becomes part of the ear and will move with it |
| `face` | visible skin + inpainted forehead under the bangs | the inpainted region is invented skin colour; only shows if `front hair` is moved far |
| `facedetail` | blush + **the lower eyelid line** | spec forbids lower lashes in `eyelash`, so they live here; the blush/`facedetail` tag now carries two unrelated things |
| hair draping over sleeves/skirt | `hairiness = (G−R) + 0.35(B−R)` threshold, 40 inside the torso core vs 12 outside | **the weakest split in the file.** Navy cloth and mid-blue hair overlap in colour; some drape pixels land in `handwear`/`bottomwear` and vice versa. Causes no visual error in the neutral pose, but those pixels deform with the wrong part |
| `topwear` | blouse + corset/waistband merged | the art draws them as two pieces; TOPWEAR is one tag |
| `handwear-l/r` | puffed sleeve + ruffle + hand as one layer per arm | no upper/lower arm split — the flat art has no such parts |
| `bottomwear 2` (apron) | box + not-blue | the 31 spec tags have **no apron tag**; this uses the spec's variant-number feature |

**Deliberately absent** (no source art exists, so they were *not* faked):

| tag | why |
|---|---|
| `eyebrow` / `eyebrow-l/r` | the eyebrows are completely hidden behind the bangs. `ParamBrowLY/RY` exist in the rig but nothing is bound to them |
| `nose` | the nose is a 3-pixel smudge; too small to isolate reliably. Left inside `face` |
| `eye_close`, `mouth_close` | no closed-eye / closed-mouth art. psd2live synthesises both (lash bends into a U, mouth compresses to the centre line) — the spec's own recommended path |
| `tooth-t`, `tooth-b`, `tongue` | the mouth is 534 px; the interior is one blob with no separable teeth/tongue |
| `eyewear`, `earwear`, `tail`, `wings`, `objects` | the character has none |

---

## Build environment notes

* **JDK 21** is what psd2live targets. The build scripts prefer an existing
  `JAVA_HOME` when it is already 21, and otherwise ask the platform for one
  (`/usr/libexec/java_home -v 21` on macOS). If neither works they stop with a
  clear message rather than silently using the wrong JDK.
* **Gradle**: the upstream repo ships a `gradlew` wrapper, but on some networks
  the wrapper cannot download its distribution. `scripts/live2d-build-psd2live.sh`
  falls back to a standalone Gradle 9.6.1 fetched into `build/gradle-dist/`
  (about 420 MB, and it is not committed).
* **A stale proxy breaks the build.** If `~/.gradle/gradle.properties` sets
  `systemProp.http.proxyHost` to a host or port that is not actually listening,
  *every* Gradle network call fails with `Connection refused`, including plugin
  and dependency resolution. The scripts clear the proxy for their own
  invocation only and never modify that file. If you hit this, check the file
  and either start your proxy or remove the stale entries.
* **The Cubism Native SDK is not required.** macOS and Linux fall back to
  psd2live's built-in CPU rasteriser, and `.moc3` export works without the
  proprietary SDK — as psd2live's own documentation states.

