// ------------------------------------------------------------------
//  Series registry
//
//  A "series" is a folder of related posts under src/content/series/.
//  This file is the single source of truth for which series exist and
//  whether they're published. To hide an entire series (and every post
//  inside it) from the whole site, set `draft: true` here — no per-post
//  edits needed.
// ------------------------------------------------------------------

export interface SeriesMeta {
  /** folder name under src/content/series/ and the URL segment */
  slug: string;
  title: string;
  description: string;
  /** sort order in listings */
  order: number;
  /** true = hidden everywhere: no nav, no index card, no built pages */
  draft: boolean;
}

export const allSeries: SeriesMeta[] = [
  {
    slug: "zig-learning",
    title: "Zig Learning",
    description:
      "Notes and small programs as I learn Zig — systems programming, the standard library, and its evolving I/O model.",
    order: 1,
    draft: false,
  },
  {
    slug: "gpu-mode",
    title: "GPU Mode",
    description:
      "Experiments in GPU programming and parallel kernels.",
    order: 2,
    draft: true,
  },
];

export const visibleSeries = allSeries
  .filter((s) => !s.draft)
  .sort((a, b) => a.order - b.order);

export function getSeriesMeta(slug: string): SeriesMeta | undefined {
  return allSeries.find((s) => s.slug === slug);
}

/** Returns true if a post (by its collection id, e.g. "zig-learning/io-in-zig")
 *  belongs to a published series and is itself not a draft. */
export function postIsVisible(id: string, postDraft: boolean): boolean {
  const meta = getSeriesMeta(id.split("/")[0]);
  return Boolean(meta && !meta.draft && !postDraft);
}
