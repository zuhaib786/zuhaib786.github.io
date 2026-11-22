---
title: "Darts, Cards and Games I Never Played"
description: "Lab F1b. Monte Carlo and importance sampling, on Blackjack."
date: 2026-10-04
order: 2
tags: ["RL", "Monte Carlo", "Importance Sampling"]
draft: false
---
## Darts, Matchboxes and Chess Engines
You may be asking what darts, matchboxes and chess engines have in common. How do they fit under the same heading? I would be lying if I said there was a deep reason: this is just me being cheeky to introduce one of the most magical tools in the world of estimation, Monte Carlo methods.

I was in the middle of grinding probability problems for JEE when one of them piqued my curiosity. It was about estimating $\pi$ using nothing more than a circle, a square and random selection.

I understood the problem, solved the problem, and laughed at its claim of estimating $\pi$. I understood the mechanics of chance, but I never truly believed they could have experimental grounding as well. In the same book I remember solving Buffon's needle and Banach's matchbox problem back to back.
The matchbox problem has stayed with me ever since: every time I remember it, I remember its odd little link between $\pi$ and probability.

Fast forward to my college years. I solved so many probability questions, MDPs, stochastic calculus, and yet I never got to play with the estimation side. As luck would have it, these methods kept crossing my path without me knowing, like this amazing video of a [chess game](https://youtu.be/9yoXlr8x5xg?si=PlKRC5NySs5PLj8h) played between two chess engines. Googling one of the less famous [chess engines](https://en.wikipedia.org/wiki/Komodo_(chess)) in that game led me to Monte Carlo tree search. And [AlphaZero](https://en.wikipedia.org/wiki/AlphaZero) crushing the best chess engines of its time with a Monte Carlo tree search, guided by a neural network, always kept me curious about how these estimates are done in practice.

Well, today I finally got to confront them, and I am in love with how simple they are, and with the fact that I had already been using them in statistical analysis without knowing it.

## Estimation of $\pi$ using random sampling
We will introduce Monte Carlo estimation with a simple example: estimating $\pi$ by randomly sampling points inside a square and counting how many land inside a circle.

### What is a Monte Carlo estimate?
A surprising number of things we care about are averages in disguise. Write the thing you want as the expected value of some function $f$ of a random variable $X$:

$$
\mu = \mathop{\mathbb{E}}_{X \sim p}\big[f(X)\big]
$$

The Monte Carlo idea: don't compute it. Draw $N$ independent samples $X_1, \dots, X_N$ from $p$ and just average:

$$
\hat{\mu}_N = \frac{1}{N} \sum_{i=1}^{N} f(X_i)
$$

That's the whole method. And it covers more than you'd think. A probability is an average too: $P(X \in A) = \mathbb{E}[\mathbf{1}\{X \in A\}]$, the average of a 0/1 indicator. So is an area, an integral, and, from the last post, the value of a state $V(s)$. Our Pong agent was doing exactly this: playing games and averaging returns.

### Why it works: the law of large numbers
Say $f(X)$ has mean $\mu$ and a finite variance $\sigma^2$. Each sample is an unbiased guess, so the average is too:

$$
\mathbb{E}[\hat{\mu}_N] = \frac{1}{N} \sum_{i=1}^{N} \mathbb{E}[f(X_i)] = \mu
$$

And because the samples are independent, their variances add, and the average shrinks them:

$$
\operatorname{Var}(\hat{\mu}_N) = \frac{1}{N^2} \sum_{i=1}^{N} \operatorname{Var}\big(f(X_i)\big) = \frac{\sigma^2}{N}
$$

Now Chebyshev's inequality finishes the job. For any tolerance $\varepsilon > 0$:

$$
P\big(|\hat{\mu}_N - \mu| \ge \varepsilon\big) \le \frac{\operatorname{Var}(\hat{\mu}_N)}{\varepsilon^2} = \frac{\sigma^2}{N \varepsilon^2} \xrightarrow{\;N \to \infty\;} 0
$$

That's the (weak) law of large numbers: throw enough samples at it and the average gets as close to the truth as you like, with probability as close to 1 as you like. (The strong law goes further and says it converges with probability 1, but that proof is for another day.)

The catch hides in that $\sigma / \sqrt{N}$. The typical error shrinks like $1/\sqrt{N}$, so one more correct decimal place costs **100 times** more samples. Remember this one, it's going to haunt us.

### Throwing darts at $\pi$
Now the fun part. Throw darts uniformly at the square $[-1, 1]^2$ and let $f$ be 1 if the dart lands inside the unit circle, 0 otherwise. The chance of landing inside is just the ratio of the areas:

$$
P(\text{inside}) = \frac{\text{area of circle}}{\text{area of square}} = \frac{\pi \cdot 1^2}{2 \cdot 2} = \frac{\pi}{4}
\quad\Longrightarrow\quad
\pi = 4\, \mathbb{E}[f(X)] \approx 4 \times \frac{\text{darts inside}}{\text{darts thrown}}
$$

```python
rng = np.random.default_rng(0)
n = 10_000_000
x, y = rng.uniform(-1, 1, (2, n))     # throw n darts at the square
inside = x**2 + y**2 <= 1             # which ones landed in the circle
pi_hat = 4 * inside.mean()            # 3.14114
```

<figure class="plate-scroll">
  <img class="plate-light" src="/images/rl-for-llms/darts-pi.gif" width="700" height="400" style="min-width: 620px" alt="Animation: random points fill a square with an inscribed circle, blue inside the circle and gold outside, while a chart beside it tracks the running estimate of pi. The estimate swings widely for the first few hundred points and settles close to 3.14 by 20,000 points.">
  <img class="plate-dark" src="/images/rl-for-llms/darts-pi-dark.gif" width="700" height="400" style="min-width: 620px" alt="Animation: random points fill a square with an inscribed circle, blue inside the circle and gold outside, while a chart beside it tracks the running estimate of pi. The estimate swings widely for the first few hundred points and settles close to 3.14 by 20,000 points.">
  <figcaption>20,000 darts. The estimate swings wildly for the first few hundred, then settles in, slowly. It ends at 3.1334, an error of −0.008, well within the ±0.02 you'd expect from 20,000 darts.</figcaption>
</figure>

| Darts | Estimate | Error | Expected error (95%) | Time |
| --- | --- | --- | --- | --- |
| 1,000 | 3.10800 | −0.03359 | ±0.10178 | instant |
| 100,000 | 3.14832 | +0.00673 | ±0.01018 | 3 ms |
| 10,000,000 | 3.14114 | −0.00046 | ±0.00102 | 0.16 s |

Every 100× more darts buys one more decimal place, exactly as the $1/\sqrt{N}$ promised. To get $\pi$ right to three decimals with 95% confidence, you need about **41 million** darts: one dart has a standard deviation of $4\sqrt{\tfrac{\pi}{4}\left(1 - \tfrac{\pi}{4}\right)} \approx 1.64$ (on the $\pi$ scale), and $\left(1.96 \times 1.64 / 0.0005\right)^2 \approx 4.1 \times 10^7$. Cheap for numpy, but a lot of darts for a JEE student with a dartboard.

## Policy Optimization using monte carlo estimates

