import { amoeba } from "./specimens/amoeba";
import { animalCell } from "./specimens/animal-cell";
import { brain } from "./specimens/brain";
import { digestion } from "./specimens/digestion";
import { eye } from "./specimens/eye";
import { heart } from "./specimens/heart";
import { mitosis } from "./specimens/mitosis";
import { phagocytosis } from "./specimens/phagocytosis";
import { plantCell } from "./specimens/plant-cell";
import type { Category, Specimen } from "./types";

export const SPECIMENS: Specimen[] = [
  animalCell, plantCell, amoeba,
  heart, brain, eye,
  phagocytosis, mitosis, digestion,
];

export const BY_ID = new Map(SPECIMENS.map(s => [s.id, s]));

export const CATEGORIES: { id: Category; label: string; blurb: string }[] = [
  { id: "micro", label: "Microorganisms", blurb: "Cells and single-celled life" },
  { id: "anatomy", label: "Anatomy", blurb: "Organs, sectioned and whole" },
  { id: "process", label: "Phenomena", blurb: "Processes you can scrub through" },
];

export type { Built, Category, Part, Phase, Specimen } from "./types";
