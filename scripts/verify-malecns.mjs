import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  bodyIdAt,
  parseFlyb,
  resolvePopulation,
} from "../public/scripts/malecns-engine.js";

const expectedSha256 = "e33df182bed7a6f3ea279daf4790a82b05706d3d41e819a6a80c0473e8c559f3";
const filename = new URL("../public/data/malecns/malecns-v1.0.flyb.gz", import.meta.url);
const compressed = await readFile(filename);
const actualSha256 = createHash("sha256").update(compressed).digest("hex");
if (actualSha256 !== expectedSha256) throw new Error(`SHA-256 mismatch: ${actualSha256}`);

const raw = gunzipSync(compressed);
const c = parseFlyb(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
if (c.dataset !== "male-cns:v1.0" || c.n !== 176422 || c.nEdges !== 6287749) {
  throw new Error(`Unexpected connectome: ${c.dataset}, ${c.n} neurons, ${c.nEdges} edges`);
}

const specs = [
  "prefix:LC4",
  "prefix:LPLC2",
  "prefix:HS",
  "prefix:VS",
  "DNp01",
  "DNp04",
  "prefix:DNg02",
  "DNg13/L",
  "DNg13/R",
  "subclass:wm",
];
const populations = Object.fromEntries(specs.map((spec) => [spec, resolvePopulation(c, spec)]));
const dng13Left = populations["DNg13/L"];
const dng13Right = populations["DNg13/R"];

console.log(JSON.stringify({
  dataset: c.dataset,
  neurons: c.n,
  connections: c.nEdges,
  retinaEntries: c.nRetina,
  sha256: actualSha256,
  populations: Object.fromEntries(specs.map((spec) => [spec, populations[spec].length])),
  dng13BodyIds: {
    left: dng13Left.length ? bodyIdAt(c, dng13Left[0]) : null,
    right: dng13Right.length ? bodyIdAt(c, dng13Right[0]) : null,
  },
}, null, 2));
