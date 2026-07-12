---
title: "Where Should a Limiter Act?"
description: "Teaching a graph neural network to find the troubled cells in a discontinuous Galerkin solver — and being honest about where it breaks. From my M.Tech thesis."
date: 2026-07-13T12:00:00Z
tags: ["Discontinuous Galerkin", "Graph Neural Networks", "Numerical Analysis", "M.Tech Thesis"]
---

> **This is the work I did for my M.Tech thesis at IIT Delhi**, which received the
> **Best Thesis Award** — written up here in the form I wish I'd been able to read
> when I started. The solver, the training pipeline, and every experiment below are
> my own, built from scratch. It ends with a controlled experiment that found the
> real culprit — and with one problem I still have not solved.

**Table of Contents**
1. [The trade-off you cannot avoid](#the-trade-off-you-cannot-avoid)
2. [Discontinuous Galerkin in one screen](#discontinuous-galerkin-in-one-screen)
3. [What a troubled-cell indicator is](#what-a-troubled-cell-indicator-is)
4. [Why a graph](#why-a-graph)
5. [What the network actually sees](#what-the-network-actually-sees)
6. [Training on exact geometry](#training-on-exact-geometry)
7. [Does it transfer? One dimension](#does-it-transfer-one-dimension)
8. [Two dimensions: the slotted disk](#two-dimensions-the-slotted-disk)
9. [The result I actually care about](#the-result-i-actually-care-about)
10. [Where it breaks](#where-it-breaks)
11. [It was the features](#it-was-the-features)
12. [Reproducibility](#reproducibility)
13. [References](#references)

## The trade-off you cannot avoid

High-order methods are wonderful until the solution stops being smooth. Put a
shock in a discontinuous Galerkin (DG) solver and the polynomial inside each cell
starts ringing — Gibbs oscillations, which at best pollute your answer and at
worst drive the density negative and kill the run.

The standard fix is a **limiter**: flatten the polynomial in a cell until it stops
oscillating [[1](#ref-1), [2](#ref-2)]. The problem is that a limiter is a hammer. Apply it everywhere and
you have quietly thrown away the high-order accuracy you paid for.

That last sentence sounds like something you'd say to be careful. It isn't. Here
is what it actually costs, measured on a perfectly smooth 2D advection problem
with nothing to detect at all:

| method | flagged cells | fitted $L^2$ slope | $L^2$ error, finest mesh |
|---|---:|---:|---:|
| no limiter | 0% | 2.00 | 8.00e-04 |
| minmod, always on | ~81% | **1.07** | 8.68e-03 |

An always-on minmod limiter flags about four fifths of the cells at *every*
resolution, and in doing so it turns a second-order scheme into a first-order
one. The error on the finest mesh is an order of magnitude worse than doing
nothing at all. You bought a $p=1$ method and you are getting first order.

So you cannot limit everywhere, and you cannot limit nowhere. You have to decide
**where**. That decision is the troubled-cell indicator, and this post is about
teaching a graph neural network to make it.

Everything below comes out of a solver I wrote from scratch, and I want to be
upfront: the learned indicator wins on the question above, and it has a
calibration problem serious enough that I would not yet ship it. Both halves are
the point.

## Discontinuous Galerkin in one screen

We are solving a conservation law

$$
\partial_t \mathbf q + \nabla\cdot\mathbf F(\mathbf q) = 0
$$

on a triangular mesh. On each cell $K$ we keep a low-order polynomial — here
$p=1$, so a plane through three vertex values — and require the equation to hold
against every test function $v_h$ in the cell:

$$
\int_K \partial_t\mathbf q_h\, v_h\,d\mathbf x
-\int_K \mathbf F(\mathbf q_h) : \nabla v_h\,d\mathbf x
+\int_{\partial K}\widehat{\mathbf F}(\mathbf q_h^-,\mathbf q_h^+;\mathbf n_K)\,v_h\,ds = 0 .
$$

The word doing the work in "discontinuous Galerkin" is *discontinuous*. Each cell
owns its polynomial outright, and nothing forces neighbouring polynomials to agree
at the face between them — so the numerical solution genuinely jumps there
(panel (a) below). That jump is not a defect to be smoothed away; it is the only
place the cells meet. Everything one cell ever learns about its neighbour arrives
through the boundary integral in the equation above, as a single number: the
numerical flux $\widehat{\mathbf F}$ evaluated on the two traces $u^-$ and $u^+$
either side of the face (panel (b)). We use upwind for scalar advection and local
Lax–Friedrichs for Burgers and Euler. This is what makes DG so appealing — the
coupling is purely face-local, so the method is happy on unstructured meshes and
parallelizes well.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/tci/dg-anatomy.svg" alt="Three panels: per-cell polynomials that jump at faces; the two traces and the numerical flux at one face; limiting shrinking a slope about a fixed cell mean.">
  <img class="plate-dark" src="/images/tci/dg-anatomy-dark.svg" alt="Three panels: per-cell polynomials that jump at faces; the two traces and the numerical flux at one face; limiting shrinking a slope about a fixed cell mean.">
  <figcaption><strong>The three ideas you need.</strong> (a) Every cell carries its own polynomial, so the solution is discontinuous at each face — the dots are the cell means. (b) The two one-sided traces u⁻ and u⁺ at a face are the entire conversation between two cells; the numerical flux turns that pair into one number. (c) Limiting rotates the slope about the cell mean, which stays pinned. Because θ scales only the deviations from the mean, the mean cannot move — <em>the limiter is conservative no matter what the indicator decides.</em> The Barth–Jespersen rule picks the largest θ that keeps the cell inside its neighbours' bounds.</figcaption>
</figure>

Write the cell polynomial around the centroid $\mathbf x_K$ with cell mean
$\bar u_K$:

$$
u_h|_K(\mathbf x) = \bar u_K + \nabla u_K\cdot(\mathbf x - \mathbf x_K).
$$

Limiting, then, is panel (c): shrink the *slope*, leave the *mean* alone.

$$
u_{K,i}^{\mathrm{lim}} = \bar u_K + \theta_K\,(u_{K,i} - \bar u_K),
\qquad 0\le\theta_K\le 1,
$$

with $\theta_K$ from the Barth–Jespersen ratio [[3](#ref-3)]. Since $\theta_K$ multiplies only
the deviations $u_{K,i}-\bar u_K$, which sum to zero by construction, we get
$\tfrac13\sum_i u^{\mathrm{lim}}_{K,i} = \bar u_K$ exactly. That algebraic
triviality has a consequence worth internalizing: **a bad indicator cannot break
conservation. It can only cost you accuracy or stability.**

Set $\theta_K = 1$ and the cell is untouched. Set $\theta_K$ from the neighbours
and the cell is flattened. The indicator's only job is to decide which cells even
get asked.

## What a troubled-cell indicator is

An indicator is a function from the local solution to a boolean per cell. The
classical ones each encode a different guess at what "nonsmooth" means:

- **minmod** compares the cell's polynomial against its neighbours' means. It is
  the conservative default and it is the one that costs you an order above.
- **KXRCF** [[4](#ref-4)] measures the jump across *inflow* faces — a shock should
  show up as a discontinuity in the direction information is arriving from.
- **Polynomial annihilation (PA)** [[5](#ref-5)] estimates local regularity from
  divided differences. It is an analytic detector, not a trained one.
- An **MLP** on a fixed stencil — the Ray–Hesthaven approach [[6](#ref-6), [7](#ref-7)]:
  hand the network a fixed-size vector of neighbour means and let it learn the
  rule. Convolutional detectors trained on analytic data are the other established
  line of attack [[8](#ref-8)].

The MLP is the interesting precedent, and also the source of the constraint I
wanted to remove. A fixed-width network needs a fixed-size input, which on an
unstructured mesh is awkward: you must pick a canonical stencil, sort it somehow,
and hope the ordering you invented does not matter.

## Why a graph

A triangular mesh already *is* a graph. One node per cell, one edge per shared
face:

<figure class="plate-scroll">
  <img class="plate-light" src="/images/tci/method-workflow.svg" alt="Workflow: DG cells to cell graph to features to GAT to boolean decision to limiter.">
  <img class="plate-dark" src="/images/tci/method-workflow-dark.svg" alt="Workflow: DG cells to cell graph to features to GAT to boolean decision to limiter.">
  <figcaption><strong>The pipeline.</strong> The mesh becomes its face-adjacency graph; a graph attention network maps each cell to a probability; thresholding gives a boolean mask; the mask selects which cells the conservative limiter touches. Detection and limiting run after <em>every</em> stage of the Runge–Kutta integrator, not once per step.</figcaption>
</figure>

The appeal is that a message-passing network has no opinion about how many nodes
you hand it. A graph attention layer [[9](#ref-9)] computes, for each cell $K$,

$$
\mathbf h_K = \Big\Vert_{h=1}^{8}\ \mathrm{ELU}\Big(\sum_{J\in\mathcal N(K)}\alpha^{(h)}_{KJ}\,\mathbf W^{(h)}\mathbf x_J\Big),
$$

and none of those weights depend on $|V|$. Two GAT layers, a sigmoid, a threshold:

$$
p_K = \sigma(z_K), \qquad m_K = \mathbb 1[\,p_K > \tau\,].
$$

The same trained weights run on a 70-cell mesh and a 630-cell mesh with no
resizing and no retraining. I call that **mesh-agnostic**, and I want to be
precise about what the word is doing, because it is the first place this kind of
claim usually gets oversold. It means *the architecture accepts variable graph
size and face topology*. It does **not** mean the probabilities mean the same
thing on every mesh. Hold that thought — it comes back and it bites.

## What the network actually sees

Each node carries ten numbers: the three nodal solution values, plus seven
geometry features (relative area, sorted edge lengths, inradius, circumradius, a
skewness measure). The solution values are normalized with a single min–max scale
over the whole sample:

$$
\widetilde u_{K,i} = \frac{u_{K,i}-u_{\min}}{\max(u_{\max}-u_{\min},\ 10^{-12})}.
$$

I am showing you this because it is the weakest part of the design, and I would
rather point at it myself than have you find it:

1. **The three nodal values are in mesh vertex order.** Relabel a triangle's
   vertices — same polynomial, same physics — and the input vector changes. The
   edge lengths are sorted, so the geometry is invariant; the solution is not.
2. **The normalization is global.** One remote extremum, on the other side of the
   domain, rescales the features of every cell.
3. **Face jumps are not given to the network.** The most physically obvious
   signal for a discontinuity — the jump in the solution across a face — has to
   be *inferred* by the GAT from node messages, because I never put it on the
   edges.

Graph message passing is equivariant to relabeling the *graph's* nodes. It is not
equivariant to relabeling a *triangle's* vertices. Those are two different
symmetries and only one of them comes for free. (Kokkinakis and Delis' 2026
SCNN-TCI [[10](#ref-10)] enforces exactly this triangle symmetry by construction, with shared CNN
branches over the six transformations of the dihedral group. It is the right
comparison to make here, and it is not flattering.)

## Training on exact geometry

The labels come from geometry, not from a solver. I generate piecewise-quadratic
fields split by a random line or circle, and a cell is positive **iff the curve
passes through it** — an exact intersection test, not a threshold on some
heuristic.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/tci/training-data-topology.svg" alt="Training data: piecewise-smooth fields, intersected-cell labels, and the face-adjacency graph, for a line on a structured mesh and a circle on a Delaunay mesh.">
  <img class="plate-dark" src="/images/tci/training-data-topology-dark.svg" alt="Training data: piecewise-smooth fields, intersected-cell labels, and the face-adjacency graph, for a line on a structured mesh and a circle on a Delaunay mesh.">
  <figcaption><strong>The data model.</strong> Left: a different smooth quadratic on each side of the curve, so the only nonsmoothness is the interface. Middle: cells the curve actually cuts (label 1). Right: the same mesh as a face-adjacency graph, with the positives highlighted. Top row is a line on a structured mesh; bottom is a circle on a perturbed Delaunay mesh. These panels illustrate the construction — they are not results.</figcaption>
</figure>

Two thousand Delaunay graphs of 130–330 triangles each, 80/20 split, Adam, binary
cross-entropy, 60 epochs. The labels are clean and unambiguous, which is exactly
the problem I will hit later: at inference time the network sees *evolved
numerical data* from inside a solver, which looks nothing like a clean analytic
cut.

## Does it transfer? One dimension

The first real question is whether a detector trained on nothing but exact scalar
advection geometry survives contact with a nonlinear system of equations. So:
train on advection, then drop it into a 1D Euler solver and run Sod and
Shu–Osher.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/tci/profiles-1d.svg" alt="1D profiles for box advection, Sod, and Shu-Osher, with flagged cells, a Sod zoom, and the threshold trade-off.">
  <img class="plate-dark" src="/images/tci/profiles-1d-dark.svg" alt="1D profiles for box advection, Sod, and Shu-Osher, with flagged cells, a Sod zoom, and the threshold trade-off.">
  <figcaption><strong>One-dimensional transfer.</strong> Top: final cell means against the reference, with each indicator's flagged cells drawn on the rails underneath and its flag rate at the right. Bottom left: the Sod contact and shock up close. Bottom middle: the Shu–Osher entrained waves, where minmod (blue) visibly clips the smooth extrema the selective indicators keep. Bottom right: the L¹–TV trade-off as the GNN threshold τ sweeps from 0.02 to 0.3.</figcaption>
</figure>

It transfers. Across five thresholds, on both problems, not a single run diverged.
Some numbers worth staring at:

| problem | indicator | $E_{L^1}$ | TV | flagged |
|---|---|---:|---:|---:|
| box | no limiter | 0.02279 | 2.412 | 0% |
| box | minmod | 0.02562 | 1.9997 | 3.3% |
| box | KXRCF | **0.04269** | 2.028 | **48.3%** |
| box | GNN | 0.03149 | 2.076 | 1.4% |
| Sod | no limiter | *diverged* | — | — |
| Sod | PA | *diverged* | — | — |
| Sod | minmod | 0.00264 | 0.880 | 6.9% |
| Sod | GNN | 0.00332 | 0.918 | 0.2% |
| Shu–Osher | no limiter | 0.02797 | 18.52 | 0% |
| Shu–Osher | minmod | 0.07078 | 8.58 | 7.4% |
| Shu–Osher | GNN | 0.04399 | **14.24** | 1.5% |

Three things I did not expect to have to say out loud:

**Flagging more is not doing better.** KXRCF limits 48.3% of the box cells —
thirty-odd times what the GNN touches — and comes out with the *worst* error of
any method on that problem. Sustained limiting of a smooth plateau is itself an
error source.

**PA diverges on Sod.** So does the unlimited run, with an identical $\Delta t$
collapse at $t\approx0.011$. PA is an analytic regularity detector being fed
evolved numerical data, and it goes silent exactly when it is needed. This is an
in-loop failure, not a bug in PA — but it is a good argument for judging
indicators inside the solver rather than on static fields.

**No single number ranks these methods.** On Shu–Osher the GNN gets the lowest
total variation of anything that didn't diverge, and a *worse* $L^1$ than KXRCF.
Look at the zoom panel and you can see why: some of that TV reduction is bought
by damping the physical entrained waves. Good for oscillation control, bad for
accuracy. If you tune your threshold on $L^1$ alone you will never notice.

## Two dimensions: the slotted disk

Now the real target: a slotted disk on a triangular mesh, rotated through one
full revolution, so the exact solution at $T=1$ is the initial condition. Any
difference is pure numerical error.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/tci/rotation-fields-n12.png" alt="Final slotted-disk fields for every indicator on structured and Delaunay meshes.">
  <img class="plate-dark" src="/images/tci/rotation-fields-n12-dark.png" alt="Final slotted-disk fields for every indicator on structured and Delaunay meshes.">
  <figcaption><strong>After one revolution</strong> (n = 12, 288 cells, GNN at τ = 0.05). The colour scale is clipped to [0, 1], so cells that break the bound are outlined in white instead. Minmod is the only method with no outlined cell — and also the most smeared disk. The unlimited and KXRCF runs drag a large violating wake behind them. The GNN leaves a thin residual ring.</figcaption>
</figure>

| mesh | indicator | $E_{L^1}$ | $TV_G$ | undershoot | flagged |
|---|---|---:|---:|---:|---:|
| structured | no limiter | 0.03873 | 16.10 | 0.7499 | 0% |
| structured | minmod | 0.05151 | 3.84 | **0** | 84.2% |
| structured | KXRCF | **0.03115** | 9.72 | 0.4160 | 37.9% |
| structured | MLP | 0.03998 | 7.36 | 0.1351 | 0.2% |
| structured | GNN | 0.05248 | 4.39 | 0.0097 | 21.4% |
| Delaunay | minmod | 0.04890 | 3.87 | **0** | 82.9% |
| Delaunay | KXRCF | 0.02541 | 8.65 | 0.0902 | 40.9% |
| Delaunay | MLP | 0.03426 | 7.44 | 0.0557 | 0.6% |
| Delaunay | GNN | 0.05005 | 4.11 | 0.0054 | 28.9% |

The GNN lands where I hoped it would: roughly a quarter of the cells limited
instead of minmod's four fifths, with a comparable $TV_G$ and an undershoot pulled
down to around $10^{-2}$. It does not preserve the $[0,1]$ bound, and on the
structured mesh it has the worst $L^1$ of the limited methods. Meanwhile KXRCF —
not learned at all — has the best downstream $L^1$ of anything, while leaving an
undershoot 43× larger.

And here is the punchline for anyone tempted to select a model by validation
score: **the MLP's offline F1 is 0.660, comfortably better than the GNN's 0.506,
and its undershoot is an order of magnitude worse.** Offline classification
quality does not rank in-loop robustness. It doesn't even correlate reliably. If
you take one methodological thing from this post, take that.

## The result I actually care about

Back to where we started. A selective indicator is only worth its complexity if
it *switches itself off* where the solution is smooth. So: smooth periodic
advection, analytic reference, every indicator live inside the solver.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/tci/smooth-convergence.svg" alt="Convergence on smooth advection in 1D and 2D, with the mean flagged fraction.">
  <img class="plate-dark" src="/images/tci/smooth-convergence-dark.svg" alt="Convergence on smooth advection in 1D and 2D, with the mean flagged fraction.">
  <figcaption><strong>Accuracy preservation.</strong> Left and middle: L² error against mesh size h, log-log, with the fitted slope in the legend. The unlimited curve is the thick grey underlay — in 1D the MLP and both GNN curves lie exactly on top of it, because all three flag nothing. Right: the fraction of cells flagged in 2D, where the ideal is zero. Minmod (blue) sits at ~81% at every resolution.</figcaption>
</figure>

In 1D the learned indicators flag **zero** cells at every resolution. Not "a few".
Zero. Their solutions are bit-for-bit the unlimited solution, slope 2.01. Minmod
stays active on 5% of cells at the coarsest mesh, inflates the error there by
7.3×, and drags its fitted slope to 1.91.

In 2D the gap becomes an order of accuracy — that's the table from the top of the
post. Minmod flags ~81% of cells at every resolution, because the
Barth–Jespersen ratio simply cannot tell a steep smooth gradient from a
discontinuity on a triangular mesh, and the scheme collapses to first order. Both
GNN thresholds go fully inactive by $n=32$ and recover the unlimited error
*exactly*.

One honest caveat, because it would be easy to oversell this: the GNN's fitted
slopes come out at 2.60 and 2.76, above the design order. That is **not**
superconvergence. It is an artifact — the coarsest mesh is over-flagged (84% at
$\tau=0.05$), which inflates the $n=8$ error, and then the flagging vanishes, so
the fitted line is steeper than the underlying second-order trend. The result to
quote is the finest-mesh error, which is identical to unlimited. The result *not*
to quote is a slope above 2.

That over-flagging on the coarse mesh is not a footnote, either. It is the same
disease as the next section.

## Where it breaks

Everything above is the case for the method. Here is the case against it, which I
think is more interesting.

**The threshold does not transfer across resolution.** Fix $\tau=0.1$, refine the
mesh, and the detector gets *quieter* — the flag rate falls from 19.7% to 3.0%
on structured meshes — while the undershoot climbs by up to two orders of
magnitude, reaching $0.483 \pm 0.228$ on the finest mesh. It goes silent exactly
where the gradients it is supposed to catch get steeper. The architecture runs at
every resolution. The *probabilities* do not mean the same thing at every
resolution.

**Lowering the threshold fixes the safety and destroys the selectivity.** Rerun
the whole 30-case grid at $\tau=0.05$ and the undershoot drops by an order of
magnitude nearly everywhere. Good. But look at what happens to the spread:

<figure class="plate-scroll">
  <img class="plate-light" src="/images/tci/threshold-grid-five-seed.svg" alt="Five-seed grids at two thresholds: selectivity, bound violation, and the per-run Pareto front.">
  <img class="plate-dark" src="/images/tci/threshold-grid-five-seed-dark.svg" alt="Five-seed grids at two thresholds: selectivity, bound violation, and the per-run Pareto front.">
  <figcaption><strong>Two thresholds, five checkpoints, 30 runs each.</strong> Left: flag rate, mean ± sample SD. Middle: undershoot, log scale, with the 10⁻² safety level marked. Right: every individual run. The crosses are checkpoint seed 4, which at τ = 0.05 flags 92–100% of cells — it has degenerated into an always-on limiter — while at τ = 0.1 it behaves like everything else.</figcaption>
</figure>

The sample standard deviation of the flag rate blows up to ±38 percentage points.
Pooled over meshes and resolutions, checkpoints 0–3 flag 28%, 35%, 26% and 26% of
cells. **Checkpoint 4 flags 96.97%.** Same architecture, same training
distribution, same threshold — and one of five models has quietly turned into
minmod. At $\tau=0.1$ that same model is unremarkable.

So the pathology is not a property of the model *or* the threshold. It is a
property of the pair. A threshold you calibrated on four checkpoints will destroy
the fifth, and no experiment that fixes a single seed will ever show you this. I
kept the seed-4 rows in. Dropping them would be reporting a tuned result as an
untuned one.

**Two of five initializations just fail.** I rebuilt the training protocol to
separate the data seed, the split seed, and the initialization seed (they had been
one seed, which meant my "five seeds" were varying the dataset *and* the
initialization at once), and to restore the best-validation epoch instead of the
last one. With the data and the split now provably identical across all five runs:

| train seed | best epoch | F1 | PR-AUC | ECE |
|---:|---:|---:|---:|---:|
| 0 | 57 | 0.4404 | 0.4975 | 0.0297 |
| 1 | 17 | **0.2403** | **0.1688** | 0.0073 |
| 2 | 54 | 0.4721 | 0.5540 | 0.0165 |
| 3 | 51 | 0.4610 | 0.5160 | 0.0257 |
| 4 | 20 | **0.2443** | **0.1668** | 0.0085 |
| mean ± SD | | 0.372 ± 0.119 | 0.381 ± 0.195 | 0.018 ± 0.010 |

That is not a spread around a mean, it is a bimodal distribution. Seeds 0, 2 and 3
find a decent optimum. Seeds 1 and 4 collapse to roughly half the F1 and a third
of the PR-AUC, early-stop after ~30 epochs, and peak as early as epoch 17. Since
the data and split are now identical by construction, there is nothing left to
blame but the initialization: **two of five initializations of this representation
fail to find the good solution.**

My bet was that all three failures have one root cause: the features. A network
whose inputs flip when you relabel a triangle's vertices, and whose scale is set by
an extremum on the far side of the domain, has no particular reason to produce a
probability that means the same thing across meshes, resolutions, and
initializations.

So I tested it, and the bet paid off — mostly.

## It was the features

That hypothesis is testable, which is the whole reason to write it down. Four
representations, same data, same split, same capacity, five seeds each, changing
exactly one thing at a time:

1. **ordered-global** — what you just read about.
2. **invariant-node** — replace the three ordered nodal values with permutation-invariant
   cell statistics (mean offset from the one-ring median, nodal spread, $h_K|\nabla u_K|$).
3. **invariant-edge** — additionally put the thing I should have put there in the
   first place on the edges: the normalized mean jump, the face-trace jump, and
   the normal-gradient jump across each face.
4. **invariant-local** — additionally replace the global min–max with a robust
   one-ring scale, so a remote extremum cannot touch a local decision.

Twenty training runs, 400 calibration runs, 120 held-out runs. Here is what came
back.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/tci/feature-ablation.svg" alt="Three panels: offline PR-AUC per representation with five seeds each; permutation stress test; undershoot against flag rate.">
  <img class="plate-dark" src="/images/tci/feature-ablation-dark.svg" alt="Three panels: offline PR-AUC per representation with five seeds each; permutation stress test; undershoot against flag rate.">
  <figcaption><strong>The controlled ablation.</strong> (a) Validation PR-AUC, faint dots are individual seeds — the baseline is bimodal, the invariant schemas are tight. (b) How far the logit moves when you relabel a triangle's vertices without changing any physics. (c) Undershoot against flag rate as τ sweeps 0.02 → 0.3, pooled over both meshes, both calibration resolutions and all five seeds; down-and-left is better.</figcaption>
</figure>

**The invariance is exact.** Relabel a triangle's vertices — same polynomial, same
mesh, same physics — and the baseline's logits move by up to **2.465**, which is
comparable to the spread of the logits themselves. It was never detecting a
discontinuity; it was partly detecting an arbitrary choice made by the mesh
generator. All three invariant schemas move by **exactly zero**. Not "small". Zero,
bitwise.

**Fixing the features nearly doubles the offline quality, and the seed collapse
vanishes.**

| representation | F1 | PR-AUC | ECE |
|---|---|---|---|
| ordered-global (baseline) | 0.372 ± 0.119 | 0.381 ± 0.195 | 0.018 ± 0.010 |
| invariant node | 0.541 ± 0.052 | 0.683 ± 0.045 | 0.009 ± 0.006 |
| invariant + edge | 0.543 ± 0.058 | 0.695 ± 0.048 | 0.007 ± 0.005 |
| **invariant + local scale** | **0.725 ± 0.019** | **0.853 ± 0.014** | 0.013 ± 0.003 |

Look at the standard deviations, not just the means. The baseline's PR-AUC spread
is ±0.195 — half its own mean — because two of five seeds fall into that degenerate
optimum. `invariant-local` has a spread of ±0.014, and all five seeds land between
0.841 and 0.875. **The initialization sensitivity was never really about the
initialization.** It was a representation so ill-posed that gradient descent could
fall off it, and once the representation is fixed, the optimizer is fine.

**The feature I was most confident about did nothing.** Putting the face jump
explicitly on the graph edges — the single most physically obvious signal for a
discontinuity, the thing I described earlier as what "I should have put there in
the first place" — bought me 0.001 F1 and 0.012 PR-AUC over node features alone.
That is well inside one standard deviation. It is nothing.

In hindsight the reason is obvious: a message-passing network receiving the cell
statistics of two adjacent cells can *compute* the jump between them. I was handing
it a quantity it could already derive. The gains came from invariance and from the
local scale — from removing bad information, not from adding good information. I
would not have guessed that ordering, and it is the sort of thing you only find out
by changing one factor at a time.

### The trap in this table

Now the part I nearly got wrong. The protocol freezes a threshold on calibration
meshes before touching the held-out meshes, using a predeclared rule: take the
largest τ that keeps undershoot and overshoot under $10^{-2}$. All four models
selected τ = 0.02, and at that threshold the scoreboard reads:

| representation | undershoot at τ=0.02 | flagged cells |
|---|---:|---:|
| ordered-global (baseline) | **0.000** | **99.8%** |
| invariant node | 0.009 | 36.1% |
| invariant + edge | 0.009 | 35.4% |
| invariant + local scale | 0.052 | 9.2% |

Read naively, the baseline just won on safety and the best model just lost. Read
again. **The baseline achieves zero undershoot by flagging 99.8% of the cells** — at
τ = 0.02 it has stopped being an indicator and turned into minmod, which is
trivially bound-preserving and which this entire post exists to avoid. Its perfect
safety score is the safety of doing the thing we were trying not to do.

The four models are simply not at the same operating point. One τ, four models
trained on identical data, and the flag rates are 99.8%, 36.1%, 35.4% and 9.2%. So
compare them where they *are* comparable — at matched selectivity (panel (c)
above):

| at ≈13% of cells flagged | undershoot |
|---|---:|
| ordered-global | 0.285 |
| invariant node | 0.043 |
| invariant + edge | **0.033** |

**Six to nine times less bound violation for the same amount of limiting.** And at
≈9% flagging, `invariant-local` beats `invariant-node` on *both* axes at once —
lower undershoot (0.052 vs 0.085) *and* lower error (0.046 vs 0.056) — which is a
dominance no threshold choice can manufacture. That is the real result, and a table
of fixed-τ numbers hides it completely.

### What is still broken

I said at the top that this has a calibration problem I would not ship. That is
still true, and the ablation sharpens it rather than solving it.

No representation satisfies the $10^{-2}$ bound while remaining selective. And the
threshold does not transfer *across representations* any more than it transferred
across resolutions: τ = 0.02 means "flag everything" for one model and "flag one
cell in eleven" for another. Every arrow I have points the same way — the
probability coming out of the sigmoid is not a calibrated statement about anything,
and thresholding it is the weakest link in the whole pipeline. Fixing the features
made the *ranking* good. It did not make the *scale* meaningful.

That is where the work goes next.

## Reproducibility

Every number above comes from a machine-readable artifact — JSON for metrics, NPZ
for fields — rather than from a note I made while watching a run. The five-seed
entries are means and sample standard deviations over all 30 rows; the two
"diverged" cells in the 1D table are recorded failures with their $\Delta t$
collapse times, not omissions.

The parts I have *not* done, and am therefore not claiming: 1D Burgers
cross-indicator rows; any Euler-aware 2D learned indicator (my 2D Euler solver
works, but it is driven by classical minmod — it is a solver result, not a
learned-indicator result); and the rotation benchmarks of the earlier sections
re-run with the invariant representations, which still use the historical
checkpoints. The two families of numbers are kept separate and never mixed.

If there is a single transferable lesson here, it is the one that cost me the most
to learn: **evaluate the indicator inside the solver.** The offline F1 will happily
tell you the MLP is the better model, right up until you watch it undershoot.

---

*This post is drawn from my M.Tech thesis on discontinuity identification in
numerical solutions of differential equations. If you are working on learned shock
detection and want to compare notes — or if you think the representation critique
above is wrong — I would genuinely like to hear from you.*


## References

<span id="ref-1"></span>
[1] B. Cockburn and C.-W. Shu, "Runge–Kutta discontinuous Galerkin methods for
convection-dominated problems," *Journal of Scientific Computing*, 16, 173–261,
2001. [doi:10.1023/A:1012873910884](https://doi.org/10.1023/A:1012873910884)

<span id="ref-2"></span>
[2] J. S. Hesthaven and T. Warburton, *Nodal Discontinuous Galerkin Methods:
Algorithms, Analysis, and Applications*, Springer, 2008.
[doi:10.1007/978-0-387-72067-8](https://doi.org/10.1007/978-0-387-72067-8)

<span id="ref-3"></span>
[3] T. J. Barth and D. C. Jespersen, "The design and application of upwind schemes
on unstructured meshes," AIAA Paper 89-0366, 1989.
[doi:10.2514/6.1989-366](https://doi.org/10.2514/6.1989-366)

<span id="ref-4"></span>
[4] L. Krivodonova, J. Xin, J.-F. Remacle, N. Chevaugeon, and J. E. Flaherty,
"Shock detection and limiting with discontinuous Galerkin methods for hyperbolic
conservation laws," *Applied Numerical Mathematics*, 48, 323–338, 2004.
[doi:10.1016/j.apnum.2003.11.002](https://doi.org/10.1016/j.apnum.2003.11.002)

<span id="ref-5"></span>
[5] R. Archibald, A. Gelb, and J. Yoon, "Polynomial fitting for edge detection in
irregularly sampled signals and images," *SIAM Journal on Numerical Analysis*, 43,
259–279, 2005.
[doi:10.1137/S0036142903435259](https://doi.org/10.1137/S0036142903435259)

<span id="ref-6"></span>
[6] D. Ray and J. S. Hesthaven, "An artificial neural network as a troubled-cell
indicator," *Journal of Computational Physics*, 367, 166–191, 2018.
[doi:10.1016/j.jcp.2018.04.029](https://doi.org/10.1016/j.jcp.2018.04.029)

<span id="ref-7"></span>
[7] D. Ray and J. S. Hesthaven, "Detecting troubled-cells on two-dimensional
unstructured grids using a neural network," *Journal of Computational Physics*,
397, 108845, 2019.
[doi:10.1016/j.jcp.2019.07.043](https://doi.org/10.1016/j.jcp.2019.07.043)

<span id="ref-8"></span>
[8] A. D. Beck, J. Zeifang, A. Schwarz, and D. G. Flad, "A neural network based
shock detection and localization approach for discontinuous Galerkin methods,"
*Journal of Computational Physics*, 423, 109824, 2020.
[doi:10.1016/j.jcp.2020.109824](https://doi.org/10.1016/j.jcp.2020.109824)

<span id="ref-9"></span>
[9] P. Veličković, G. Cucurull, A. Casanova, A. Romero, P. Liò, and Y. Bengio,
"Graph Attention Networks," *International Conference on Learning
Representations*, 2018.
[openreview.net/forum?id=rJXMpikCZ](https://openreview.net/forum?id=rJXMpikCZ)

<span id="ref-10"></span>
[10] G. Kokkinakis and A. I. Delis, "Symmetry-preserving neural indicators for
discontinuity detection in high-order discontinuous Galerkin solvers," *Computers
& Fluids*, 308, 106984, 2026.
[doi:10.1016/j.compfluid.2026.106984](https://doi.org/10.1016/j.compfluid.2026.106984)
