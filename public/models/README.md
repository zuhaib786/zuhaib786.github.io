# Biology atlas assets

The interactive atlas is at `/biology`. Models are included locally; no generation
service or external API is needed at runtime.

- `atlas/`: segmented reference GLBs for the heart, brain, eye and selected organs
  in their common body coordinate system. See [credits and licensing](atlas/CREDITS.md).
- The animal cell is built in `src/scripts/biology/cell.ts`: an original procedural
  educational cutaway with independently selectable organelles.
- `cell/mitochondria.glb`: retained legacy asset; the current viewer does not load it.

Most reference models are CC BY 4.0. **The Allen brain has separate noncommercial
terms**, not the Visible Human models' CC licence. Preserve the individual credits
when redistributing these files.

See `docs/biology-model-pipeline.md` for maintenance and verification.
