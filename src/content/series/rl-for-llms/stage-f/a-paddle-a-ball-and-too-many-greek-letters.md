---
title: "A Paddle, a Ball and Too Many Greek Letters"
description: "Lab F1, part 1. The vocabulary of RL (states, rewards, policies, values and Bellman), grounded in a game of Pong."
date: 2026-10-02
order: 1
tags: ["RL", "Policy Gradient", "PyTorch"]
draft: false
---

<!-- Code: rl-for-llms/stage-f/f1-rl-basics/pong/ -->

## Background
Before we begin with RL for LLMs, it is important for us to understand what RL is. I have always been pulled towards the end-goal sweetness of machine learning algorithms,
and my first introduction to RL was when AlphaZero became a sensation in the chess world. I was very curious to learn the field. Alas, I read a line in some post about
AlphaZero saying it was trained on way too much compute and that RL needed too much compute to work in practice, and my procrastination got the better of me.

Come 2023, RL began entering the headlines again when post-training LLMs with reinforcement learning began gaining traction. Again my curiosity peaked, but so did my procrastination, and now in 2026 I have formally decided to pick it up (might be too late at this point, but who cares. Just having fun and seeing where the future will take us).
So yeah, me and my Claude have started on a proper RL learning plan, and to the best of my ability I want to stick to it, unless I have to buy some subscriptions ☺️ or purchase some compute.
This series I want to keep as informal as possible: I just share my raw, uncut thoughts and try to take the reader to the places I have been while learning RL.

## Introduction to RL
Every problem in RL can be formalized as a simple interaction loop between an agent and an environment. The environment is what the agent interacts with, and the agent's actions in turn lead to changes in the environment.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/rl-for-llms/agent-environment-loop.svg" width="700" height="300" style="min-width: 620px" alt="The agent sends an action to the environment. The environment changes and sends back the next observation and a reward. In Pong, the agent is a policy network and the environment is the Atari game.">
  <img class="plate-dark" src="/images/rl-for-llms/agent-environment-loop-dark.svg" width="700" height="300" style="min-width: 620px" alt="The agent sends an action to the environment. The environment changes and sends back the next observation and a reward. In Pong, the agent is a policy network and the environment is the Atari game.">
  <figcaption>That's it. That's the whole game. Everything else in this post is naming the arrows.</figcaption>
</figure>

Then, as you read books about RL, you will see ridiculous examples of states and agents that will make you (if you are like me) scratch your head and say "How the heck will you model this, bro?" e.g.
>A mobile robot decides whether it should enter a new room in search of more trash to collect or start trying to find its way back to its battery recharging station. It makes its decision based on the current charge level of its battery and how quickly and easily it has been able to find the recharger in the past. (Sutton & Barto)

Examples like these, while they truly develop intuition about RL, have always caused problems for me, since I feel the urge to reach the end state as quickly as possible, and the next sections of RL are nowhere close to it. No gratification, loss of interest, and then, you guessed it, drop the whole damn thing.
So I am not making that same mistake here. The next sections, as you will see, are all about terminology and an attempt to solve a really basic environment in which the actions are very simple and the environment is "pretty much" deterministic.

## Terminology
In an RL problem:
1. A "snapshot" of the environment is called a state, and the set of all states the environment can be in is called the state space $S$.
2. The set of actions the agent can perform on the environment is called the action space $A$.
3. Most of the time an agent does not see all the information about the environment, only a subset of it. These are called observations, and their set is called the observation space.

An important distinction between states and observations: observations are what the agent actually bases its actions on, while the state is what the environment's transitions actually depend on.

Enough robots looking for trash. Let's take Pong, the one we are going to solve:

- **State**: everything the Atari is actually tracking. Where the ball is, which way and how fast it is moving, where both paddles are, and the score.
- **Action**: what our paddle can do. Move up, move down, or just stay put. (The emulator technically gives us 6 buttons, but come on, it's Pong. Karpathy gets away with only up and down; I'm adding "do nothing", because sometimes the best move is no move.)
- **Observation**: the 210×160 screen. Just pixels.

```python
obs, info = env.reset()
obs.shape            # (210, 160, 3): an RGB frame, nothing more
env.action_space     # Discrete(6), of which we only care about UP (2), DOWN (3) and NOOP (0)
```

And here is the catch that makes the distinction worth the paragraph: one frame tells you *where* the ball is, but not *where it's going*. The ball's velocity is part of the state but not of a single observation. Freeze any frame of Pong and try to tell me if the ball is coming towards you or going away. You can't. That's why we will feed our agent the difference between two consecutive frames, a cheap trick to sneak the velocity back into what the agent sees.

## Rewards
In almost every RL problem we want to achieve an objective, e.g. in ping pong it is to get the ball past the opponent. Rewards either act as a proxy for
the final objective we want to achieve (often) or are simply the objective itself (rarely).
Taking the ping pong example:
> A simple reward might be how many times I have been able to bump the ball. While this does not directly measure the objective, the ability to keep the ball in play longer generally leads to winning the point.

Rewards can be thought of as small, short-term gratifications given to the agent, which indicate how close it is to (or how likely it is to achieve) the objective.

Fun fact: Atari Pong is one of the rare cases where the reward *is* the objective. You get $+1$ when you win a point, $-1$ when you lose one, and $0$ on every other frame. Which means for the overwhelming majority of frames the agent is told... nothing. Keep that in mind, it will hurt later.

Now, one reward on its own is not what we care about. We care about the rewards collected over a whole run. A run is called a **trajectory** (or an episode, or a rollout; RL people really like having three names for everything):

$$
\tau = (s_0, a_0, s_1, a_1, s_2, a_2, \dots)
$$

There are two standard ways to add up the rewards of a trajectory.

**Finite horizon, undiscounted.** Just sum up everything you got in $T$ steps:

$$
R(\tau) = \sum_{t=0}^{T} r_t
$$

**Infinite horizon, discounted.** Sum up everything, forever, but shrink the future by a factor $\gamma \in (0, 1)$ per step:

$$
R(\tau) = \sum_{t=0}^{\infty} \gamma^t r_t
$$

Why discount? Two reasons. Intuitively, a point now is worth more than a point a thousand frames from now (same reason money now beats money later). Mathematically, without $\gamma$ an infinite sum of rewards might just blow up, and with it the sum is guaranteed to converge.

A game of Pong ends at 21, so it is technically finite, but we will still use $\gamma = 0.99$. It's a handy way of saying "the frames right before a point had more to do with it than the frames 500 steps earlier".

```python
def discounted_return(rewards, gamma=0.99):
    return sum(gamma**t * r for t, r in enumerate(rewards))
```

And now, finally, the objective in terms of the reward itself. The agent picks actions, the environment is a bit random, so the trajectories are random too. The goal is to make the **expected** return as large as possible:

$$
J(\pi) = \mathop{\mathbb{E}}_{\tau \sim \pi}\big[R(\tau)\big]
$$

Read it as: "play a lot of games with this agent, average the returns". Everything else in RL is a fancy way of estimating this number and pushing it up.

## Policies
So what is this $\pi$ that sneaked into the objective? The policy is the agent's brain: the rule that looks at what the agent sees and decides what it does. It comes in two flavours.

A **deterministic** policy always does the same thing in the same situation:

$$
a_t = \mu(s_t)
$$

A **stochastic** policy gives a probability for each action and then rolls the dice:

$$
a_t \sim \pi(\cdot \mid s_t)
$$

In deep RL the policy is a neural network with weights $\theta$, so you will see it written as $\pi_\theta$. Learning = changing $\theta$.

For Pong, our policy will be a small ConvNet that takes the frame difference and spits out three numbers, one score per action. Softmax turns the scores into probabilities, and then we roll a (loaded) three-sided die:

```python
logits = net(x)                 # 3 scores: UP, DOWN, STAY
action = sample_action(logits)  # softmax, then roll the die
```

Why not just always pick the most likely action? Because a paddle that always does what it currently thinks is best never finds out that it was wrong. The die roll is how the agent explores. Early on all three probabilities hover around $1/3$ and our paddle twitches around like it had too much coffee. As it learns, the probabilities get sharper and the twitching turns into actual intent (hopefully).

## Value functions
A value function answers one question: **how good is it to be here?** "Good" meaning "how much return do I expect from here on, if I keep playing with policy $\pi$".

The **state value** of $s$:

$$
V^{\pi}(s) = \mathop{\mathbb{E}}_{\tau \sim \pi}\big[R(\tau) \mid s_0 = s\big]
$$

The **action value** of $s$, if I first take action $a$ and then go back to following $\pi$:

$$
Q^{\pi}(s, a) = \mathop{\mathbb{E}}_{\tau \sim \pi}\big[R(\tau) \mid s_0 = s, a_0 = a\big]
$$

Put a star on them ($V^*$, $Q^*$) and they mean the same thing, but for the best possible policy instead of ours.

In Pong terms: the ball is heading towards you and your paddle is already right where it needs to be? High $V$. The ball has already gone past your paddle? $V$ is basically $-1$, and nothing you press now changes that. Brutal, but fair.

And the one we will actually need later, the **advantage**:

$$
A^{\pi}(s, a) = Q^{\pi}(s, a) - V^{\pi}(s)
$$

It asks: "how much better is pressing $a$ here than what I would normally do here?" Positive advantage, do more of that. Negative, do less. If you remember one formula from this post, make it this one, because the policy gradient is basically "push up the actions with positive advantage", and GRPO, the thing that trains LLMs, is basically a clever way to estimate it without learning $V$ at all.

## Bellman Equations
Here's the thing about value functions: they are defined over the *entire* future. Computing that directly sounds horrible. Bellman's trick is to not do it. The value of where you are is just what you get now, plus the (discounted) value of where you land next:

$$
V^{\pi}(s) = \mathop{\mathbb{E}}_{a \sim \pi,\, s' \sim P}\big[r(s, a) + \gamma V^{\pi}(s')\big]
$$

$$
Q^{\pi}(s, a) = \mathop{\mathbb{E}}_{s' \sim P}\Big[r(s, a) + \gamma \mathop{\mathbb{E}}_{a' \sim \pi}\big[Q^{\pi}(s', a')\big]\Big]
$$

Here $P$ is the environment's transition rule: given $s$ and $a$, where do I end up? For the optimal versions, swap "average over what $\pi$ would do" for "take the best action":

$$
V^{*}(s) = \max_{a} \mathop{\mathbb{E}}_{s' \sim P}\big[r(s, a) + \gamma V^{*}(s')\big]
$$

$$
Q^{*}(s, a) = \mathop{\mathbb{E}}_{s' \sim P}\big[r(s, a) + \gamma \max_{a'} Q^{*}(s', a')\big]
$$

If you have done dynamic programming before, this should smell very familiar. Don't solve the whole future; trust your estimate of the next step and repeat until nothing changes.

Enough Greek. Let's actually do it, on the dumbest environment I could think of: a corridor of 5 cells, you can step left or right, and stepping into the last cell gets you $+1$ and ends the game.

```python
import numpy as np

n, goal, gamma = 5, 4, 0.9
V = np.zeros(n)

def step(s, a):                      # a = -1 (left) or +1 (right)
    s2 = min(max(s + a, 0), n - 1)
    return s2, (1.0 if s2 == goal else 0.0)

for sweep in range(50):
    for s in range(n):
        if s == goal:
            continue                 # terminal: nothing left to earn
        V[s] = max(r + gamma * V[s2] for s2, r in (step(s, a) for a in (-1, +1)))

print(V.round(3))   # [0.729 0.81  0.9   1.    0.   ]
```

That's $V^*$, straight out of the Bellman optimality equation. The cell next to the goal is worth $1$, and every step further away costs a factor of $\gamma$. 15 lines, no neural network, no GPU.

So why don't we just do this for Pong? Because that `for s in range(n)` loop is over *every state*. In Pong a state is every possible arrangement of ball, velocity and two paddles, and through our eyes it's every possible 80×80 image. Good luck looping over that. So for Pong we skip computing values altogether and go straight for the policy: nudge $\theta$ so that actions which led to winning points become more likely. That's the policy gradient, and we'll get to it in the Training section below.



## The Pong Game
Well, no better way to learn RL than a blog post from [Karpathy sensei](https://karpathy.github.io/2016/05/31/rl/). I read the post and understood the mechanics of what he wanted to convey, and in it he mentions that we can do slightly better than his implementation with hyperparameter tuning and CNNs. Well, hyperparameter tuning is where I just want to sleep (argh!!!!), so we take the CNN route only.

I also wanted to do something slightly different from what he does. In his demo video I saw the paddle was way too fidgety, and figured it might be because `sensei` chose only two actions (`UP` and `DOWN`). With only those two, the paddle literally cannot stand still. So our second "novelty" is one more action, `STAY`, and I expect it to give much smoother movement and much more human-like play, but who knows!! At least we get to play with the problem in our own lane and discover the treasure moments Karpathy might have found himself (yeah right!!).

So here is the setting: we will train our RL agent to play the famous Atari game Pong, and all the agent gets are the frame pixels, a snapshot of the env at that moment.

If you have been paying attention to the section on state spaces, you will quickly ask: "Hey, that is not all the information about the env. What about the velocity? How do we know where the ball is moving?" True. In a single frame, a ball moving in any direction is a valid state for that observation.

Well, as a sharp mind like you may say, we give two frames, at time $t$ and $t - 1$ (whatever your time indexing is), and let the agent do the work. Brilliant, that works. But we don't need to send both frames in their entirety. We can represent motion simply by the difference in pixels between the two frames. That cuts down the information we give the agent, but what we do send is (hopefully) sufficient to decide the action it needs to take.

Before subtracting anything, each frame goes on a small diet, straight from sensei's code. Crop out the score, keep every second pixel, throw away colour, and set everything that isn't background to 1:

```python
def preprocess(frame):
    frame = frame[35:195]               # crop the score and the borders
    frame = frame[::2, ::2, 0].copy()   # every 2nd pixel, one colour channel: 80x80
    frame[frame == 144] = 0             # erase the background...
    frame[frame == 109] = 0             # ...both shades of it
    frame[frame != 0] = 1               # paddles and ball become 1
    return frame.astype(np.float32)

cur = preprocess(obs)
x = cur - prev   # +1 where something arrived, -1 where it left, 0 everywhere else
prev = cur
```

<figure class="plate-scroll">
  <img class="plate-light" src="/images/rl-for-llms/frame-difference.svg" width="700" height="360" style="min-width: 620px" alt="A raw 210 by 160 colour Atari frame is cropped, downsampled and binarised into an 80 by 80 image of paddles and ball. Subtracting the previous preprocessed frame leaves only what moved: plus one where an object arrived, minus one where it left.">
  <img class="plate-dark" src="/images/rl-for-llms/frame-difference-dark.svg" width="700" height="360" style="min-width: 620px" alt="A raw 210 by 160 colour Atari frame is cropped, downsampled and binarised into an 80 by 80 image of paddles and ball. Subtracting the previous preprocessed frame leaves only what moved: plus one where an object arrived, minus one where it left.">
  <figcaption>Two real consecutive frames. Both paddles moved down, so each leaves a −1 where it was and a +1 where it is now. The ball's direction is right there in the pixels.</figcaption>
</figure>

So here we have:

- **State**: everything the emulator tracks: ball position and velocity, both paddles, the score. From where we sit, the full history of frames up to $t$ is a good stand-in for it.
- **Observation**: what we actually feed the agent, the difference between the preprocessed frames at $t$ and $t - 1$.
- **Action**: `UP`, `DOWN`, `STAY`.
- **Reward**: $+1$ when we win a point, $-1$ when we lose one, $0$ on every other frame.

That is it. We have formalized the RL problem.

### Eureka number two: where did my paddle go?
But wait. Remember eureka number one? A single frame has no velocity, so we fed the agent the difference between two frames. Well, the difference frame has the exact opposite problem: it has *only* velocity. Anything standing still becomes zero, so it is simply not there.

Now remember our big "novelty", `STAY`? The moment our agent decides to stay put, its own paddle vanishes from what it sees. Try returning a ball when you can see the ball but not your own hand.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/rl-for-llms/paddle-vanishes.svg" width="700" height="360" style="min-width: 620px" alt="Two real consecutive Pong frames in which our paddle did not move. In the preprocessed current frame the paddle is clearly visible on the right. In the difference between the two frames the moving ball and the opponent paddle remain; where our paddle should be there is nothing.">
  <img class="plate-dark" src="/images/rl-for-llms/paddle-vanishes-dark.svg" width="700" height="360" style="min-width: 620px" alt="Two real consecutive Pong frames in which our paddle did not move. In the preprocessed current frame the paddle is clearly visible on the right. In the difference between the two frames the moving ball and the opponent paddle remain; where our paddle should be there is nothing.">
  <figcaption>Two real consecutive frames where our paddle chose STAY. The ball and the opponent's paddle moved, so they show up. Ours didn't, so it's gone.</figcaption>
</figure>

Sensei never ran into this: with only `UP` and `DOWN`, his paddle is always moving, so it always shows up in the difference. Our own novelty came back to bite us (treasure moments, yeah right!!).

The fix: give the agent both. The current frame for *where* things are, and the difference for *where they are going*. Two channels, the same way a colour image has three:

```python
cur = preprocess(obs)
x = np.stack([cur, cur - prev])   # channel 0: where things are, channel 1: where they're going
prev = cur
```

So the observation gets one small upgrade:

- **Observation**: the preprocessed frame at $t$, stacked with its difference from the frame at $t - 1$. Shape $2 \times 80 \times 80$.

## Network
Our network is a run-of-the-mill CNN, and not even our own: it is the exact stack DeepMind used in their 2013 Atari paper, [Playing Atari with Deep Reinforcement Learning](https://arxiv.org/abs/1312.5602). Two Conv2D layers with a non-linearity after each, a hidden linear layer, and finally a simple linear projection with one score per action. That is it.

<figure class="plate-scroll">
  <img class="plate-light" src="/images/rl-for-llms/policy-network.svg" width="700" height="320" style="min-width: 620px" alt="The policy network. Input 2 by 80 by 80. Conv 1: 16 filters of 8 by 8 with stride 4 and ReLU, giving 16 by 19 by 19, 2,064 parameters. Conv 2: 32 filters of 4 by 4 with stride 2 and ReLU, giving 32 by 8 by 8, 8,224 parameters. Flatten to 2,048. Hidden linear layer with ReLU to 256 units, 524,544 parameters. Output linear layer to 3 logits, 771 parameters. Softmax gives 3 probabilities. 535,603 parameters in total, 98 percent of them in the hidden layer.">
  <img class="plate-dark" src="/images/rl-for-llms/policy-network-dark.svg" width="700" height="320" style="min-width: 620px" alt="The policy network. Input 2 by 80 by 80. Conv 1: 16 filters of 8 by 8 with stride 4 and ReLU, giving 16 by 19 by 19, 2,064 parameters. Conv 2: 32 filters of 4 by 4 with stride 2 and ReLU, giving 32 by 8 by 8, 8,224 parameters. Flatten to 2,048. Hidden linear layer with ReLU to 256 units, 524,544 parameters. Output linear layer to 3 logits, 771 parameters. Softmax gives 3 probabilities. 535,603 parameters in total, 98 percent of them in the hidden layer.">
  <figcaption>Two channels in, three scores out. Softmax and the dice roll happen outside the network.</figcaption>
</figure>

```python
class PolicyNet(nn.Module):
    def __init__(self, n_actions=3, in_channels=2):
        super().__init__()
        self.model = nn.Sequential(
            nn.Conv2d(in_channels, 16, kernel_size=8, stride=4),  # 2x80x80 -> 16x19x19
            nn.ReLU(),
            nn.Conv2d(16, 32, kernel_size=4, stride=2),           #         -> 32x8x8
            nn.ReLU(),
            nn.Flatten(),                                         #         -> 2048
            nn.Linear(32 * 8 * 8, 256),                           #         -> 256
            nn.ReLU(),
            nn.Linear(256, n_actions),                            #         -> 3 logits
        )

    def forward(self, x):
        return self.model(x)
```

## Training
The training is exactly as Karpathy describes in his blog post: policy gradients, with the RMSProp optimizer.

### What we want
Remember the objective from the Rewards section? Make the expected return as large as possible:

$$
J(\theta) = \mathop{\mathbb{E}}_{\tau \sim \pi_\theta}\big[R(\tau)\big]
$$

The plan is plain gradient ascent: compute $\nabla_\theta J$ and take a step uphill, $\theta \leftarrow \theta + \alpha \nabla_\theta J$. The problem: $\theta$ lives inside the thing we are *sampling* from. The games themselves depend on our weights, and we can't backprop through `env.step()`. The Atari doesn't hand out gradients.

### The log-derivative trick
Write the expectation as an integral over trajectories, and use one line of calculus, $\nabla P = P \, \nabla \log P$:

$$
\nabla_\theta J = \int \nabla_\theta P(\tau \mid \theta)\, R(\tau)\, d\tau = \int P(\tau \mid \theta)\, \nabla_\theta \log P(\tau \mid \theta)\, R(\tau)\, d\tau = \mathop{\mathbb{E}}_{\tau \sim \pi_\theta}\big[\nabla_\theta \log P(\tau \mid \theta)\, R(\tau)\big]
$$

Now the gradient is an expectation again, which means we can estimate it by just playing games and averaging. And what is $P(\tau \mid \theta)$? Start state, then alternate between our policy picking an action and the environment moving:

$$
P(\tau \mid \theta) = \rho_0(s_0) \prod_{t} P(s_{t+1} \mid s_t, a_t)\, \pi_\theta(a_t \mid s_t)
$$

The log turns the product into a sum, and here is the magic: the environment terms don't depend on $\theta$. The physics of Pong does not care about our weights. Their gradient is zero and they just vanish:

$$
\nabla_\theta J = \mathop{\mathbb{E}}_{\tau \sim \pi_\theta}\Big[\sum_{t} \nabla_\theta \log \pi_\theta(a_t \mid s_t)\, R(\tau)\Big]
$$

Read it as: **make every action in a game more likely, in proportion to how good the game was**. No model of the environment needed. Just play, score, and nudge.

### Two fixes that make it actually work
Taken literally, that formula blames every action in a lost game for the whole loss, including the ones from 15 points ago. Two fixes.

**Only the future counts.** An action can only affect rewards that come after it. In Pong it is even stricter: once a point is over, nothing before it matters for the next one. So instead of the game's total $R(\tau)$, each action gets the discounted return of *its own point*, which is exactly what `discount_rewards` from the repo computes:

```python
def discount_rewards(r, gamma):
    reward = np.zeros_like(r, dtype=np.float64)
    current_reward = 0
    for t in reversed(range(len(r))):
        if r[t] != 0:            # a point ended here: start a fresh sum
            current_reward = 0
        current_reward = current_reward * gamma + r[t]
        reward[t] = current_reward
    return reward
```

**Compare against a baseline.** Early on we lose every point, so every return is negative and *every* action gets pushed down. That is a lot of noise for very little signal. Subtracting the mean and dividing by the standard deviation fixes it: within each game, the better half of the actions get pushed up and the worse half get pushed down.

```python
def normalize(returns):
    return (returns - np.mean(returns)) / (np.std(returns) + EPSILON)
```

Subtracting a baseline does not change the expected gradient (its expectation works out to zero), it only cuts the noise. Call the normalized return $\hat{A}_t$, a poor man's advantage from the Value functions section, and the gradient we actually use is:

$$
\nabla_\theta J \approx \sum_{t} \nabla_\theta \log \pi_\theta(a_t \mid s_t)\, \hat{A}_t
$$

### A loss that autograd understands
PyTorch minimizes losses, so we flip the sign and let autograd do the $\nabla_\theta$:

```python
def policy_loss(logits, actions, advantages):
    log_probs = torch.log_softmax(logits, dim=-1)
    taken = log_probs[torch.arange(len(actions)), actions]   # log pi(a_t | s_t)
    return -(taken * advantages).sum()
```

Squint at it and it is plain old cross-entropy. That is sensei's best insight in the whole post: policy gradient is supervised learning where we pretend the action we happened to sample was the correct label, then weight each example by how well things turned out. Good outcome, "yes, do that again". Bad outcome, "learn the opposite".

### The loop
Trimmed for the blog (the full version with logging and checkpoints lives in the repo):

```python
for episode in itertools.count(1):
    frames, actions, rewards = play_one_game(net)       # sample actions, no gradients
    adv = normalize(discount_rewards(np.array(rewards), GAMMA))
    loss = policy_loss(net(frames), torch.tensor(actions), torch.tensor(adv))
    loss.backward()                                     # gradients pile up across games
    if episode % BATCH_SIZE == 0:
        optimizer.step()                                # RMSProp, once every 10 games
        optimizer.zero_grad()
```

| Hyperparameter | Value |
| --- | --- |
| Games per update | 10 |
| Learning rate | $10^{-4}$ |
| Discount $\gamma$ | 0.99 |
| RMSProp decay | 0.99 |

### Why this takes forever
A point of early Pong lasts around 40 steps (824 steps for a 21–0 loss in my first games). The only feedback is a single $-1$ at the end, smeared over all 40 actions. The two moves that actually lost the point and the 38 that didn't matter get exactly the same blame. Only after averaging over thousands of games does the signal start to say which actions were the bad ones. Hence: brace yourself.

## Results

<figure>
  <video controls muted playsinline preload="metadata" width="480" height="630" poster="/videos/rl-for-llms/pong-agent-wins-21-6-poster.jpg" style="display: block; width: 100%; max-width: 360px; height: auto; margin: 0 auto;" aria-label="A full game of Atari Pong. Our agent controls the green paddle on the right and beats the built-in opponent 21 to 6.">
    <source src="/videos/rl-for-llms/pong-agent-wins-21-6.mp4" type="video/mp4">
    Your browser can't play this video. <a href="/videos/rl-for-llms/pong-agent-wins-21-6.mp4">Download it instead</a>.
  </video>
  <figcaption>Our agent (green, right) beating the built-in opponent 21–6, after 10,481 games of training. A full game, played at 2× speed.</figcaption>
</figure>

Well, it works!! Up there is the final agent (green, on the right) taking a game 21–6 off the built-in Atari opponent. Not bad for a paddle that started out twitching like it had too much coffee.

Here is how we got there. Three runs made it to the end:

<figure class="plate-scroll">
  <img class="plate-light" src="/images/rl-for-llms/reward-curves.svg" width="700" height="420" style="min-width: 620px" alt="Average reward per 500 games for three training runs. The tiny network stays near minus 20 for all 3,232 of its games. The 535k network at learning rate 1e-4 climbs slowly to about minus 11 after 17,849 games. The same network at learning rate 1e-3 crosses zero, even with the opponent, around game 3,500 and levels off near plus 12 by game 10,481.">
  <img class="plate-dark" src="/images/rl-for-llms/reward-curves-dark.svg" width="700" height="420" style="min-width: 620px" alt="Average reward per 500 games for three training runs. The tiny network stays near minus 20 for all 3,232 of its games. The 535k network at learning rate 1e-4 climbs slowly to about minus 11 after 17,849 games. The same network at learning rate 1e-3 crosses zero, even with the opponent, around game 3,500 and levels off near plus 12 by game 10,481.">
  <figcaption>Each dot is the average reward over 500 games. +21 would be winning every point, −21 losing every point.</figcaption>
</figure>

- **The tiny network** (1,353 parameters, frame difference only) never really got off the floor: after 3,232 games it was still losing about 20–0.
- **The 535k network at learning rate $10^{-4}$** (sensei's learning rate) did learn, just painfully slowly: after 17,849 games it was still losing by about 11 points a game.
- **The same network at $10^{-3}$** crossed the "even with the opponent" line around game 3,500 and kept going. Over its last 500 games it won by 12 points a game on average, and the final checkpoint won all 10 games I recorded with it, by margins from 21–14 to 21–6.

The last two runs are the same network with the same input. The only thing I changed was the learning rate. Ten times bigger steps turned "losing by 11 after 18,000 games" into "winning by 12 after 10,000". So much for skipping hyperparameter tuning because it makes me want to sleep (argh!!).

And my big novelty, `STAY`? The agent voted it out. It started at a third of all actions and ended at 0% in both of the big runs. Watch the video again: the paddle never stands still, which is exactly the fidgety play I added `STAY` to fix. Turns out sensei knew what he was doing with two actions.

Everything ran on a rented 8-core CPU machine, no GPU. The winning run took about 17 hours.

## Policy gradient variants
What good is a post about policy gradients if we don't include a discussion about the variants of policy gradients? Well, the best resource to learn about them is the
[Spinning Up blog](https://spinningup.openai.com/en/latest/spinningup/rl_intro3.html), but I am worth my salt (sorry for being salty), so I want to add a few words of my own.

### They all share one shape
Every policy gradient in this post, and in most of the papers you will read, looks like this:

$$
\nabla_\theta J = \mathop{\mathbb{E}}_{\tau \sim \pi_\theta}\Big[\sum_{t} \nabla_\theta \log \pi_\theta(a_t \mid s_t)\, \Psi_t\Big]
$$

The $\nabla_\theta \log \pi_\theta(a_t \mid s_t)$ part never changes: it is the direction that makes action $a_t$ more likely in state $s_t$. The only thing that changes is $\Psi_t$, the number that says *how hard* to push, and in which direction. Our Pong agent used $\Psi_t$ = the discounted return of the current point. Swap in a different $\Psi_t$ and you get a different variant.

### From baselines to the advantage function
**Step 1: the baseline.** Take our reward-to-go $\hat{R}_t$ and subtract any function of the state, $b(s_t)$:

$$
\Psi_t = \hat{R}_t - b(s_t)
$$

Why is that allowed? Because on average, the extra term contributes exactly nothing. For any state, sum over the actions the policy could take:

$$
\mathop{\mathbb{E}}_{a \sim \pi_\theta}\big[\nabla_\theta \log \pi_\theta(a \mid s)\, b(s)\big] = b(s) \sum_a \pi_\theta(a \mid s)\, \nabla_\theta \log \pi_\theta(a \mid s) = b(s)\, \nabla_\theta \sum_a \pi_\theta(a \mid s) = b(s)\, \nabla_\theta 1 = 0
$$

The probabilities always add up to 1, and the gradient of a constant is zero. So the baseline leaves the gradient unbiased; it only changes how noisy each sample is. (Our `normalize` was a baseline too, a crude one: the same number for every frame of the game.)

**Step 2: the on-policy action-value function.** $\hat{R}_t$ is one noisy sample of what happens after taking $a_t$ in $s_t$. Its average is exactly the action-value function from the Value functions section:

$$
Q^{\pi}(s_t, a_t) = \mathop{\mathbb{E}}\big[\hat{R}_t \mid s_t, a_t\big]
$$

So we can use $\Psi_t = Q^{\pi}(s_t, a_t)$ instead: same expected gradient, but without the luck of one particular game baked in.

**Step 3: the value function as the baseline.** Now combine the two steps. Use $Q^{\pi}$ as the signal, and the state value $V^{\pi}(s_t)$ as the baseline:

$$
\Psi_t = Q^{\pi}(s_t, a_t) - V^{\pi}(s_t) = A^{\pi}(s_t, a_t)
$$

And there it is, the advantage function from the Value functions section, now with a job: "how much better was this action than what I usually do here?"

### Why the advantage function is the usual choice
- **It is centered.** Averaged over the policy's own actions, the advantage is exactly zero, $\mathop{\mathbb{E}}_{a \sim \pi}\big[A^{\pi}(s, a)\big] = 0$. So in every state, better-than-usual actions get pushed up and worse-than-usual ones get pushed down. Compare that with raw returns early in Pong: we lose every point, every return is negative, and *every* action gets pushed down at once.
- **It blames the right moves.** Remember the ball that has already gone past the paddle? Nothing you press changes the outcome, so $Q^{\pi}(s, a) \approx V^{\pi}(s)$ for every action, and the advantage is about zero. Those frames stop collecting blame for a point that was already lost. Raw returns would punish them all with a $-1$.
- **It is still unbiased.** $V^{\pi}(s_t)$ only depends on the state, so Step 1 covers it: the expected gradient is unchanged.
- **It usually has much less noise.** The good luck or bad luck of the situation is already priced into $V^{\pi}$, so what is left is mostly the effect of the action itself. Less noise per sample means fewer games for the same progress.

The catch: nobody hands us $Q^{\pi}$ or $V^{\pi}$. They have to be estimated, usually by a second network (a *critic*) that learns them alongside the policy.

## Recommended Resources
1. [OpenAI Spinning Up: Key Concepts in RL](https://spinningup.openai.com/en/latest/spinningup/rl_intro.html)
2. [OpenAI Spinning Up: Intro to Policy Optimization](https://spinningup.openai.com/en/latest/spinningup/rl_intro3.html)
3. [Karpathy: Pong from Pixels](https://karpathy.github.io/2016/05/31/rl/)
