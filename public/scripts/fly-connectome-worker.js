import {
  LifNetwork,
  encodeFlappyVision,
  makeSomaSample,
  parseFlyb,
  readoutProbability,
  readoutVector,
  resolveFlappyPopulations,
} from "./malecns-engine.js";

const GRAPH_URL = new URL("../data/malecns/malecns-v1.0.flyb.gz", import.meta.url);
const MODEL_URL = new URL("../data/malecns/flappy-readout-v1.json", import.meta.url);
const TICK_MS = 50;

let connectome;
let populations;
let network;
let model;
let somaBounds;
let running = true;
let sensoryGain = 1;
let latestSense = { error: 0, velocity: 0, urgency: 0 };
let timer;

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedSpikeCoordinates() {
  const raw = network.takeSpikeCoordinates(180);
  const [minX, maxX, minY, maxY] = somaBounds;
  for (let i = 0; i < raw.length; i += 2) {
    raw[i] = (raw[i] - minX) / Math.max(1, maxX - minX);
    raw[i + 1] = (raw[i + 1] - minY) / Math.max(1, maxY - minY);
  }
  return raw;
}

function schedule(delay = TICK_MS) {
  clearTimeout(timer);
  timer = setTimeout(tick, delay);
}

function tick() {
  if (!network || !running) {
    schedule();
    return;
  }
  const stimuli = encodeFlappyVision(latestSense, populations);
  for (const stimulus of stimuli) stimulus.hz *= sensoryGain;
  network.setStimuli(stimuli);
  const spikesBefore = network.totalSpikes;
  const started = performance.now();
  network.runMs(TICK_MS);
  const computeMs = performance.now() - started;
  const vector = readoutVector(network, populations, TICK_MS);
  const probability = readoutProbability(vector, model.readout);
  const spikeCoordinates = normalizedSpikeCoordinates();

  self.postMessage({
    type: "tick",
    probability,
    flap: probability >= model.readout.threshold,
    threshold: model.readout.threshold,
    rates: vector,
    activeNeurons: network.activeCount,
    spikes: network.totalSpikes - spikesBefore,
    totalSpikes: network.totalSpikes,
    computeMs,
    neuralTimeMs: network.stepIndex * network.dtMs,
    spikeCoordinates,
  }, [spikeCoordinates.buffer]);
  network.clearWindow();
  schedule(Math.max(0, TICK_MS - computeMs));
}

async function initialize() {
  self.postMessage({ type: "status", stage: "download", label: "Downloading MaleCNS v1.0 · 22.9 MB" });
  const [graphResponse, modelResponse] = await Promise.all([fetch(GRAPH_URL), fetch(MODEL_URL)]);
  if (!graphResponse.ok) throw new Error(`Connectome download failed (${graphResponse.status})`);
  if (!modelResponse.ok) throw new Error(`Readout download failed (${modelResponse.status})`);

  const [payload, loadedModel] = await Promise.all([graphResponse.arrayBuffer(), modelResponse.json()]);
  model = loadedModel;
  self.postMessage({ type: "status", stage: "verify", label: "Verifying graph checksum" });
  const digest = hex(await crypto.subtle.digest("SHA-256", payload));
  const magic = new TextDecoder().decode(new Uint8Array(payload, 0, 4));
  const serverExpanded = magic === "FLYB";
  const expectedDigest = serverExpanded ? model.graphDecompressedSha256 : model.graphSha256;
  if (digest !== expectedDigest) throw new Error("Connectome checksum does not match the trained readout");

  self.postMessage({ type: "status", stage: "parse", label: "Expanding 176,422-neuron graph" });
  let raw = payload;
  if (!serverExpanded) {
    if (typeof DecompressionStream === "undefined") throw new Error("This browser does not support gzip decompression streams");
    const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("gzip"));
    raw = await new Response(stream).arrayBuffer();
  }
  connectome = parseFlyb(raw);
  if (connectome.dataset !== model.dataset
    || connectome.n !== model.graph.neurons
    || connectome.nEdges !== model.graph.connections) {
    throw new Error("Connectome metadata does not match the trained readout");
  }

  self.postMessage({ type: "status", stage: "index", label: "Indexing real visual and motor populations" });
  populations = resolveFlappyPopulations(connectome);
  network = new LifNetwork(connectome, {
    dtMs: model.neuralModel.dtMs,
    gain: model.neuralModel.globalGain,
    seed: 20260903,
  });
  const soma = makeSomaSample(connectome);
  somaBounds = soma.bounds;
  const populationSizes = Object.fromEntries(
    Object.entries(populations).map(([name, neurons]) => [name, neurons.length]),
  );
  self.postMessage({
    type: "ready",
    dataset: connectome.dataset,
    neurons: connectome.n,
    connections: connectome.nEdges,
    retinaEntries: connectome.nRetina,
    populationSizes,
    training: model.training,
    readoutFeatures: model.readout.features,
    soma: soma.points,
    superclassLabels: connectome.superclasses,
  }, [soma.points.buffer]);
  tick();
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "sense") latestSense = message.state;
  if (message.type === "pause") running = !message.paused;
  if (message.type === "gain") sensoryGain = Math.max(0.25, Math.min(1.75, message.value));
  if (message.type === "reset" && network) {
    network.reset();
    latestSense = { error: 0, velocity: 0, urgency: 0 };
  }
});

initialize().catch((error) => {
  self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
});
