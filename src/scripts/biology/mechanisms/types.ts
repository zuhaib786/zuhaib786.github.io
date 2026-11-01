import type * as THREE from 'three';

/** Colours the 2D panels draw with, resolved from the instrument's CSS. */
export type Ink = { ink: string; soft: string; faint: string; rule: string; accent: string; paper: string };

export type Readout = { label: string; unit: string; max: number; digits?: number };
export type Phase = { at: number; label: string };
export type View = {
  id: string; label: string; dir: [number, number, number]; zoom?: number;
  /** Rig groups dissected away while this view is active. */
  hide?: string[];
  /** Rig group to frame instead of the whole specimen. */
  focus?: string;
  note?: string;
};
export type Option = { id: string; label: string };
export type PartInfo = { id: string; name: string; role: string };

/** Everything the panels show for one instant of the mechanism. */
export type Frame = {
  status: string;
  detail: string;
  values: number[];
  /** Physiological clock for the timecode, already formatted. */
  clock: string;
};

export type Anchor = {
  label: string;
  object: THREE.Object3D;
  at: [number, number, number];
  /** Screen-space direction for the leader line. */
  side: [number, number];
  /** Only meaningful when the interior is exposed (section, x-ray, exploded). */
  inside?: boolean;
};

export type Rig = {
  root: THREE.Group;
  context?: THREE.Object3D;
  explode: { object: THREE.Object3D; offset: THREE.Vector3 }[];
  anchors: Anchor[];
  /** Section plane in the rig's local frame. */
  section: THREE.Plane;
  /** Drive every moving part from the single degree of freedom. */
  set(t: number, sequence: string): void;
  /** View directions that depend on the built geometry (e.g. a section plane). */
  viewDirs?: Record<string, THREE.Vector3>;
  /** Named groups a view may dissect away. */
  groups?: Record<string, THREE.Object3D>;
};

export type Study = {
  id: string;
  code: string;
  mark: string;
  eyebrow: string;
  title: string;
  /** Short name for the study switcher. */
  short: string;
  subtitle: string;
  tagline: string;
  figure: string;
  figureUnit: (sequence: string) => string;
  motto: [string, string, string];
  stateTitle: string;
  dynamicsTitle: string;
  operationTitle: string;
  overview: { heading: string; text: string; stats: [string, string][] };
  sequenceTitle: string;
  sequences: Option[];
  /** Display modes switched on when the study opens (default: labels). */
  defaultDisplay?: string[];
  views: View[];
  contextLabel: string;
  footer: [string, string];
  caption: string;
  readouts: Readout[];
  parts: PartInfo[];
  /** Seconds of playback per cycle at 1× (the real mechanism is far faster or slower). */
  playback: (sequence: string) => number;
  phases: (sequence: string) => Phase[];
  frame: (t: number, sequence: string) => Frame;
  schematic: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, sequence: string, ink: Ink) => void;
  plot: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, sequence: string, ink: Ink) => void;
  strip: { label: string; draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, sequence: string, ink: Ink) => void };
  build: () => Rig;
};
