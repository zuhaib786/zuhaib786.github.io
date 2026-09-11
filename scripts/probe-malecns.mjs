import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { LifNetwork, parseFlyb, resolvePopulation } from "../public/scripts/malecns-engine.js";

const compressed = await readFile(new URL("../public/data/malecns/malecns-v1.0.flyb.gz", import.meta.url));
const raw = gunzipSync(compressed);
const c = parseFlyb(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const populations = Object.fromEntries([
  "prefix:LC4", "prefix:LPLC2", "prefix:HS", "prefix:VS",
  "DNp01", "DNp04", "DNp11", "prefix:DNg02", "DNg13/L", "DNg13/R",
  "DNa02/L", "DNa02/R", "DNp03/L", "DNp03/R", "subclass:wm",
].map((spec) => [spec, resolvePopulation(c, spec)]));

const net = new LifNetwork(c, { dtMs: 1, seed: 20260903 });
const windows = [
  ["quiet", 0, 0, 0, 0],
  ["LC4", 150, 0, 0, 0],
  ["LPLC2", 0, 150, 0, 0],
  ["HS", 0, 0, 150, 0],
  ["VS", 0, 0, 0, 150],
  ["LC4", 150, 0, 0, 0],
  ["LPLC2", 0, 150, 0, 0],
];

for (const [label, lc4, lplc2, hs, vs] of windows) {
  net.setStimuli([
    { neurons: populations["prefix:LC4"], hz: lc4 },
    { neurons: populations["prefix:LPLC2"], hz: lplc2 },
    { neurons: populations["prefix:HS"], hz: hs },
    { neurons: populations["prefix:VS"], hz: vs },
  ]);
  const start = performance.now();
  net.runMs(50);
  const elapsed = performance.now() - start;
  const rates = {};
  for (const [name, population] of Object.entries(populations)) {
    if (!name.startsWith("prefix:LC") && !name.startsWith("prefix:LP") && !name.startsWith("prefix:HS") && !name.startsWith("prefix:VS")) {
      rates[name] = Number(net.populationRate(population, 50).toFixed(1));
    }
  }
  console.log(label, `${elapsed.toFixed(1)} ms compute`, `${net.activeCount} active`, rates);
  net.clearWindow();
}
