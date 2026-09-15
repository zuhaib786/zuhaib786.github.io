---
title: "Where Should a Limiter Act?"
description: "A thesis revisited through controlled DG experiments: GNN detection, local transformers, and conservative reconstruction that improved sharp-case accuracy."
date: 2026-07-13T12:00:00Z
tags: ["Discontinuous Galerkin", "Graph Neural Networks", "Transformers", "Numerical Analysis", "M.Tech Thesis"]
---

A neural network can recognize a discontinuity and still make a poor decision
about limiting. That is the central lesson of this work: classification quality,
solution accuracy, and numerical admissibility are different objectives.

My 2023 M.Tech thesis at IIT Delhi, *On Graph Neural Networks as Troubled Cell
Indicators*, explored using a mesh graph to decide where a DG solver should
limit its solution. It received the Best Thesis Award. The original GNN
experiments were **one-dimensional, on uniform meshes with variable numbers of
cells**. The triangular-mesh solver and the ablations discussed below are later
extensions, not results from the 2023 thesis.

> **Research status · revised September 2026.** The learned indicator has useful
> selectivity and invariance results, but the reported experiments do not establish
> a learned model that consistently improves on the numerical controls while
> preserving smooth accuracy and prescribed bounds. A later time-scaled
> reconstruction improves mean sharp-case error by 9.4% in its scalar test suite;
> that gain belongs to the deterministic control. The transformer experiments
> and their failed cases are included below.

[Thesis and extension code](https://github.com/zuhaib786/Disconinuity-Identification-in-Numerical-solutions-of-DEs)
· [Extension snapshot used for this review](https://github.com/zuhaib786/Disconinuity-Identification-in-Numerical-solutions-of-DEs/tree/0771477133a9701cd81fcdbece51cbbcc0363c0f)
· [Feature-ablation record](https://github.com/zuhaib786/Disconinuity-Identification-in-Numerical-solutions-of-DEs/blob/0771477133a9701cd81fcdbece51cbbcc0363c0f/GNN_FEATURES.md)

**On this page**

- [The numerical problem](#the-numerical-problem)
- [What the thesis established](#what-the-thesis-established)
- [The later triangular-mesh experiments](#the-later-triangular-mesh-experiments)
- [What the failures actually tell us](#what-the-failures-actually-tell-us)
- [A better objective: learn the limiting strength](#a-better-objective-learn-the-limiting-strength)
- [Following the decision through the solver](#following-the-decision-through-the-solver)
- [Reconstruction with local attention](#reconstruction-with-local-attention)
- [What would make this publishable](#what-would-make-this-publishable)
- [Evidence and reproducibility](#evidence-and-reproducibility)
- [References](#references)

## The numerical problem

For a conservation law,

$$
\partial_t \mathbf q + \nabla\cdot\mathbf F(\mathbf q)=0,
$$

a discontinuous Galerkin method stores a polynomial inside each mesh cell.
Adjacent cells communicate through a numerical flux at their shared face. Near
a shock, a high-order approximation can oscillate, produce negative density,
or make the time integration fail. Limiting suppresses those oscillations,
but excessive limiting also damps legitimate smooth structure [[1](#ref-1)].

For the later scalar experiments, the mesh consists of affine triangles and
the polynomial degree is fixed at $p=1$. Write the polynomial as

$$
u_K(\mathbf x)=\bar u_K+\nabla u_K\cdot(\mathbf x-\mathbf x_K).
$$

A slope limiter replaces it with

$$
u_K^{\mathrm{lim}}(\mathbf x)
=\bar u_K+\theta_K\bigl(u_K(\mathbf x)-\bar u_K\bigr),
\qquad 0\le\theta_K\le1.
$$

The cell mean stays fixed. On an affine $P^1$ triangle, it is the average of the
three vertex values, so scaling their zero-mean deviations preserves the cell
integral. Global conservation additionally requires conservative shared fluxes
and consistent boundary treatment. Mean preservation alone does **not** imply
positivity, a maximum principle, or stability.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/tci/dg-anatomy.svg" alt="DG cell polynomials, paired face traces, and slope scaling around an unchanged cell mean.">
  <img class="plate-dark" src="/images/tci/dg-anatomy-dark.svg" alt="DG cell polynomials, paired face traces, and slope scaling around an unchanged cell mean.">
  <figcaption>Each cell owns a polynomial. Fluxes couple the two traces at a face. Limiting changes the slope while preserving the cell mean. These drawings explain the construction; they are not benchmark results.</figcaption>
</figure>

A **troubled-cell indicator** chooses where a limiter acts. It does not itself
specify the amount of damping. The 1D implementation uses minmod slope limiting;
the triangular implementation uses a Barth–Jespersen-style neighbor-mean bound
[[2](#ref-2)]. The historical name “minmod2d” in the code refers to that triangular
baseline. These are related constructions, not identical limiters.

Applying a limiter in every cell need not modify every cell: a computed
$\theta_K=1$ leaves the polynomial untouched. It is therefore necessary to
separate cells inspected, cells flagged, cells actually modified, and total
damping $\sum_K |K|(1-\theta_K)$.

## What the thesis established

The thesis represents each cell as a graph node and connects face neighbors.
Two graph-attention layers map cell features to a score. A threshold turns that
score into a mask for the classical limiter [[3](#ref-3)]. The graph formulation
accepts different numbers of cells without changing the network's input width.

The implemented thesis GNN used nine nodal input values per cell, an eight-head
hidden GAT layer, and a final one-head layer. Its data-generation procedure
included **evolved 1D advection states**, labelled using the translated reference
solution. It was not trained exclusively on clean analytic fields; that
statement applies to a later 2D experiment.

The thesis reports these classification results in Table 5.2:

<div class="table-scroll" role="region" aria-label="Original thesis classification results" tabindex="0">

| Model | Accuracy | Recall | Precision |
|---|---:|---:|---:|
| CNN | 95.78% | 98.11% | 55.85% |
| GNN, variable number of cells | 97.35% | 90.00% | 74.31% |
| GNN, fixed number of cells | 97.97% | 90.27% | 75.99% |

</div>

The variable-size GNN traded some recall for higher precision. Its box-advection
examples showed more localized limiting than the minmod baseline. Those results
motivate a graph representation, but do not establish generalization to
unstructured 2D meshes, higher degree, or arbitrary conservation laws. The thesis
explicitly lists nonuniform meshes and the 2D GNN as future work in Sections
5.7 and 5.9.

Nor is learned shock detection itself new. Ray and Hesthaven developed neural
indicators for 1D and unstructured 2D settings; later work studied transfer
between numerical schemes [[4](#ref-4), [5](#ref-5), [6](#ref-6)]. A publication
needs a more specific contribution than replacing an MLP with a GAT.

## The later triangular-mesh experiments

The extension adds a scalar $P^1$ DG solver on triangular meshes. Its historical
GNN takes three ordered nodal values and seven geometry features. Training uses
exact line- and circle-cut fields; inference runs after every SSP-RK3 stage.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/tci/method-workflow.svg" alt="Historical pipeline: triangular mesh, cell graph, features, GAT score, threshold, classical limiter.">
  <img class="plate-dark" src="/images/tci/method-workflow-dark.svg" alt="Historical pipeline: triangular mesh, cell graph, features, GAT score, threshold, classical limiter.">
  <figcaption>The historical 2D pipeline. The network decides where to limit; the classical limiter decides how much. This is distinct from the continuous-coefficient proposal below.</figcaption>
</figure>

Three representation issues matter:

- Relabelling a triangle's vertices changes an ordered input vector even when
  the physical polynomial is unchanged. Graph-node equivariance does not fix
  ordering inside a node's feature vector.
- Global min–max normalization lets a remote extremum rescale a local decision.
- Neighbor statistics do not uniquely determine paired face traces. If face
  jumps are used, the implementation must match corresponding physical points
  before aggregating them.

The later feature study addresses these issues. Its frozen record reports the
following five-initialization aggregates at the selected threshold $\tau=0.02$:

<div class="table-scroll" role="region" aria-label="Reported feature ablation results" tabindex="0">

| Representation | Validation PR-AUC | Held-out flagged cells | Worst held-out undershoot |
|---|---:|---:|---:|
| Ordered, global scale | 0.381 | 99.85% | 0 |
| Invariant node | 0.684 | 35.57% | 0.00822 |
| Invariant node and edge | 0.695 | 34.83% | 0.00848 |
| Invariant, local scale | **0.853** | **9.75%** | **0.22574** |

</div>

These are **reported extension results**, transcribed from the linked
[feature record](https://github.com/zuhaib786/Disconinuity-Identification-in-Numerical-solutions-of-DEs/blob/0771477133a9701cd81fcdbece51cbbcc0363c0f/GNN_FEATURES.md).
The raw evaluation rows and checkpoints are referenced there under `runs/`,
which is excluded from Git. They have not been independently regenerated for
this revision.

The useful finding is narrow: the strongest classifier in that experiment was
not the model with the smallest in-solver bound violation. The invariant-node
model's held-out undershoot was below $0.01$, but its **worst calibration
undershoot was 0.01447**, so it failed the predeclared calibration rule. Calling
it safety-qualified would hide that failure.

The same record reports a GNN–KXRCF union that reduced the calibration violation
to 0.00849 while increasing held-out flags to 62.71%. That missed its selectivity
gate. Adding neighbor-extremum features improved classification and reduced
flagging, but still missed the calibration bound. These are useful trade-offs
and negative results, not accepted fixes.

The smooth-convergence result also needs its checkpoint attached. Historical
checkpoints became inactive on sufficiently fine smooth meshes. The later
selected invariant-node model at $\tau=0.02$ instead had a reported fitted
$L^2$ slope of $1.11\pm0.02$. The smooth-accuracy claim from one checkpoint cannot
be combined with the bound-violation result from another to describe a single
successful method.

## What the failures actually tell us

**Invariance is necessary, but not sufficient.** The feature study supports
removing arbitrary vertex order. It does not isolate the contribution of every
feature, prove that the architecture is adequate, or eliminate optimizer effects.
Symmetry-preserving neural indicators on triangular meshes also now exist in
prior work [[7](#ref-7)], so symmetry alone is not a new contribution.

**The tested data expansion did not solve the problem.** The `data-v3` ladder
changed the labels, then geometry, then added evolved states. The reported final
variant increased limiting to about 77% of cells with little downstream error
improvement. That rejects this particular recipe at its selected operating point.
It does not show that training data, label design, or distribution shift cannot
be responsible. A changed label definition can change class prevalence and the
meaning of a fixed score threshold.

**A local normalization failure does not prove a mechanism.** A shrinking local
scale is a plausible contributor to score drift, but the numerator can shrink
with mesh size too. Establishing causality requires measuring both, stratifying
by resolution and smoothness, and varying the scale while holding other factors
fixed.

**A mesh quantile is not a safety rule.** Flagging the highest-scoring 10% of
cells forces limiting in smooth flow and can miss a shock occupying more than
10%. Normalized logits may improve calibration; neither construction enforces
admissibility. “No probability threshold” must not become “no numerical checks.”

**Lower total variation is ambiguous.** It can mean fewer oscillations or more
damping of physical waves. An earlier version of this post incorrectly called
the GNN's Shu–Osher TV of 14.24 the lowest among stable runs, although its own
table listed minmod at 8.58. Accuracy, bound violations, and resolved physical
structure must be examined together. Unweighted graph TV is also mesh-dependent;
compare it on the same mesh, not as a resolution-independent norm.

## A better objective: learn the limiting strength

The next experiment changes the output from a shock probability to a continuous
slope coefficient:

$$
\widehat\theta_K=f_\phi(\text{local DG state and geometry})\in[0,1].
$$

A small model is sufficient for a first test. Give it permutation-invariant cell
statistics, correctly paired and pooled face jumps, gradient differences, and
shape information. Use prescribed physical bounds to set the amplitude scale in
the bounded scalar pilot. This avoids a global data-dependent extremum, while
making the assumption about the field's range explicit. It is not a universal
normalization for Euler variables or unbounded problems.

The model proposes damping. An independent guard checks **every cell at every
stage**, including cells the model would leave unchanged. Given physical scalar
bounds $m<M$ and an admissible candidate mean $\bar u_K$, define

$$
\theta_K^{\mathrm{bound}}=\min\left(
1,\ \min_{\delta_{K,i}>0}\frac{M-\bar u_K}{\delta_{K,i}},
\ \min_{\delta_{K,i}<0}\frac{m-\bar u_K}{\delta_{K,i}}
\right),
\qquad \delta_{K,i}=u_{K,i}-\bar u_K.
$$

An empty inner minimum imposes no restriction. Apply

$$
\theta_K=\min(\widehat\theta_K,\theta_K^{\mathrm{bound}}),
\qquad
u_{K,i}^{\mathrm{new}}=\bar u_K+\theta_K\delta_{K,i}.
$$

For an affine scalar $P^1$ triangle, bounding the vertices bounds the entire
polynomial, since its values are barycentric combinations of the vertex values.
The guard does not rely on the model being calibrated. This construction belongs
to the established family of mean-preserving bound limiters [[8](#ref-8)].

**There is an essential precondition:** if the candidate cell mean already lies
outside $[m,M]$, no mean-preserving slope coefficient can repair it. The prototype
rejects the whole RK step and retries with a smaller time step, with a finite
retry limit and explicit failure if that does not work. It never clips the mean.
A stronger production design would use a justified invariant-domain low-order
update or a conservative subcell fallback with consistent shared face fluxes,
as in established a posteriori methods [[9](#ref-9)].

The resulting claim is limited: **accepted stages satisfy the prescribed scalar
bounds to the stated numerical tolerance**. This does not prove an entropy
inequality, nonoscillatory behavior inside the bounds, higher-order accuracy,
or eventual completion for arbitrary data, velocities, and boundary conditions.
It is not yet a positivity limiter for the Euler equations.

### Training and the decisive control

Train against the effect of limiting, rather than a geometric cut-cell label.
For a candidate numerical state and a reference state at the same time, a first
supervised target is

$$
\theta_K^*=\arg\min_{0\le\theta\le1}
\left\|\bar u_K+\theta(u_K-\bar u_K)-u_K^{\mathrm{ref}}\right\|_{L^2(K)}^2.
$$

In the pilot, the reference is represented by its nodal $P^1$ interpolant.
This is a cheap one-step slope target; it is **not** the exact solution's full
projection error or an optimal multi-step control. A stronger experiment would
train on solver rollouts, penalize unnecessary damping in smooth regions, and
include states visited by the learned policy itself.

The indispensable baseline is **the same guard with $\widehat\theta_K=1$
everywhere**. If the learned model does not improve accuracy, resolution of
physical structures, or total runtime over that baseline at the same
admissibility requirement, the ML component has not justified its cost.
Learning combined with convex limiting already has precedent
[[10](#ref-10)]; putting a guard around a neural network is not, by itself, a
novel result.

### The first pilot: the guard earned its place; ML did not

I tested this proposal in the triangular solver: two three-initialization pilots
and a deterministic control, **77 completed runs with no failures**. Training
used 28 translation trajectories and validation used eight different trajectories.
The rotation cases used a slotted disk and were absent from training.

The first regressor applied substantial damping nearly everywhere and degraded
the smooth trend to approximately first order. The revision constrained its
proposal to

$$
\widehat\theta_K=1-\min(J_K,1)^2 a_\phi(\mathbf x_K),
\qquad 0\le a_\phi\le1,
$$

where $J_K$ is the maximum paired face-trace jump divided by the prescribed
physical range. Here $\mathbf x_K$ denotes the feature vector. If smooth $P^1$
trace jumps are $O(h^2)$, this makes the learned per-stage damping $O(h^4)$.
That is a consistency argument, not a complete accuracy proof. Because I made
this change after inspecting the first pilot, the reused evaluations are
**exploratory**.

<div class="table-scroll" role="region" aria-label="New pilot errors against the P1 reference" tabindex="0">

| $P^1$-reference $L^2$ error | Classical baseline | Guard only | Revised ML + guard | Deterministic jump rule + guard |
|---|---:|---:|---:|---:|
| Smooth, $n=32$ | 0.005986 | 0.000614 | 0.000614 | 0.000614 |
| Rotation, structured $n=12$ | 0.139468 | **0.094521** | 0.119751 | 0.119751 |
| Rotation, Delaunay $n=12$ | 0.140870 | **0.094790** | 0.121688 | 0.121688 |

</div>

ML entries average all three initialization seeds. The norm is computed with
the DG mass matrix against the nodal $P^1$ reference, not by quadrature against
the continuous exact solution. The revised model and guard-only control both
had an approximately 2.15 refinement rate from $n=16$ to $32$ on the smooth
case; a true exact-solution convergence study is still needed.

All guarded accepted-stage values were between $-1.39\times10^{-17}$ and $1$,
within the $10^{-12}$ tolerance. The observed mass change in the smooth periodic
runs was at most $1.23\times10^{-15}$. Rotation uses open boundaries, so its
mass change includes boundary transport and is not a conservation residual.

The revised ML model is essentially indistinguishable from setting
$a_\phi=1$ in the deterministic rule. **The guard alone is more accurate on the
rotation controls.** The architecture is safer than letting an unguarded score
decide admissibility, but these experiments do not justify a claim that learning
improved the limiter. The useful next experiment is a rollout-based objective
tested against these same controls on a fresh, frozen evaluation set.

[Download the pilot code, data, checkpoints, raw metrics and research assessment](/downloads/guarded-limiter-pilot.zip).
The [machine-readable summary](/downloads/guarded-pilot-summary.json) includes
the rejected first model and sample standard deviations.

## Following the decision through the solver

The next iteration replaces the one-step slope target with **counterfactual
rollout costs**. For each candidate cell, compare four damping strengths, advance
the surrounding solution through four full RK steps, and measure the resulting
error. A small model predicts which action improves on adding no damping. It
also sees a second batch of states generated by a provisional learned policy.
The physical bound guard stays independent of its predictions.

This iteration also improves the measurements. Initial states use a
quadrature-based $L^2$ projection. Errors are integrated against the analytic
field, with a quadrature refinement check. Conservation subtracts the accumulated
numerical boundary flux from the mass change. A scalar implementation of the
Moe–Rossmanith–Seal construction provides another classical control
[[11](#ref-11)].

I froze the source, data split, five initialization seeds, checkpoints and
acceptance rules before opening the new evaluation cases. All **88 runs
completed**. The learned variants preserve a smooth convergence rate of about
**2.00**, with maximum accepted-stage bound violation $2.78\times10^{-17}$.
Across all methods, the largest boundary-accounted conservation residual was
$7.76\times10^{-15}$. The largest change under quadrature refinement was 0.104%.

<figure class="plate-scroll">
  <img src="/images/tci/rollout-limiter-v1.png" alt="Smooth analytic-reference error converges at second order for the guard and rollout models. Across eight sharp cases, all five learned seeds nearly match the guard for translated pulses but add error for rotating slotted disks.">
  <figcaption>Fresh scalar tests, all five learned seeds included. Right: error divided by the guard-only error on the same case; lower is better. The classical MRS specialization is still limiting smooth extrema at these resolutions. Its parameters were frozen, not tuned to reproduce the paper's benchmark results.</figcaption>
</figure>

The accuracy result is less favorable. On the structured $n=22$ pulse case,
the five-seed mean $L^1$ improvement over guard-only is just 0.18%; on its Delaunay
counterpart, error increases by 1.51%. On the $n=22$ rotating slotted disk,
mean error increases by 19.13% and 31.67% on structured and Delaunay meshes.
The learned runs take about twice the guard-only time in this local evaluation.
**All five seeds fail the frozen improvement, worst-case regression, and runtime
gates.** No checkpoint is promoted.

The oracle found some individually useful actions, and validation decision
regret improved modestly. That did not translate into a better long simulation.
These labels change one cell at a time and use a short guard-only continuation;
they do not identify a jointly optimal policy acting repeatedly on all cells.

There is also a restriction in the action itself: it can only remove slope.
Guard-only already retains the largest coefficient on that slope direction
consistent with the physical interval. Extra damping may suppress oscillations
inside the bounds, but cannot reconstruct a feature already blurred by diffusion.
A useful next experiment would first test a **mean-preserving reconstruction or
conservative flux correction**, with an oracle and a deterministic control,
before training a selector. A longer joint rollout is a separate hypothesis.

[Download the rollout experiment, exact source snapshots, datasets, final fields,
checkpoints and assessment](/downloads/rollout-limiter-v1.zip), or inspect the
[acceptance results for every seed](/downloads/rollout-limiter-v1-summary.json).
Solver-aware learning already has precedent [[12](#ref-12)]; these improvements
make the experiment more informative, but do not establish a superior ML limiter.

## Reconstruction with local attention

The next experiment changes both the representation and the available action.
Each cell sees a set of up to ten cells: itself and its two-hop face neighbors.
Tokens contain relative geometry, signed mean differences, gradients, paired
face jumps, cell size, boundary information and transport direction. Missing
neighbors are masked. There are no global cell IDs or arbitrary neighbor-position
embeddings. Tests check neighbor-order invariance and cyclic vertex renumbering.

A small set transformer uses three attention heads and about 6,600 parameters.
A pooling network uses the same tokens, labels and training budget, with slightly
more parameters. This comparison asks whether attention adds value. Set-based
attention [[13](#ref-13)], PDE operator learning [[14](#ref-14)] and learned WENO
reconstruction [[15](#ref-15)] provide relevant precedents.

The model selects among six mean-preserving candidates: guard-only, flattening,
two sharpening strengths and two least-squares reconstructions from neighboring
means. Each candidate passes the physical bound guard. Labels now complete the
**actual remaining Runge–Kutta stages** after a single-cell intervention, then
continue to eight steps in total. All cells and snapshots of a trajectory stay
in the same split. Thirty-six training and twelve validation trajectories cross
six profile families with structured and Delaunay meshes. A provisional model
contributes additional training states. Three seeds are trained per architecture.

The oracle's combined choices improve the sampled short rollouts, and attention
reduces validation decision regret. But repeated sharpening can damage a smooth
solution while staying inside the physical interval. In the first 99-run suite,
two attention runs also reach the frozen 120-second limit. Those failures remain
in the evidence bundle; no partial-seed accuracy average is reported.

### Make the reconstruction depend on the time step

The revised controller blends a candidate $P_a$ with guard-only $P_0$:

$$
P = P_0 + \alpha(P_a-P_0), \qquad
\alpha = \min\!\left(0.25,\frac{\Delta t\,|\mathbf{v}|}{\sqrt{|K|}}\right)s_K.
$$

Here $s_K$ is a deterministic jump sensor with a stricter smooth-region cutoff.
The change vanishes with the time step at fixed mesh. Convex blending preserves
the candidates' means and bounds; it is not an entropy or convergence proof.
The integrator supplies the actual step size after retries and at the final
shortened step. Four extra token channels describe local transport rates.
Training snapshots now extend to time 0.24, so the model sees substantially
evolved states. Neural inference is skipped where reconstruction is disabled.

All **99 revised runs complete**. The models and the fixed reconstruction match
guard-only smooth accuracy, with a final convergence rate of **1.992**. This
protection comes from the numerical gate. The largest accepted-stage bound
violation across methods is $5.56\times10^{-17}$, the largest boundary-accounted
mass residual is $1.11\times10^{-14}$, and the largest quadrature refinement
change is 0.049%.

<figure class="plate-scroll">
  <img src="/images/tci/transport-transformer-v2.png" alt="Time-relaxed reconstruction matches guard-only smooth convergence. The fixed sharpening control lowers error on all eight sharp cases; attention often increases it, while pooling stays closer to the guard.">
  <figcaption>Revised experiment, every seed shown. Smooth curves overlap for the guard, fixed reconstruction and learned variants. Right: each error is divided by its paired guard-only error; S and D denote structured and Delaunay meshes. The MRS control is the same untuned P1 specialization used earlier.</figcaption>
</figure>

The strongest accuracy result is **deterministic**. Always choosing the
time-scaled 1.5 sharpening candidate reduces mean sharp-case $L^1$ error by
**9.41%**, with improvements of **5.79–16.08% on every sharp case**. It preserves
the tested smooth accuracy. A specialized implementation computes this control
without constructing unused candidates or ML tokens.

The three attention seeds have mean sharp-case errors **0.09%, 24.81% and 15.91%
higher** than guard-only. Pooling is more competitive: one seed is 1.60% worse,
and two improve by 1.69% and 2.35%. None outperforms the fixed reconstruction
consistently or passes the full acceptance requirements, including runtime.
**No learned checkpoint is promoted.**

<figure class="plate-scroll">
  <img src="/images/tci/transport-transformer-v2-fields.png" alt="Rotating slotted disk on a Delaunay mesh: analytic reference, guard-only, fixed reconstruction, attention seed zero and pooling seed zero. The fixed reconstruction has the lowest L1 error of these methods.">
  <figcaption>Finest Delaunay rotation case. Seed 0 is shown for both learned architectures. The fixed reconstruction improves the error, while all P1 solutions still blur the slot. Three training seeds are too few to establish broad statistical superiority.</figcaption>
</figure>

The revised test uses new parameters and meshes within now-known benchmark
families. It is a parameter holdout, not an external blind benchmark. These
scalar P1 results do not establish Euler positivity, entropy stability or
long-time robustness. Prototype timings include geometry and inference overhead;
the bundle also contains a separate check of optimized inference against the
saved solutions.

The next learning objective should evaluate **joint, repeated decisions over
longer trajectories**, and checkpoint selection should include complete
validation solves. Single-cell improvements under a guard-only continuation have
twice failed to predict the quality of a repeatedly applied learned policy.
The fixed time-scaled reconstruction is now the accuracy control to beat.

[Download both transformer experiments, datasets, checkpoints, failed cases,
source snapshots and measurements](/downloads/stencil-transformer-experiments.zip)
or inspect the [assessment for every seed](/downloads/transformer-comparison.json).

## What would make this publishable

The thesis is a useful starting point. The stronger research question is:

> Can learning reduce unnecessary numerical dissipation at a fixed admissibility
> requirement on unseen triangular meshes, beyond what a strong classical
> limiter and the identical guard alone achieve?

A learned model must now also outperform the time-scaled reconstruction control
under the same accuracy and cost constraints.

A convincing study would need:

1. **A precise method and conditional guarantees.** Specify the coefficient,
   admissible set, quadrature, CFL restriction, boundary handling, and rejection
   or fallback procedure. Prove conservation and the relevant bound statement.
2. **Ablations that isolate the learned contribution.** Compare guard-only,
   classical high-order limiters, binary GNN plus the same guard, continuous
   learned coefficients plus the guard, and an oracle diagnostic. Keep solver,
   degree, mesh, flux, time step, and error definition fixed.
3. **Evidence of preserved smooth accuracy.** Measure true quadrature-based
   $L^1/L^2$ error and refinement rates, including smooth extrema. Turning off
   limiting on one finest mesh is insufficient.
4. **A frozen generalization protocol.** Split whole trajectories and mesh
   families, not neighboring cells or adjacent snapshots. Freeze model selection
   before final testing; retain all initialization seeds and failed runs.
5. **A joint scorecard.** Report stage-wise bounds, conservation balance,
   dissipation, physical-wave resolution, rejected steps, and full wall time.
   Fewer flags do not establish a faster or more accurate solver.

Start with scalar 2D advection. Higher degree and Euler are separate milestones,
requiring appropriate interior/quadrature checks and density/pressure constraints.
Adding them before establishing the scalar control would make a failure harder
to interpret.

## Evidence and reproducibility

There are three distinct layers of evidence here:

- **Original thesis:** the 2023 text, especially Sections 5.7–5.9 and Table 5.2.
  Its implementation scope is 1D uniform meshes.
- **Reported extensions:** the pinned repository snapshot, its configurations,
  figures, and written experiment summaries. The raw `runs/paper/phase3-*`,
  `phase4-*`, `phase6-*` files and checkpoint families need an accessible archive
  before a reader can verify every aggregate.
- **New guarded-limiter experiment:** a separate research implementation and CPU
  pilot. The download above includes its source, source hashes, data split, all
  six checkpoints, baselines, and run records; it does not validate historical
  tables. Run-time manifests identify source versions as the prototype evolved;
  the bundle contains the consolidated implementation supporting both variants.

A reproducible release should include a manifest mapping every published row to
its raw run, dataset and split identifiers, mesh seed, initialization seed,
checkpoint hash, solver settings, and evaluation command. Distinguish calibration
failures from held-out results, nodal-field error from exact-solution error, and
boundary transport from conservation defects. That would make this post useful
as an experiment readers can inspect, rather than a sequence of increasingly
confident explanations.

## References

<span id="ref-1"></span>
[1] B. Cockburn and C.-W. Shu, “Runge–Kutta discontinuous Galerkin methods for
convection-dominated problems,” *Journal of Scientific Computing*, 2001.
[DOI](https://doi.org/10.1023/A:1012873910884).

<span id="ref-2"></span>
[2] T. J. Barth and D. C. Jespersen, “The design and application of upwind schemes
on unstructured meshes,” AIAA, 1989. [DOI](https://doi.org/10.2514/6.1989-366).

<span id="ref-3"></span>
[3] P. Veličković et al., “Graph Attention Networks,” ICLR, 2018.
[Paper](https://openreview.net/forum?id=rJXMpikCZ).

<span id="ref-4"></span>
[4] D. Ray and J. S. Hesthaven, “An artificial neural network as a troubled-cell
indicator,” *Journal of Computational Physics*, 2018.
[DOI](https://doi.org/10.1016/j.jcp.2018.04.029).

<span id="ref-5"></span>
[5] D. Ray and J. S. Hesthaven, “Detecting troubled-cells on two-dimensional
unstructured grids using a neural network,” *Journal of Computational Physics*,
2019. [DOI](https://doi.org/10.1016/j.jcp.2019.07.043).

<span id="ref-6"></span>
[6] M. Han Veiga and R. Abgrall, “Neural network based limiter with transfer
learning,” 2019. [Preprint](https://arxiv.org/abs/1912.09274).

<span id="ref-7"></span>
[7] G. G. Kokkinakis and A. I. Delis, “Symmetry-preserving neural indicators for
discontinuity detection in high-order discontinuous Galerkin solvers,”
*Computers & Fluids*, 308, 106984, 2026.
[Paper](https://www.sciencedirect.com/science/article/abs/pii/S0045793026000265).

<span id="ref-8"></span>
[8] X. Zhang, Y. Xia, and C.-W. Shu, “Maximum-principle-satisfying and
positivity-preserving high order discontinuous Galerkin schemes for conservation
laws on triangular meshes,” *Journal of Scientific Computing*, 50, 29–62, 2012.
[DOI](https://doi.org/10.1007/s10915-011-9472-8).

<span id="ref-9"></span>
[9] M. Dumbser, O. Zanotti, R. Loubère, and S. Diot, “A posteriori subcell limiting
of the discontinuous Galerkin finite element method for hyperbolic conservation
laws,” 2014. [Preprint](https://arxiv.org/abs/1406.7416).

<span id="ref-10"></span>
[10] I. Timofeyev, A. Schwarzmann, and D. Kuzmin, “Application of machine learning
and convex limiting to subgrid flux modeling in the shallow-water equations,”
2024. [Preprint](https://arxiv.org/abs/2407.17214).

<span id="ref-11"></span>
[11] S. A. Moe, J. A. Rossmanith and D. C. Seal, “A simple and effective
high-order shock-capturing limiter for discontinuous Galerkin methods,” 2015.
[Preprint](https://arxiv.org/abs/1507.03024).

<span id="ref-12"></span>
[12] M. Caldana, P. F. Antonietti and L. Dedè, “Discovering artificial viscosity
models for discontinuous Galerkin approximation of conservation laws using
physics-informed machine learning,” *Journal of Computational Physics*, 2025.
[DOI](https://doi.org/10.1016/j.jcp.2024.113476).

<span id="ref-13"></span>
[13] J. Lee et al., “Set Transformer: A Framework for Attention-based
Permutation-Invariant Neural Networks,” *ICML*, 2019.
[Paper](https://arxiv.org/abs/1810.00825).

<span id="ref-14"></span>
[14] S. Cao, “Choose a Transformer: Fourier or Galerkin,” *NeurIPS*, 2021.
[Paper](https://arxiv.org/abs/2105.14995).

<span id="ref-15"></span>
[15] D. A. Bezgin, S. J. Schmidt and N. A. Adams, “WENO3-NN: A maximum-order
three-point data-driven weighted essentially non-oscillatory scheme,”
*Journal of Computational Physics*, 452, 110920, 2022.
[DOI](https://doi.org/10.1016/j.jcp.2021.110920).
