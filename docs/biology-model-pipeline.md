# Biology model pipeline — cell, heart, anatomy, brain, eye

How to produce the `.glb` files the Biology Atlas loads
(`src/components/visuals/SolidBiologyExplorer.astro` → `/public/models/`).

---

## Read this first — two reality checks

**1. AI image models draw *plausible* anatomy, not *accurate* anatomy.**
A pure text prompt gives you a heart that looks great and has the wrong number of
vessels. Your original complaint was "inaccurate" — don't reintroduce it here.
Fix: anchor every generation with a **real reference image** (a labelled medical
illustration or a photo of a plastinated specimen). In Midjourney paste the
reference URL at the front of the prompt (image prompt) or use `--sref`/`--cref`.

**2. Image-to-3D gives you ONE outer-surface mesh — no insides, no separate parts.**
Hunyuan3D reconstructs the *visible surface* of *one* object. That means:
- A whole-cell image → one blob. The nucleus/mitochondria/ER **do not exist** in
  the mesh (they were never visible), so they can't be clicked.
- A heart image → one shell. The four chambers are internal → not separated.

The atlas is built around **clickable, labelled sub-structures**. To get those from
this pipeline you must do ONE of:
  - **(A) Generate each part as its own image → its own mesh**, then drop them in as
    separate named objects (best for the *cell* — nucleus, mito, golgi… as separate blobs).
  - **(B) Generate the whole organ, then split + name the regions in Blender**
    (best for *heart / brain / eye* — one scan, cut into chambers/lobes). ~30 min in Blender.
  - **(C) Skip generation** and use an already-segmented anatomical model
    (Z-Anatomy [CC-BY-SA], BodyParts3D, NIH 3D). Strongly recommended for
    **Human Anatomy (full body)** — a correct segmented body is not realistic to
    generate from scratch.

Per-specimen recommendation is in the cheat sheet at the bottom.

---

## Accounts / tools you'll need

| Stage | Tool | Access |
| --- | --- | --- |
| 1 Concept art | Midjourney (or Flux / Imagen) | midjourney.com or the Discord bot ($10/mo Basic is enough) |
| 2 Cleanup | Nano Banana (Gemini image) | Gemini app → tools → *Create images*; or `gemini-3.1-flash-image-preview` via AI Studio |
| 3 Image→3D | Hunyuan3D | Free: HuggingFace Space (drag-drop → GLB). Paid API: fal.ai (~$0.16/mesh). Alt: Tripo3D, Trellis |
| 3.5 Split/name | Blender (free) | blender.org — only if you want clickable parts (option B) |

---

## Stage 1 — concept images (Midjourney)

**Global settings for every prompt below:** append `--style raw --ar 1:1`. `--style raw`
kills MJ's decorative flourishes (which wreck the 3D step). Keep the background plain
and the lighting neutral — you're making a *study*, not a poster.

**Angle strategy.** Generate the *same* subject from 3 angles — **three-quarter
front, direct side (lateral), and back** — because multi-view input gives Hunyuan far
better geometry. Keep them consistent:
1. Generate your best three-quarter view first.
2. For the other angles, put that image's URL at the front of the prompt **and** add
   `--cref <that-image-url> --sref <same-url>` so proportions/colours carry over.
3. Only change the angle words ("lateral view", "posterior view").

**Prompt formula:** `anatomically accurate <subject>, medical illustration reference,
<key structures to show>, realistic <tissue>, neutral studio lighting, plain white
background, centered, <angle> --style raw --ar 1:1 --no text labels arrows watermark`

### Per-specimen Stage-1 prompts

**Animal cell** — do the parts *separately* (option A). One prompt per organelle:
```
anatomically accurate <ORGANELLE>, isolated single organelle, 3D biology textbook
render, soft studio lighting, plain white background, centered, three-quarter view
--style raw --ar 1:1 --no text labels arrows
```
Run it with `<ORGANELLE>` = `cell nucleus with nucleolus`, `mitochondrion with cristae`,
`golgi apparatus stacked cisternae`, `rough endoplasmic reticulum network`,
`lysosome vesicle`, `pair of centrioles`. Plus one translucent `spherical cell membrane`.

**Human heart** (whole, split later in Blender — option B):
```
anatomically accurate human heart, medical illustration, left and right ventricles,
atria, aorta, pulmonary artery, superior and inferior vena cava, coronary vessels on
the surface, realistic cardiac muscle, neutral studio lighting, plain white background,
centered, three-quarter anterior view --style raw --ar 1:1 --no text labels arrows
```

**Human anatomy (full body)** — recommend option C instead, but if generating:
```
anatomically accurate human body écorché, full standing figure, superficial muscle and
skeletal system, medical atlas reference, neutral A-pose, even studio lighting, plain
white background, front view --style raw --ar 2:3 --no text labels arrows
```

**Brain** (whole, split into lobes in Blender):
```
anatomically accurate human brain, cerebral cortex with gyri and sulci, cerebellum,
brainstem, medical illustration, realistic tissue, neutral studio lighting, plain white
background, centered, three-quarter superior-lateral view --style raw --ar 1:1 --no text
```

**Eye** (do an *external* eyeball for the hero, plus a *cross-section* image if you want
internal structures — the cross-section becomes a separate half-model):
```
anatomically accurate human eyeball, external view, optic nerve at the back, extraocular
muscles, sclera and cornea, medical illustration, neutral studio lighting, plain white
background, centered, three-quarter view --style raw --ar 1:1 --no text
```
Cross-section variant: replace "external view" with
`sagittal cross-section showing cornea, iris, lens, vitreous, retina, optic nerve`.

---

## Stage 2 — cleanup (Nano Banana / Gemini)

Upload each Stage-1 render. Conversational prompt:
```
Remove the background completely and make it pure flat white. Keep the <subject> exactly
as-is — identical shape, colours, and anatomical detail. Sharpen the silhouette and edges.
Remove any text, labels, arrows, watermarks or drop shadows. Even, neutral lighting, no
strong highlights.
```
Do this for every image and every angle.

**Consistency trick:** if your three angles drifted, use Nano Banana Pro to re-synthesise
them from one clean master: *"Using this reference image, generate the same <subject> from
a direct left-lateral view, identical proportions, colours and detail, plain white
background."* More reliable than three independent Midjourney runs.

---

## Stage 3 — image → 3D (Hunyuan3D)

**Free HuggingFace Space path:**
1. Open the Hunyuan3D Space (2.1 / 3.0 — newer = stronger).
2. Upload your cleaned master image. If it has a multi-view tab, upload front + side + back.
3. Generate **shape** first; check the mesh; then generate **texture**.
4. Download as **GLB**.

**Paid fal.ai path:** Hunyuan3D endpoint, ~$0.16 for white mesh (more for textured).
Scriptable if you're batching all five.

**After download:**
- If the mesh is huge (>200k tris), decimate to ~30–80k for the web (Blender: Decimate
  modifier, or `gltf-transform simplify`). Keep files ideally < ~8 MB each.
- Hunyuan usually outputs a **single mesh** named `mesh_0` / `Object_0`.

---

## Stage 3.5 — split + name in Blender (only for clickable parts, option B)

1. `File → Import → glTF 2.0`, select your GLB.
2. Tab into **Edit Mode**, hover a region (e.g. left ventricle), `L` to select linked
   faces (or box-select), press **`P → Selection`** to split it into its own object.
3. In the Outliner, **rename that object** to match the atlas tokens below. Repeat per part.
4. Select all parts, `File → Export → glTF 2.0` (.glb), *Include → Selected Objects*.

The loader matches a mesh to a labelled part when the mesh name (or a parent's) contains
one of these tokens (case-insensitive) — so naming an object `Left ventricle` or
`left_ventricle` both work:

- **cell.glb:** Nucleus, Plasma membrane, Mitochondria, Endoplasmic reticulum, Golgi apparatus, Lysosomes, Centrosome
- **heart.glb:** Left ventricle, Right ventricle, Atria, Aorta, Pulmonary trunk, Venae cavae, Coronary vessels
- **brain.glb:** *(new — needs wiring, see below)* Frontal lobe, Parietal lobe, Temporal lobe, Occipital lobe, Cerebellum, Brainstem
- **eye.glb:** *(new)* Cornea, Iris, Lens, Retina, Optic nerve, Sclera
- **anatomy.glb:** *(new)* Skeletal, Muscular, Cardiovascular, Respiratory, Digestive, Nervous *(system-level)*

Meshes that don't match still render (just not clickable). If nothing matches, the browser
console prints the mesh names it found.

---

## Per-specimen cheat sheet

| Specimen | Best strategy | Why |
| --- | --- | --- |
| Animal cell | **A** — generate each organelle separately | Internal parts are never visible in one image |
| Human heart | **B** — whole mesh, split chambers in Blender | Good exterior from one scan; chambers cut by hand |
| Brain | **B** — whole mesh, split lobes in Blender | Lobes are surface regions, easy to cut |
| Eye | **B** exterior + separate cross-section model | Internal (lens/retina) needs the section image |
| Human anatomy | **C** — use Z-Anatomy / BodyParts3D / NIH 3D | A correct segmented body isn't feasible to generate |

---

## After you have the GLBs — wiring into the site

1. Drop files in `public/models/` as `cell.glb`, `heart.glb`, `brain.glb`, `eye.glb`, `anatomy.glb`.
2. The component **currently ships only cell / heart / neuron**. Your set (cell, heart,
   anatomy, brain, eye) drops *neuron* and adds *anatomy, brain, eye* — so the `SPECIMENS`
   list, the specimen tray buttons, and the part annotations for the three new models need
   to be added. That's a code change I can make in ~15 min once you tell me the parts you
   want labelled per new model (defaults suggested above). Ping me and I'll rewire it.
