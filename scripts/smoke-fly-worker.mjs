import { Worker } from "node:worker_threads";

const workerUrl = new URL("../public/scripts/fly-connectome-worker.js", import.meta.url);
const wrapper = `
  import { readFile } from "node:fs/promises";
  import { parentPort } from "node:worker_threads";
  globalThis.self = globalThis;
  globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
  globalThis.addEventListener = (name, listener) => {
    if (name === "message") parentPort.on("message", (data) => listener({ data }));
  };
  globalThis.fetch = async (url) => {
    const data = await readFile(url);
    return new Response(data, { status: 200 });
  };
  await import(${JSON.stringify(workerUrl.href)});
`;

const worker = new Worker(wrapper, { eval: true, type: "module" });
const timeout = setTimeout(async () => {
  await worker.terminate();
  throw new Error("Fly connectome worker did not produce a tick within 20 seconds");
}, 20_000);

let ready = false;
worker.on("message", async (message) => {
  if (message.type === "error") {
    clearTimeout(timeout);
    await worker.terminate();
    throw new Error(message.message);
  }
  if (message.type === "ready") {
    if (message.dataset !== "male-cns:v1.0" || message.neurons !== 176422 || message.connections !== 6287749) {
      throw new Error("Worker reported unexpected graph metadata");
    }
    ready = true;
    worker.postMessage({ type: "sense", state: { error: 0.8, velocity: 0.4, urgency: 0.7 } });
  }
  if (message.type === "tick") {
    // The worker intentionally emits one silent baseline tick immediately after
    // loading; wait for the stimulated tick requested above.
    if (ready && message.activeNeurons === 0 && message.spikes === 0) return;
    if (!ready || !Number.isFinite(message.probability) || message.activeNeurons <= 0 || message.spikes <= 0) {
      throw new Error("Worker tick did not contain live neural activity");
    }
    clearTimeout(timeout);
    console.log(JSON.stringify({
      probability: message.probability,
      activeNeurons: message.activeNeurons,
      spikes: message.spikes,
      computeMs: message.computeMs,
    }, null, 2));
    await worker.terminate();
  }
});

worker.on("error", (error) => {
  clearTimeout(timeout);
  throw error;
});
