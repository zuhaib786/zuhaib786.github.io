import type * as THREE from "three";

/** One selectable structure: geometry carries `partId`, this carries the text. */
export type Part = {
  id: string; name: string; system: string;
  description: string; role: string;
  kind: string; scale: string; note: string;
  color: string;
};

/** A stage of a process, keyed to normalised time along the timeline. */
export type Phase = { at: number; name: string; caption: string };

export type Built = {
  group: THREE.Group;
  /** Called every frame with the specimen clock (seconds) and frame delta. */
  update?: (time: number, delta: number) => void;
  /** Processes only: drive the whole animation from normalised progress. */
  seek?: (progress: number) => void;
  dispose?: () => void;
};

export type Category = "micro" | "anatomy" | "process";

export type Specimen = {
  id: string;
  name: string;
  subtitle: string;
  code: string;
  scale: string;
  aria: string;
  category: Category;
  /** Processes carry an ordered phase list; specimens leave this undefined. */
  phases?: Phase[];
  /** Seconds for one full pass of a process. */
  duration?: number;
  parts: Part[];
  build: () => Built;
};

/** Terse constructor so the specimen files stay readable as anatomy, not as data. */
export const part = (
  id: string, name: string, system: string, color: string,
  description: string, role: string, kind: string, scale: string, note: string,
): Part => ({ id, name, system, color, description, role, kind, scale, note });
