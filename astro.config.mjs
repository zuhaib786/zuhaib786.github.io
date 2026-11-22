// @ts-check
import { defineConfig } from "astro/config";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

// Code highlighting matches the editor these posts are written in. Dark is
// cyberdream with the custom teal-night palette from the Neovim config,
// generated from cyberdream's own group mapping with the `highlights`
// overrides applied -- periwinkle types, cyan functions, mint keywords.
// Light is dayfox (nightfox.nvim), generated from nightfox's syntax spec and
// tree-sitter links with its default styles (no italics).
import cyberdreamDark from "./src/themes/cyberdream-teal-dark.json";
import dayfoxLight from "./src/themes/dayfox-light.json";

export default defineConfig({
  site: "https://zuhaib786.github.io",
  trailingSlash: "never",
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
    shikiConfig: {
      themes: {
        light: dayfoxLight,
        dark: cyberdreamDark,
      },
    },
  },
});
