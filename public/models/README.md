# Biology models

Drop your generated meshes here. There are two loading styles, depending on the specimen.

## Cell — one file *per organelle* (each independently clickable)

The cell is assembled from separate files, so each organelle is its own clickable part
and you can swap them in one at a time. Until a file exists, a matte placeholder is shown.
The membrane is always procedural (transparent, so you see inside) — no file needed.

| Organelle | File |
| --- | --- |
| Nucleus | `cell/nucleus.glb` |
| Mitochondria | `cell/mitochondria.glb` ✅ (in place) |
| Endoplasmic reticulum | `cell/er.glb` |
| Golgi apparatus | `cell/golgi.glb` |
| Lysosomes | `cell/lysosomes.glb` |
| Centrosome | `cell/centrosome.glb` |

Each file can be a single fused mesh — internal names don't matter; the whole file becomes
that one organelle. It's auto-centred, scaled, and positioned inside the cell for you.
To nudge where an organelle sits or how big it is, edit `CELL_LAYOUT` in
`src/components/visuals/SolidBiologyExplorer.astro` (`position` / `size`).

## Heart, brain, eye — one split file with named meshes

These load a single GLB whose **named meshes** map to parts. A mesh becomes selectable when
its name (or a parent's) contains one of that part's match tokens (case-insensitive), so name
the objects after the structures below (split them in Blender: `P → Selection`, then rename).

| Specimen | File | Parts to name |
| --- | --- | --- |
| Human heart | `heart.glb` | Left ventricle, Right ventricle, Atria, Aorta, Pulmonary trunk, Venae cavae, Coronary vessels |
| Brain | `brain.glb` | Frontal lobe, Parietal lobe, Temporal lobe, Occipital lobe, Cerebellum, Brainstem |
| Eye | `eye.glb` | Cornea, Iris, Lens, Retina, Optic nerve, Sclera |
| Human anatomy | `anatomy.glb` | Skeletal, Muscular, Cardiovascular, Respiratory, Digestive, Nervous |

Meshes that don't match still render — just not clickable. If nothing matches, the browser
console prints the mesh names it found so you know what to rename. Draco- and
Meshopt-compressed exports both load.

## Pipeline

These are meant to come from an image-to-3D flow: concept art (Midjourney/Flux)
→ cleanup (Nano Banana) → mesh (Hunyuan3D / Tripo / Trellis, exported GLB).
Multi-view input (front + side + back) yields noticeably better geometry.
