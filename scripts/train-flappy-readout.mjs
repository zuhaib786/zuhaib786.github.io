import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import {
  FLAPPY_READOUT_SPECS,
  LifNetwork,
  encodeFlappyVision,
  parseFlyb,
  readoutVector,
  resolveFlappyPopulations,
} from "../public/scripts/malecns-engine.js";

const DATA_URL = new URL("../public/data/malecns/malecns-v1.0.flyb.gz", import.meta.url);
const OUTPUT_URL = new URL("../public/data/malecns/flappy-readout-v1.json", import.meta.url);
const TRAINING_SEED = 0x51f1a77;
const SAMPLE_COUNT = 360;
const WINDOW_MS = 50;

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
}

function accuracy(rows, weights, bias, mean, scale, threshold = 0.5) {
  let correct = 0;
  for (const row of rows) {
    let z = bias;
    for (let j = 0; j < weights.length; j += 1) z += weights[j] * ((row.x[j] - mean[j]) / scale[j]);
    if ((sigmoid(z) >= threshold) === Boolean(row.y)) correct += 1;
  }
  return correct / rows.length;
}

const compressed = await readFile(DATA_URL);
const sha256 = createHash("sha256").update(compressed).digest("hex");
const raw = gunzipSync(compressed);
const decompressedSha256 = createHash("sha256").update(raw).digest("hex");
const c = parseFlyb(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const populations = resolveFlappyPopulations(c);
const net = new LifNetwork(c, { dtMs: 1, gain: 0.65, seed: 20260903 });
const random = mulberry32(TRAINING_SEED);
const rows = [];
const started = performance.now();

for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
  // These cover the flight envelope of the browser game. Positive screen-space
  // error is below the aperture; positive velocity is falling.
  const state = {
    error: (random() * 2 - 1) * 1.25,
    velocity: (random() * 2 - 1) * 1.1,
    urgency: random(),
  };
  net.setStimuli(encodeFlappyVision(state, populations));
  net.runMs(WINDOW_MS);
  const x = readoutVector(net, populations, WINDOW_MS);
  // A one-step teacher asks for a wingbeat when the projected vertical miss is
  // low in the aperture. The model learns this decision from DN/motor activity,
  // never from these state values directly.
  const projectedMiss = state.error + state.velocity * (0.34 + 0.28 * state.urgency);
  rows.push({ x, y: projectedMiss > 0.06 ? 1 : 0 });
  net.clearWindow();

  // Short dark interval prevents successive samples becoming a lookup table of
  // their order while preserving realistic recurrent state between observations.
  net.setStimuli([]);
  net.runMs(12);
  net.clearWindow();
  if ((sample + 1) % 60 === 0) {
    process.stdout.write(`sample ${sample + 1}/${SAMPLE_COUNT}, active ${net.activeCount}\n`);
  }
}

// Deterministic stratified-ish split: every fifth observation is validation.
const train = rows.filter((_, index) => index % 5 !== 0);
const validation = rows.filter((_, index) => index % 5 === 0);
const dimensions = FLAPPY_READOUT_SPECS.length;
const mean = Array(dimensions).fill(0);
const scale = Array(dimensions).fill(0);
for (const row of train) for (let j = 0; j < dimensions; j += 1) mean[j] += row.x[j] / train.length;
for (const row of train) {
  for (let j = 0; j < dimensions; j += 1) scale[j] += ((row.x[j] - mean[j]) ** 2) / train.length;
}
for (let j = 0; j < dimensions; j += 1) scale[j] = Math.max(1e-6, Math.sqrt(scale[j]));

const weights = Array(dimensions).fill(0);
let bias = 0;
const learningRate = 0.055;
const l2 = 0.0015;
for (let epoch = 0; epoch < 4200; epoch += 1) {
  const gradient = Array(dimensions).fill(0);
  let biasGradient = 0;
  for (const row of train) {
    let z = bias;
    for (let j = 0; j < dimensions; j += 1) z += weights[j] * ((row.x[j] - mean[j]) / scale[j]);
    const error = sigmoid(z) - row.y;
    biasGradient += error;
    for (let j = 0; j < dimensions; j += 1) gradient[j] += error * ((row.x[j] - mean[j]) / scale[j]);
  }
  bias -= learningRate * biasGradient / train.length;
  for (let j = 0; j < dimensions; j += 1) {
    weights[j] -= learningRate * (gradient[j] / train.length + l2 * weights[j]);
  }
}

let bestThreshold = 0.5;
let bestValidation = 0;
for (let threshold = 0.3; threshold <= 0.75; threshold += 0.01) {
  const score = accuracy(validation, weights, bias, mean, scale, threshold);
  if (score > bestValidation) {
    bestValidation = score;
    bestThreshold = threshold;
  }
}

const result = {
  schema: "malecns-flappy-readout/v1",
  dataset: c.dataset,
  graphSha256: sha256,
  graphDecompressedSha256: decompressedSha256,
  graph: {
    neurons: c.n,
    connections: c.nEdges,
    minSynapsesPerConnection: 5,
  },
  neuralModel: {
    kind: "current-based LIF with exponential synapse",
    dtMs: net.dtMs,
    membraneTauMs: net.tauMs,
    synapseTauMs: net.synTauMs,
    restMv: net.vRest,
    thresholdMv: net.vThreshold,
    refractoryMs: net.refractoryMs,
    delayMs: net.delayMs,
    millivoltsPerSynapse: net.wSynMv,
    globalGain: net.gain,
  },
  encoder: {
    kind: "engineered feature-level visual drive",
    populations: ["LC4", "LPLC2", "VS", "HS"],
  },
  readout: {
    kind: "L2 logistic regression",
    features: FLAPPY_READOUT_SPECS,
    mean,
    scale,
    weights,
    bias,
    threshold: bestThreshold,
  },
  training: {
    seed: TRAINING_SEED,
    examples: rows.length,
    trainExamples: train.length,
    validationExamples: validation.length,
    windowMs: WINDOW_MS,
    trainAccuracy: accuracy(train, weights, bias, mean, scale, bestThreshold),
    validationAccuracy: bestValidation,
    generatedAt: "2026-09-11T00:00:00.000Z",
    elapsedSeconds: (performance.now() - started) / 1000,
  },
};

await mkdir(new URL("../public/data/malecns/", import.meta.url), { recursive: true });
await writeFile(OUTPUT_URL, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result.training, null, 2));
console.log(`wrote ${OUTPUT_URL.pathname}`);
