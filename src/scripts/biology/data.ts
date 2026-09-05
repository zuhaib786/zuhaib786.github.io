export type Part = { id: string; name: string; system: string; color: string; description: string; role: string; detail: string };
export type Specimen = { name: string; subtitle: string; description: string; source: string; parts: Part[]; files?: Record<string, string> };
const part = (id: string, name: string, system: string, color: string, description: string, role: string, detail: string): Part => ({ id, name, system, color, description, role, detail });
const atlas = '/models/atlas/';
export const specimens: Record<string, Specimen> = {
  cell: {
    name: 'Animal cell', subtitle: 'A cutaway through the microscopic world',
    description: 'Explore the machinery inside an animal cell. The open membrane exposes the organelles; choose one to lift it out and examine its structure.',
    source: 'Purpose-built educational cutaway. Colours and relative sizes are illustrative.',
    parts: [
      part('nucleus', 'Nucleus', 'Genetic information', '#a58bcc', 'A double membrane surrounds the DNA-containing interior. The cut surface reveals a nucleolus and strands representing chromatin.', 'Organises the genome and regulates gene expression. The nucleolus assembles ribosomal subunits.', 'Look for the pores in the envelope, the coiled chromatin, and the darker nucleolus. Chromatin is schematic, not a molecular reconstruction.'),
      part('mitochondria', 'Mitochondrion', 'Energy metabolism', '#dc925d', 'An outer membrane encloses an inner membrane folded into cristae. This section opens the organelle to reveal those folds.', 'Electron transport and ATP synthesis occur at the inner membrane.', 'The folds increase the area available for energy metabolism. This model emphasises the distinction between the outer boundary and the cristae.'),
      part('er', 'Endoplasmic reticulum', 'Protein & lipid processing', '#748fba', 'A connected network of membrane sheets and tubules near the nucleus. The small dots on these sheets represent ribosomes.', 'Rough ER helps make and fold secreted and membrane proteins; smooth ER makes lipids and stores calcium.', 'Notice the broad, folded membranes rather than a single tube. The nuclear envelope and ER are continuous in a living cell.'),
      part('golgi', 'Golgi apparatus', 'Sorting & delivery', '#d6b368', 'A stack of flattened membrane sacs, with small transport vesicles budding near its edges.', 'Modifies and sorts proteins and lipids before directing them to their destinations.', 'Follow the separate cisternae through the stack. Their curved profiles and associated vesicles distinguish the Golgi from the ER.'),
      part('lysosomes', 'Lysosomes', 'Cellular recycling', '#bf778a', 'Membrane-bound compartments containing enzymes that digest material delivered by the cell.', 'Recycle macromolecules and worn-out cellular components.', 'The opened vesicle shows an illustrative interior. The enzymes work in an acidic lumen maintained by proton pumps.'),
      part('centrosome', 'Centrosome', 'Cytoskeleton organisation', '#80afa3', 'Two perpendicular centrioles, each built from a ring of nine microtubule triplets.', 'Organises microtubules and helps establish the poles of the mitotic spindle.', 'Rotate the isolated pair to look down a centriole and count the nine groups of three tubes.'),
      part('membrane', 'Plasma membrane', 'Selective boundary', '#b7cdb7', 'The opened outer boundary of the cell. A double rim represents the two leaflets of the lipid bilayer.', 'Regulates exchange with the surroundings and supports cell signalling.', 'An animal cell has a plasma membrane, not a cell wall. The membrane thickness is exaggerated so it can be seen at this scale.'),
    ],
  },
  heart: {
    name: 'Human heart', subtitle: 'Chambers, valves & supporting structures',
    description: 'A segmented reference heart with its actual chamber contours and internal structures. Isolate a chamber, or use the structure list to reach the valves inside.',
    source: 'Human Reference Atlas, Visible Human male heart. Recoloured by structure; reference geometry preserved.',
    files: { heart: atlas + 'heart.glb' },
    parts: [
      part('left-ventricle', 'Left ventricle', 'Systemic circulation', '#bd6673', 'The muscular pumping chamber that forms the apex of the heart.', 'Ejects oxygenated blood into the systemic circulation through the aortic valve.', 'Its thicker muscular wall generates the pressure needed to supply the body. The reference mesh represents this anatomical region, not a beating-heart simulation.'),
      part('right-ventricle', 'Right ventricle', 'Pulmonary circulation', '#7797b8', 'The anterior ventricular chamber, curving around the left ventricle.', 'Pumps blood toward the lungs through the pulmonary valve.', 'Its shape is markedly different from the left ventricle. Rotate both isolated regions to compare their contours.'),
      part('left-atrium', 'Left atrium', 'Receiving chamber', '#d68d90', 'The upper chamber receiving oxygenated blood returning from the lungs.', 'Passes blood to the left ventricle through the mitral valve.', 'The atria have thinner walls than the ventricles. They serve as receiving and filling chambers.'),
      part('right-atrium', 'Right atrium', 'Receiving chamber', '#96b6d1', 'The upper chamber receiving blood returning from the body.', 'Passes blood through the tricuspid valve to the right ventricle.', 'The superior and inferior venae cavae enter this chamber. Those vessels are not included in this particular reference mesh.'),
      part('valves', 'Heart valves', 'One-way flow', '#d8c59b', 'The mitral, tricuspid, aortic and pulmonary valves, preserved as four separate reference meshes.', 'Prevent backflow as pressure changes across the chambers and great vessels.', 'The atrioventricular valves separate atria from ventricles; the semilunar valves guard the ventricular outlets.'),
      part('septum', 'Interventricular septum', 'Chamber separation', '#a789b4', 'The partition between the right and left ventricles.', 'Separates the ventricular blood streams and contributes to contraction.', 'Isolating it exposes a structure normally hidden by the chamber walls.'),
      part('papillary', 'Papillary muscles', 'Valve support', '#bc9c7b', 'Muscular projections from the ventricular walls associated with the atrioventricular valves.', 'Tension the chordae tendineae to help prevent valve prolapse during contraction.', 'The model includes several named papillary muscles. They support the valves; they do not pull them open.'),
    ],
  },
  brain: {
    name: 'Brain', subtitle: 'Real cortical folds, from both hemispheres',
    description: 'Explore a reference brain reconstructed as hundreds of named regions. Colours group related regions, while the grooves and folds come from the source anatomy.',
    source: 'Human Reference Atlas / Allen brain reference. Named regions grouped for exploration; geometry preserved.',
    files: { brain: atlas + 'brain.glb' },
    parts: [
      part('frontal', 'Frontal lobes', 'Cerebral cortex', '#b38baf', 'The anterior cortical regions of the two cerebral hemispheres.', 'Contribute to planning, voluntary movement, and aspects of language and behaviour.', 'The folds are actual reference geometry. Hovering a region also reveals its source mesh name.'),
      part('parietal', 'Parietal lobes', 'Cerebral cortex', '#80a4b2', 'Upper and posterior cortical regions, including the postcentral gyrus.', 'Integrate somatic sensation and contribute to spatial processing.', 'Both hemispheres remain together when this group is isolated, preserving their relationship.'),
      part('temporal', 'Temporal lobes', 'Cerebral cortex', '#cd9a76', 'The lower lateral cortical regions of the cerebral hemispheres.', 'Support auditory processing and aspects of language and memory.', 'Regional functions overlap and depend on connected networks; a coloured lobe is not an isolated functional module.'),
      part('occipital', 'Occipital lobes', 'Cerebral cortex', '#91b29d', 'Posterior cortical regions at the back of the brain.', 'Receive and process visual information.', 'Rotate toward the back to see their position relative to the parietal and temporal regions.'),
      part('cerebellum', 'Cerebellum', 'Coordination', '#c6af7b', 'The tightly folded structure below the posterior cerebrum.', 'Helps coordinate movement, balance and motor learning.', 'Compare its fine folding pattern with the larger gyri of the cerebral cortex.'),
      part('brainstem', 'Brainstem', 'Brain–body connection', '#b97c81', 'Regions of the midbrain, pons and medulla linking the brain to the spinal cord.', 'Relays information and supports vital automatic functions.', 'Many structures that are obscured in the whole brain become visible when this group is isolated.'),
      part('deep', 'Deep & medial structures', 'Internal anatomy', '#a8adb9', 'Additional named regions including deep nuclei, white-matter structures, ventricles and medial cortex.', 'These structures support communication, regulation and fluid spaces throughout the brain.', 'This is a viewing group, not a single anatomical system. The hover label identifies the individual source region.'),
    ],
  },
  eye: {
    name: 'Eye', subtitle: 'A layered optical instrument',
    description: 'Open the outer layers to follow the eye from the cornea to the retina. Select a layer to see it on its own, or switch off the cutaway for the complete globe.',
    source: 'Human Reference Atlas, Visible Human left eye. Recoloured; outer layers clipped in cutaway view.',
    files: { eye: atlas + 'eye.glb' },
    parts: [
      part('iris', 'Iris & pupil', 'Light regulation', '#6d9fa8', 'The coloured diaphragm surrounding the central opening called the pupil.', 'Changes pupil size to regulate the amount of light entering the eye.', 'The black pupil in the reference is an opening representation, not an opaque anatomical tissue.'),
      part('lens', 'Lens', 'Fine focus', '#d7bf80', 'A biconvex structure just behind the iris, suspended by fine ligaments.', 'Changes shape to adjust focus for different viewing distances.', 'Isolate and rotate it to see both curved surfaces and its supporting ligaments.'),
      part('retina', 'Retina', 'Light detection', '#ce8a83', 'The neural layer lining the interior of the posterior eye, including the macula and fovea.', 'Converts light into signals that enter the visual pathway.', 'Its curved sheet follows the inner globe. The optic disc is the exit region for retinal nerve fibres.'),
      part('cornea', 'Cornea', 'Front optical surface', '#92bac5', 'The transparent, curved front surface of the eye.', 'Provides much of the eye’s refractive power.', 'Shown with a tint for visibility. The reference also identifies its junction with the sclera.'),
      part('sclera', 'Sclera', 'Outer coat', '#d8d6cd', 'The strong outer coat that forms the white of the eye.', 'Supports the globe and provides attachment for the extraocular muscles.', 'The cutaway removes part of this surface to expose the inner structures; isolation restores the whole mesh.'),
      part('ciliary', 'Ciliary apparatus', 'Accommodation', '#b08ba6', 'The ciliary body, muscle and processes around the lens.', 'Supports accommodation and contributes to aqueous-humour production.', 'These ring-like structures lie behind the iris and can be hard to see without isolation.'),
      part('choroid', 'Choroid', 'Vascular layer', '#9e7477', 'The vascular coat between the sclera and retina.', 'Supplies the outer retina and absorbs scattered light.', 'The section view helps distinguish this middle coat from the layers on either side.'),
      part('fluids', 'Fluid compartments', 'Internal spaces', '#9dbac6', 'Reference volumes for the aqueous and vitreous humours.', 'Maintain the optical path and help support the eye’s internal environment.', 'These transparent spaces are represented with tinted surfaces. They are hidden in the cutaway to make the tissue layers easier to inspect.'),
      part('conjunctiva', 'Conjunctiva & drainage', 'Surface protection', '#b6bfa3', 'The conjunctival coverings and small anterior drainage structures included in the reference.', 'Protect and lubricate the ocular surface; the drainage pathway supports fluid outflow.', 'This viewing group includes several separate source structures. Hover to see the specific name.'),
    ],
  },
  anatomy: {
    name: 'Human anatomy', subtitle: 'Organs in their anatomical positions',
    description: 'A translucent body surface reveals reference organs in their shared anatomical coordinates. Choose an organ to bring it out of the body and inspect it at a useful scale.',
    source: 'Human Reference Atlas male reference organs in their original common coordinate frame. Selected organs only; not a complete body atlas.',
    files: { skin: atlas + 'skin.glb', brain: atlas + 'brain.glb', heart: atlas + 'heart.glb', lungs: atlas + 'lungs.glb', liver: atlas + 'liver.glb', intestine: atlas + 'intestine.glb', spinal: atlas + 'spinal-cord.glb' },
    parts: [
      part('heart', 'Heart', 'Circulation', '#c57680', 'The heart lies between the lungs, with its apex directed toward the anatomical left.', 'Pumps blood through pulmonary and systemic circuits.', 'For its individual chambers and valves, choose the dedicated Human heart specimen.'),
      part('lungs', 'Lungs & airways', 'Respiration', '#8cabbf', 'Paired lungs and their branching airways occupy much of the thoracic cavity.', 'Exchange oxygen and carbon dioxide between air and blood.', 'The reference retains the lobes and branching airway geometry. Isolate the group to reveal the full shape.'),
      part('brain', 'Brain', 'Nervous system', '#b39cc9', 'The brain occupies the cranial cavity at the top of the body.', 'Integrates sensory information and coordinates behaviour and body functions.', 'Switch to the Brain specimen to explore its lobes and deep regions.'),
      part('liver', 'Liver', 'Metabolism', '#b88975', 'A large organ mainly in the upper right abdomen, just beneath the diaphragm.', 'Processes nutrients, produces bile and performs many metabolic functions.', 'The original coordinates preserve its relationship to the lungs and heart above.'),
      part('intestine', 'Small intestine', 'Digestion', '#cfb189', 'A long, folded tube occupying much of the abdominal cavity.', 'Digests food and absorbs nutrients.', 'The detailed looping contour comes from the reference mesh, not a decorative curve.'),
      part('spinal', 'Spinal cord', 'Nervous system', '#d1c798', 'The central nervous-system pathway descending from the brainstem.', 'Relays signals between the brain and body and supports spinal reflexes.', 'Only the reference spinal-cord structures are shown; this is not a complete peripheral nerve model.'),
      part('skin', 'Body surface', 'Anatomical context', '#bac4cb', 'The external surface provides a positional frame for the internal organs.', 'Shows the body’s overall form and the relative locations of the selected organs.', 'Translucent in the whole-body view and opaque when isolated. The source is an adult anatomical reference.'),
    ],
  },
};

/** Match explicit anatomical words, never short substrings like "la" or "ra". */
export function classifyMesh(specimen: string, name: string): string {
  const n = name.toLowerCase().replaceAll('_', ' ');
  if (specimen === 'heart') {
    if (n.includes('valve')) return 'valves';
    if (n.includes('papillary')) return 'papillary';
    if (n.includes('septum')) return 'septum';
    if (n.includes('atrium')) return n.includes('left') ? 'left-atrium' : 'right-atrium';
    return n.includes('left') ? 'left-ventricle' : 'right-ventricle';
  }
  if (specimen === 'brain') {
    if (/cerebell/.test(n)) return 'cerebellum';
    if (/midbrain|pons|medulla|mesenceph|collicul|substantia nigra|red nucleus|periaqueductal|pontine/.test(n)) return 'brainstem';
    if (/postcentral|parietal|precuneus|supramarginal|angular gyrus|paracentral lobule caudal/.test(n)) return 'parietal';
    if (/occipital|\bcuneus\b|lingual gyrus/.test(n)) return 'occipital';
    if (/temporal|planum polare|heschl/.test(n) && !/hippocamp/.test(n)) return 'temporal';
    if (/frontal|precentral|orbital gyrus|gyrus rectus|paracentral lobule rostral/.test(n)) return 'frontal';
    return 'deep';
  }
  if (specimen === 'eye') {
    if (/iris|pupil/.test(n)) return 'iris';
    if (/lens/.test(n)) return 'lens';
    if (/retina|macula|fovea|optic disc/.test(n)) return 'retina';
    if (/cornea|corneo/.test(n)) return 'cornea';
    if (/sclera/.test(n)) return 'sclera';
    if (/ciliary/.test(n)) return 'ciliary';
    if (/choroid/.test(n)) return 'choroid';
    if (/humor/.test(n)) return 'fluids';
    return 'conjunctiva';
  }
  return '';
}

export function readableMeshName(name: string): string {
  return name.replace(/^(VH_[MF]_|Allen_)/, '').replace(/_[LR]$/, '').replaceAll('_', ' ');
}
