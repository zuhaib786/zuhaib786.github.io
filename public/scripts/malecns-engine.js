/*
 * Browser LIF engine for the MaleCNS v1.0 connectome.
 *
 * The numerical model follows Shiu et al. (Nature, 2024): identical current-based
 * leaky integrate-and-fire units with an exponential synapse. The binary parser
 * and active-set stepping strategy are adapted from fly-brain-minecraft
 * (MIT, Copyright 2026 Blendi Remade / fal.ai).
 *
 * Data attribution and exact transformations are documented in
 * /data/malecns/README.md.
 */

const decoder = new TextDecoder();

function copyArray(buffer, offset, count, Type) {
  const bytes = count * Type.BYTES_PER_ELEMENT;
  const copied = buffer.slice(offset, offset + bytes);
  return { value: new Type(copied), offset: offset + bytes };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseFlyb(buffer) {
  const view = new DataView(buffer);
  let offset = 0;

  const u8 = () => view.getUint8(offset++);
  const u16 = () => {
    const value = view.getUint16(offset, true);
    offset += 2;
    return value;
  };
  const u32 = () => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const string16 = () => {
    const length = u16();
    const value = decoder.decode(new Uint8Array(buffer, offset, length));
    offset += length;
    return value;
  };
  const string32 = () => {
    const length = u32();
    const value = decoder.decode(new Uint8Array(buffer, offset, length));
    offset += length;
    return value;
  };
  const table = () => {
    const count = u16();
    return Array.from({ length: count }, string16);
  };
  const take = (count, Type) => {
    const result = copyArray(buffer, offset, count, Type);
    offset = result.offset;
    return result.value;
  };
  const skip = (bytes) => { offset += bytes; };

  const magic = decoder.decode(new Uint8Array(buffer, offset, 4));
  offset += 4;
  if (magic !== "FLYB") throw new Error("MaleCNS file has invalid FLYB magic");
  const version = u32();
  if (version !== 1) throw new Error(`Unsupported FLYB version ${version}`);

  const n = u32();
  const nEdges = u32();
  const nRetina = u32();
  const dataset = string16();
  const meta = JSON.parse(string32());
  const types = table();
  const superclasses = table();
  const classes = table();
  const subclasses = table();
  const neurotransmitters = table();
  const sides = table();
  const dimorphisms = table();
  const fruDsx = table();
  const neuromeres = table();
  const nerves = table();

  // bodyId is retained as two Uint32 halves so browsers need no BigInt array.
  const bodyId = take(n * 2, Uint32Array);
  const typeIdx = take(n, Int32Array);
  const superclassIdx = take(n, Uint8Array);
  const classIdx = take(n, Uint8Array);
  const subclassIdx = take(n, Uint16Array);
  const ntIdx = take(n, Uint8Array);
  const ntSign = take(n, Int8Array);
  const sideIdx = take(n, Uint8Array);
  const hex1 = take(n, Int8Array);
  const hex2 = take(n, Int8Array);
  const dimorphismIdx = take(n, Uint8Array);
  const fruDsxIdx = take(n, Uint8Array);
  const neuromereIdx = take(n, Uint8Array);
  const nerveIdx = take(n, Uint8Array);
  const soma = take(n * 3, Float32Array);
  const preSynapses = take(n, Int32Array);
  const postSynapses = take(n, Int32Array);
  const rowPtr = take(n + 1, Int32Array);
  const postIdx = take(nEdges, Int32Array);
  const weight = take(nEdges, Uint16Array);

  // The retina lookup is not needed by the feature-level Flappy encoder.
  // Validate its exact size so a truncated or mismatched graph still fails.
  skip(nRetina * 8);
  if (offset !== buffer.byteLength) {
    throw new Error(`MaleCNS file has ${buffer.byteLength - offset} trailing bytes`);
  }
  if (rowPtr[n] !== nEdges) throw new Error("MaleCNS CSR index is corrupt");

  return {
    dataset, meta, n, nEdges, nRetina,
    types, superclasses, classes, subclasses, neurotransmitters, sides,
    dimorphisms, fruDsx, neuromeres, nerves,
    bodyId, typeIdx, superclassIdx, classIdx, subclassIdx, ntIdx, ntSign,
    sideIdx, hex1, hex2, dimorphismIdx, fruDsxIdx, neuromereIdx, nerveIdx,
    soma, preSynapses, postSynapses, rowPtr, postIdx, weight,
  };
}

export function bodyIdAt(connectome, index) {
  const low = BigInt(connectome.bodyId[index * 2]);
  const high = BigInt(connectome.bodyId[index * 2 + 1]);
  return ((high << 32n) | low).toString();
}

export function resolvePopulation(c, spec) {
  const [selector, side] = spec.split("/");
  let mode = "type";
  let value = selector;
  if (selector.startsWith("prefix:")) {
    mode = "prefix";
    value = selector.slice(7);
  } else if (selector.startsWith("subclass:")) {
    mode = "subclass";
    value = selector.slice(9);
  } else if (selector.startsWith("superclass:")) {
    mode = "superclass";
    value = selector.slice(11);
  }
  const output = [];
  for (let i = 0; i < c.n; i += 1) {
    const type = c.types[c.typeIdx[i]];
    const matches = mode === "prefix" ? type.startsWith(value)
      : mode === "subclass" ? c.subclasses[c.subclassIdx[i]] === value
      : mode === "superclass" ? c.superclasses[c.superclassIdx[i]] === value
      : type === value;
    if (matches && (!side || c.sides[c.sideIdx[i]] === side)) output.push(i);
  }
  return Int32Array.from(output);
}

export const FLAPPY_INPUT_SPECS = ["prefix:LC4", "prefix:LPLC2", "prefix:HS", "prefix:VS"];

export const FLAPPY_READOUT_SPECS = [
  "DNp01",
  "DNp04",
  "DNp11",
  "DNp03/L",
  "DNp03/R",
  "DNa02/L",
  "DNa02/R",
  "DNg13/L",
  "DNg13/R",
  "subclass:wm",
];

export function resolveFlappyPopulations(c) {
  return Object.fromEntries(
    [...FLAPPY_INPUT_SPECS, ...FLAPPY_READOUT_SPECS]
      .map((spec) => [spec, resolvePopulation(c, spec)]),
  );
}

/**
 * Feature-level visual encoding for the game. The MaleCNS release has no model
 * that turns pixels into spikes, so signed vertical error and optic flow are
 * applied to named visual-projection populations. Rates are in spikes/second.
 */
export function encodeFlappyVision(state, populations) {
  const error = Math.max(-1.5, Math.min(1.5, state.error));
  const velocity = Math.max(-1.5, Math.min(1.5, state.velocity));
  const urgency = Math.max(0, Math.min(1, state.urgency));
  const contrast = 0.55 + 0.45 * urgency;
  const rate = (signal) => signal <= 0.015 ? 0 : (18 + 142 * Math.min(1, signal)) * contrast;
  return [
    { neurons: populations["prefix:LC4"], hz: rate(Math.max(0, error)) },
    { neurons: populations["prefix:LPLC2"], hz: rate(Math.max(0, -error)) },
    { neurons: populations["prefix:VS"], hz: rate(Math.max(0, velocity)) },
    { neurons: populations["prefix:HS"], hz: rate(Math.max(0, -velocity)) },
  ];
}

export function readoutVector(network, populations, windowMs) {
  return FLAPPY_READOUT_SPECS.map((spec) => network.populationRate(populations[spec], windowMs));
}

export function readoutProbability(vector, model) {
  let logit = model.bias;
  for (let i = 0; i < model.weights.length; i += 1) {
    logit += model.weights[i] * ((vector[i] - model.mean[i]) / model.scale[i]);
  }
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, logit))));
}

export function makeSomaSample(c, target = 2600) {
  const valid = [];
  for (let i = 0; i < c.n; i += 1) {
    if (Number.isFinite(c.soma[i * 3])) valid.push(i);
  }
  const stride = Math.max(1, Math.floor(valid.length / target));
  const chosen = [];
  for (let k = 0; k < valid.length && chosen.length < target; k += stride) chosen.push(valid[k]);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const i of chosen) {
    const x = c.soma[i * 3];
    const y = c.soma[i * 3 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const points = new Float32Array(chosen.length * 3);
  for (let p = 0; p < chosen.length; p += 1) {
    const i = chosen[p];
    points[p * 3] = (c.soma[i * 3] - minX) / Math.max(1, maxX - minX);
    points[p * 3 + 1] = (c.soma[i * 3 + 1] - minY) / Math.max(1, maxY - minY);
    points[p * 3 + 2] = c.superclassIdx[i];
  }
  return { points, bounds: [minX, maxX, minY, maxY] };
}

export class LifNetwork {
  constructor(connectome, options = {}) {
    this.c = connectome;
    this.n = connectome.n;
    this.dtMs = options.dtMs ?? 1;
    this.tauMs = 20;
    this.synTauMs = 5;
    this.vRest = -52;
    this.vThreshold = -45;
    this.vReset = -52;
    this.refractoryMs = 2.2;
    this.delayMs = 1.8;
    this.wSynMv = 0.275;
    this.gain = options.gain ?? 0.65;
    this.idleEps = 0.02;
    this.refSteps = Math.max(1, Math.round(this.refractoryMs / this.dtMs));
    this.delaySteps = Math.max(1, Math.round(this.delayMs / this.dtMs));
    this.slots = this.delaySteps + 1;
    this.decay = Math.exp(-this.dtMs / this.tauMs);
    this.synDecay = Math.exp(-this.dtMs / this.synTauMs);
    this.synCoupling = (this.synTauMs / (this.tauMs - this.synTauMs))
      * (Math.exp(-this.dtMs / this.tauMs) - Math.exp(-this.dtMs / this.synTauMs));
    this.random = seededRandom(options.seed ?? 0x20_26_09_03);

    this.v = new Float32Array(this.n);
    this.v.fill(this.vRest);
    this.g = new Float32Array(this.n);
    this.refUntil = new Int32Array(this.n);
    this.pending = new Uint16Array(this.n);
    this.delayBuf = Array.from({ length: this.slots }, () => new Float32Array(this.n));
    this.active = new Uint8Array(this.n);
    this.activeList = new Int32Array(this.n);
    this.activeCount = 0;
    this.spikeBuffer = new Int32Array(this.n);
    this.spikeCount = 0;
    this.tickSpikes = new Uint16Array(this.n);
    this.touched = new Int32Array(this.n);
    this.touchedCount = 0;
    this.sampledSpikes = new Int32Array(1024);
    this.sampledCount = 0;
    this.totalSpikes = 0;
    this.stepIndex = 0;
    this.stimuli = [];

    this.preScale = new Float32Array(this.n);
    for (let i = 0; i < this.n; i += 1) {
      this.preScale[i] = connectome.ntSign[i] * this.wSynMv * this.gain;
    }
  }

  setStimuli(stimuli) {
    this.stimuli = stimuli.filter((item) => item.neurons.length && item.hz > 0);
  }

  activate(i) {
    if (this.active[i]) return;
    this.active[i] = 1;
    this.activeList[this.activeCount++] = i;
  }

  recordSpike(i) {
    if (this.tickSpikes[i] === 0) this.touched[this.touchedCount++] = i;
    if (this.tickSpikes[i] < 65535) this.tickSpikes[i] += 1;
    this.totalSpikes += 1;
    if (this.sampledCount < this.sampledSpikes.length) {
      this.sampledSpikes[this.sampledCount++] = i;
    } else {
      const seen = this.totalSpikes;
      const slot = Math.floor(this.random() * seen);
      if (slot < this.sampledSpikes.length) this.sampledSpikes[slot] = i;
    }
  }

  emitSpike(i) {
    this.recordSpike(i);
    const scale = this.preScale[i];
    if (scale === 0) return;
    const writeSlot = (this.stepIndex + this.delaySteps) % this.slots;
    const out = this.delayBuf[writeSlot];
    for (let edge = this.c.rowPtr[i]; edge < this.c.rowPtr[i + 1]; edge += 1) {
      const post = this.c.postIdx[edge];
      if (out[post] === 0) this.pending[post] += 1;
      out[post] += scale * this.c.weight[edge];
      if (out[post] === 0) this.pending[post] -= 1;
      this.activate(post);
    }
  }

  step() {
    const step = this.stepIndex;
    const input = this.delayBuf[step % this.slots];

    for (const stimulus of this.stimuli) {
      const probability = Math.min(1, stimulus.hz * this.dtMs / 1000);
      for (let k = 0; k < stimulus.neurons.length; k += 1) {
        const i = stimulus.neurons[k];
        if (this.random() < probability) {
          this.emitSpike(i);
          this.v[i] = this.vReset;
          this.refUntil[i] = step + this.refSteps;
          this.activate(i);
        }
      }
    }

    const count = this.activeCount;
    let survivors = 0;
    this.spikeCount = 0;
    for (let k = 0; k < count; k += 1) {
      const i = this.activeList[k];
      const arriving = input[i];
      if (arriving !== 0) {
        input[i] = 0;
        this.pending[i] -= 1;
      }
      let voltage = this.v[i];
      let conductance = this.g[i] + arriving;
      const refractory = step < this.refUntil[i];
      let spiked = false;
      if (refractory) {
        voltage = this.vReset;
      } else {
        voltage = this.vRest + (voltage - this.vRest) * this.decay
          + conductance * this.synCoupling;
        conductance *= this.synDecay;
        if (voltage >= this.vThreshold) {
          spiked = true;
          voltage = this.vReset;
          conductance = 0;
          this.refUntil[i] = step + this.refSteps;
          this.spikeBuffer[this.spikeCount++] = i;
        }
      }
      this.v[i] = voltage;
      this.g[i] = conductance;
      const keep = spiked || refractory || this.pending[i] > 0
        || Math.abs(voltage - this.vRest) > this.idleEps
        || Math.abs(conductance) > this.idleEps;
      if (keep) this.activeList[survivors++] = i;
      else this.active[i] = 0;
    }
    this.activeCount = survivors;
    for (let k = 0; k < this.spikeCount; k += 1) this.emitSpike(this.spikeBuffer[k]);
    this.stepIndex += 1;
  }

  runMs(milliseconds) {
    const steps = Math.round(milliseconds / this.dtMs);
    for (let i = 0; i < steps; i += 1) this.step();
  }

  populationRate(population, windowMs) {
    if (!population.length || windowMs <= 0) return 0;
    let spikes = 0;
    for (let k = 0; k < population.length; k += 1) spikes += this.tickSpikes[population[k]];
    return spikes * 1000 / (population.length * windowMs);
  }

  populationSpikes(population) {
    let spikes = 0;
    for (let k = 0; k < population.length; k += 1) spikes += this.tickSpikes[population[k]];
    return spikes;
  }

  takeSpikeCoordinates(limit = 220) {
    const count = Math.min(limit, this.sampledCount);
    const points = new Float32Array(count * 2);
    let written = 0;
    for (let k = 0; k < this.sampledCount && written < count; k += 1) {
      const i = this.sampledSpikes[k];
      const x = this.c.soma[i * 3];
      const y = this.c.soma[i * 3 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points[written * 2] = x;
      points[written * 2 + 1] = y;
      written += 1;
    }
    return points.slice(0, written * 2);
  }

  clearWindow() {
    for (let k = 0; k < this.touchedCount; k += 1) this.tickSpikes[this.touched[k]] = 0;
    this.touchedCount = 0;
    this.sampledCount = 0;
  }

  reset() {
    this.v.fill(this.vRest);
    this.g.fill(0);
    this.refUntil.fill(0);
    this.pending.fill(0);
    for (const slot of this.delayBuf) slot.fill(0);
    this.active.fill(0);
    this.tickSpikes.fill(0);
    this.activeCount = 0;
    this.spikeCount = 0;
    this.touchedCount = 0;
    this.sampledCount = 0;
    this.totalSpikes = 0;
    this.stepIndex = 0;
    this.stimuli = [];
  }
}
