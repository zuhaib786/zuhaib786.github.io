import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  LifNetwork,
  encodeFlappyVision,
  parseFlyb,
  readoutProbability,
  readoutVector,
  resolveFlappyPopulations,
} from "../public/scripts/malecns-engine.js";

const graph = await readFile(new URL("../public/data/malecns/malecns-v1.0.flyb.gz", import.meta.url));
const raw = gunzipSync(graph);
const c = parseFlyb(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const model = JSON.parse(await readFile(new URL("../public/data/malecns/flappy-readout-v1.json", import.meta.url), "utf8"));
const populations = resolveFlappyPopulations(c);

const DT = 0.05;
const FLY_X = 235;
const GAP = 206;
const SPEED = 170;
const GRAVITY = 650;
const IMPULSE = -305;

function gateHeight(index, seed) {
  return 165 + ((index * 137 + seed * 71) % 270);
}

for (let episode = 0; episode < 3; episode += 1) {
  const net = new LifNetwork(c, { dtMs: 1, gain: 0.65, seed: 20260903 + episode });
  let y = 300;
  let vy = 0;
  let score = 0;
  let cooldown = 0;
  let nextIndex = 0;
  const gates = [];
  for (let x = 720; x < 1500; x += 390) gates.push({ x, cy: gateHeight(nextIndex++, episode), passed: false });
  let ticks = 0;
  for (; ticks < 500; ticks += 1) {
    while (gates.at(-1).x < 1250) gates.push({ x: gates.at(-1).x + 390, cy: gateHeight(nextIndex++, episode), passed: false });
    const gate = gates.find((item) => item.x + 90 >= FLY_X);
    const distance = Math.max(0, gate.x - FLY_X);
    const state = {
      error: (y - gate.cy) / (GAP * 0.5),
      velocity: vy / 450,
      urgency: Math.max(0, Math.min(1, 1 - distance / 650)),
    };
    net.setStimuli(encodeFlappyVision(state, populations));
    net.runMs(50);
    const probability = readoutProbability(readoutVector(net, populations, 50), model.readout);
    net.clearWindow();
    cooldown -= DT;
    if (probability >= model.readout.threshold && cooldown <= 0) {
      vy = IMPULSE;
      cooldown = 0.17;
    }
    vy += GRAVITY * DT;
    y += vy * DT;
    for (const item of gates) {
      item.x -= SPEED * DT;
      if (!item.passed && item.x + 90 < FLY_X) { item.passed = true; score += 1; }
    }
    const hit = gates.some((item) => FLY_X + 15 > item.x && FLY_X - 15 < item.x + 90
      && (y - 13 < item.cy - GAP / 2 || y + 13 > item.cy + GAP / 2));
    if (y < 15 || y > 585 || hit) break;
  }
  console.log(`episode ${episode + 1}: ${score} gates, ${(ticks * DT).toFixed(1)} s`);
}
