/** Explicit cover choices, shared by content validation and presentation. */
export const artworkKinds = [
  "zig-memory", "api-boundaries", "storage-layers", "gpu-lanes",
  "camera-projection", "event-loop", "troubled-cells",
] as const;

export type ArtworkKind = (typeof artworkKinds)[number];

export const artworkDescriptions: Record<ArtworkKind, string> = {
  "zig-memory": "An allocator lends a region of memory to a program; defer returns it when the scope ends.",
  "api-boundaries": "A small fortress distinguishes entry from permission. A Parse sentry inspects a request document. An Authenticate guard checks a traveller's ID, opening a shared courtyard where visitors explore paths around a fountain and bench. A separate Authorize gate with a fingerprint and access-permit reader protects the inner keep's special areas. Being inside does not grant access to every room.",
  "storage-layers": "Writes pass through a write-ahead log and memory into sorted tables, which merge into larger storage layers.",
  "gpu-lanes": "A grid of parallel GPU threads, with one workgroup highlighted and connected to shared memory.",
  "camera-projection": "Rays from a calibration checkerboard pass through a virtual image plane and converge at a camera center.",
  "event-loop": "An event loop cycles between polling for I/O, queuing ready work, and running callbacks; CPU work occupies the callback stage.",
  "troubled-cells": "A discontinuity crosses a one-dimensional mesh. Only nearby cells are highlighted for limiting, with graph edges connecting neighboring cells.",
};
