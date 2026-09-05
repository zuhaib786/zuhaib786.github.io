# Maintaining the biology atlas

The atlas at `/biology` uses segmented reference geometry, not generated organ
silhouettes. Its original animal-cell cutaway is built procedurally. Colours and
cell proportions are illustrative; this is an educational viewer, not a clinical tool.

## Implementation

| File | Responsibility |
| --- | --- |
| `src/components/visuals/SolidBiologyExplorer.astro` | Responsive canvas, persistent information pane, specimen and structure controls |
| `src/scripts/biology/explorer.ts` | Loading, rendering, hover raycasting, isolation, camera, clipping and disposal |
| `src/scripts/biology/data.ts` | Structure descriptions, source files and mesh-name classification |
| `src/scripts/biology/cell.ts` | Membrane cutaway, nucleus, mitochondrial cristae, ER, Golgi, lysosomes and centrioles |
| `public/models/atlas/CREDITS.md` | Per-file provenance, licence exceptions and citations |

## Reference geometry

The GLBs are from Human Reference Atlas release v1.2. Heart and eye meshes are
separated into named anatomical structures. The Allen brain contains named regions
grouped into lobes plus cerebellum, brainstem and a clearly labelled deep/medial
viewing group. The source mirrors one hemisphere; see its attribution.

The whole-body scene loads skin, heart, lungs, brain, liver, small intestine and
spinal cord in their original shared coordinate frame. It is a selection of organs,
not a complete skeleton, musculature or systems atlas. A single scale and translation
normalise the assembled specimen; do not centre each organ independently.

All files are served locally and fetched only when their specimen is chosen.
Browser caching reuses organs between individual and whole-body views. Sequential
loading bounds peak parsing memory. The geometry totals approximately 38 MB;
the cell needs no GLB download.

## Replacing or adding a model

1. Use a suitably licensed, segmented anatomical source and record its exact
   source URL, creators, version and terms in `CREDITS.md`.
2. Keep part names and relative transforms intact. Update `specimens` and
   `classifyMesh` in `data.ts` to match the actual available structures. Do not label
   absent structures or silently substitute a primitive for a failed download.
3. Use uncompressed GLBs unless the corresponding decoder is also added to the
   loader. The shipped files do not require external textures or decoder services.
4. Check every structure both in context and isolated. For body assets, verify
   the shared anatomical coordinate frame before normalisation.
5. Preserve the Allen brain's separate terms: noncommercial research/educational
   reuse is permitted under its terms; commercial redistribution requires review
   and potentially permission. Do not relabel it CC BY.

## Verification checklist

- Run `npm run build` and `git diff --check`.
- Load all five specimens; verify no console errors or missing requests.
- Hover visible geometry: the tooltip names the part and the info pane updates.
- Click geometry and each structure button: only that structure remains visible,
  centred at a useful scale, with matching information.
- Drag to rotate; a drag must not accidentally select. Test wheel/pinch zoom,
  reset, auto-rotation and keyboard arrows, +/− and Escape.
- Return to the whole specimen; test the eye cutaway toggle and body ghost surface.
- Switch specimens rapidly during loading; old requests must not replace the new view.
- Check mobile layout, keyboard focus and WebGL/network-error descriptions.
- Rebuild the sibling combined site with `node assemble.mjs` in `../zuhaib-web`
  when updating its local preview. This does not publish the site.
