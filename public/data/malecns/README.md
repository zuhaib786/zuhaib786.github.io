# MaleCNS data and Flappy readout

`malecns-v1.0.flyb.gz` is a browser-ready derivative of the MaleCNS v1.0
connectome. Its SHA-256 is
`e33df182bed7a6f3ea279daf4790a82b05706d3d41e819a6a80c0473e8c559f3`.

The source dataset is the male *Drosophila melanogaster* central nervous system
connectome, neuPrint dataset `male-cns:v1.0`, produced by the FlyEM Project Team
at HHMI Janelia Research Campus, the Drosophila Connectomics Group at the
University of Cambridge / MRC LMB, and Google Research. The data is licensed
under CC BY 4.0.

Source and download documentation:

- https://male-cns.janelia.org/
- https://male-cns.janelia.org/download/
- https://www.janelia.org/project-team/flyem/male-cns-connectome

The binary contains all 176,422 neuPrint neuron nodes. Connections with fewer
than five synapses and autapses were removed, leaving 6,287,749 directed
connections and 90,296,905 represented synapses. Neurons are indexed by sorted
body ID; connection weights are stored as unsigned 16-bit synapse counts.
Neurotransmitter predictions supply excitatory or inhibitory signs, and a retina
lookup assigns photoreceptors to medulla columns. These transformations and the
FLYB v1 format come from `fly-brain-minecraft`:
https://github.com/blendi-remade/fly-brain-minecraft.

Attribution requested by the derivative:

> Derived from the male CNS connectome, neuPrint dataset male-cns:v1.0, by the
> FlyEM Project Team (HHMI Janelia Research Campus), the Drosophila Connectomics
> Group (University of Cambridge / MRC LMB) and Google Research; licensed CC BY
> 4.0. Modified: connections thresholded at >= 5 synapses, autapses removed,
> neurons re-indexed, neurotransmitter signs assigned, photoreceptors assigned
> to medulla columns.

`flappy-readout-v1.json` was trained locally with
`scripts/train-flappy-readout.mjs`. It is a logistic regression over ten named
descending and motor population firing rates. It does not modify connectome
weights. The JSON records its graph checksum, neural parameters, training split,
accuracy, normalization, coefficients, and decision threshold.

The LIF engine uses parameters from Shiu et al., *A Drosophila computational
brain model reveals sensorimotor processing*, Nature 634, 210–219 (2024):
https://doi.org/10.1038/s41586-024-07763-9.

The MaleCNS companion citation is Berg et al., *Sexual dimorphism in the
complete Drosophila male central nervous system connectome*, Cell 189(18),
5504–5526 (2026): https://doi.org/10.1016/j.cell.2026.08.015.

The dataset and this simulation are not endorsed by HHMI, Janelia, Google, the
University of Cambridge, the MRC LMB, or the authors of the reference project.
