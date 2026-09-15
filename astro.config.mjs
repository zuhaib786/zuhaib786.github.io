// @ts-check
import { defineConfig } from "astro/config";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

// Code highlighting matches the editor these posts are written in: cyberdream
// with the custom teal-night palette from the Neovim config. Generated from
// cyberdream's own group mapping, with the `highlights` overrides applied --
// periwinkle types, cyan functions, mint keywords.
import cyberdreamDark from "./src/themes/cyberdream-teal-dark.json";
import cyberdreamLight from "./src/themes/cyberdream-teal-light.json";

export default defineConfig({
  site: "https://zuhaib786.github.io",
  trailingSlash: "never",
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
    shikiConfig: {
      themes: {
        light: cyberdreamLight,
        dark: cyberdreamDark,
      },
    },
  },
});
