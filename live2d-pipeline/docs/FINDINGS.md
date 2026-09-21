# FINDINGS — defects in the supplied input art

Two blockers were found before any rigging could work. Both are properties of the
input files, not of the pipeline, and both are demonstrated with numbers below.

---

## 1. `character.png` has a **broken alpha channel**

`character.png` is a valid 8-bit RGBA PNG (IHDR: colour type 6, depth 8, no
interlace, no `tRNS`). Its alpha is spatially wrong, though: large parts of the
character are far from opaque.

Per-row-band mean alpha (`tools/diag-alpha.mjs`):

| rows | mean α | max α | what is there |
|---|---:|---:|---|
| 20–100 | 2.4 – 4.3 | **85** | ahoge + top of the headdress — *almost invisible* |
| 100–200 | 19 – 77 | 142 | upper hair, lace |
| 200–300 | 87 – 115 | 198 | bangs, face, hair |
| 360–460 | 140 – 205 | **255** | torso — the only fully opaque band |
| 740–840 | 25 – 37 | 198 | socks and shoes |

The alpha histogram has discrete spikes at 112–119, 136–143, 168–175 — the signature
of a quantised/lossy alpha pass. Compositing the file over magenta (`debug/crop-top.png`,
`debug/crop-face.png`) makes the character semi-transparent; the ahoge all but vanishes.

**The RGB is straight (un-premultiplied) and correct.** Probes:

| point | RGBA | note |
|---|---|---|
| (120,300) hair | `rgba(75,95,156,113)` | true hair blue at α=0.44 |
| (241,375) chin | `rgba(251,236,225,255)` | correct skin at α=1.0 |
| (245,45) ahoge | `rgba(253,255,254,0)` | **α=0 where the ahoge outline is** |

### It is not a decoder artefact
`tools/pngcheck.mjs` is a from-scratch PNG decoder (Node `zlib` + all five
un-filtering modes). It compared **1,651,408 pixel bytes** against `sharp`:
`mismatches = 0`. The defect is in the file.

### Consequence and workaround
Feeding this PNG to psd2live would give a translucent model — you would see through
the hair. The pipeline therefore **discards the alpha channel entirely** and rebuilds
the silhouette from RGB with an ink map + border flood fill (`docs/../README.md`,
step 1). This also recovers the ahoge, which the alpha channel had erased.

---

## 2. There is no eyebrow art, and the mouth/eyes are single flat shapes

* **Eyebrows**: the bangs cover the forehead down to y≈290 in the centre, and the
  upper eyelash line starts at y≈281. There is no visible eyebrow anywhere in the
  484×853 image. A 4× zoom of the face (`debug/crop-face4.png`) confirms it.
  → **No `eyebrow` layer was produced.** `ParamBrowLY/RY` exist in the generated rig
  but nothing is bound to them. A human artist must paint eyebrows (and a forehead)
  if brow motion is wanted.

* **Eyes**: each eye is a single drawn unit — a thick upper lash, a sclera band, one
  iris disc with pupil + highlights already painted in. There are no separate
  white/iris/pupil/lash artwork layers to extract, so the pipeline *derives* them:
  iris = largest saturated-blue blob, holes filled (this is what the spec wants —
  "draw the iris as a complete circle"); sclera = bright pixels between the upper
  lash and the lower lid *within that column*; eyelash = only the dark pixels above
  the iris centroid. The split is geometrically correct but the three layers do not
  exist independently in the source.

* **Mouth**: one open mouth, 534 px, no separable teeth or tongue. The spec's
  "Scheme A — one integrated mouth" applies; `tooth-t` / `tooth-b` / `tongue` were
  deliberately not fabricated.

* **Closed-eye / closed-mouth art does not exist.** `eye_close` and `mouth_close`
  are therefore omitted; psd2live synthesises both (bends the upper lash into a U,
  compresses the mouth to a centre line), which the spec lists as the normal path.

---

## 3. Minor: duplicate base tags after side-splitting (expected, harmless)

psd2live prints:

```
Warning: Duplicate layer names detected: footwear, legwear, bottomwear, handwear,
headwear, ears; stable layer IDs were used to distinguish them.
```

This is by design: `footwear-l` / `footwear-r` share the base tag `footwear`, and
`headwear` / `headwear 2` / `bottomwear` / `bottomwear 2` are variant pairs. The tool
resolves them by stable layer ID and each still becomes its own `ArtMesh`, correctly
side-tagged (`ArtMeshFootwearL`, `ArtMeshFootwearR`, …). No layer was lost or merged.

---

## 4. Environment: two stale proxy configurations

* `~/.gradle/gradle.properties` contains
  `systemProp.http.proxyHost=127.0.0.1` / `systemProp.http.proxyPort=7890` (and the
  https pair). Nothing listens on 7890, so **every** Gradle network call fails with
  `Connection refused` — including the `gradlew` distribution download and all
  plugin/dependency resolution.
* `git config --global` has the same `http.proxy` / `https.proxy`.

Neither file was modified. The build scripts neutralise the Gradle proxy
per-invocation via `-Dorg.gradle.jvmargs="… -Dhttp.nonProxyHosts=* -Dhttp.proxyHost="`,
and clones use `git -c http.proxy=`. Direct `curl` works throughout.
