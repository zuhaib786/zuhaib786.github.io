# zuhaib786.github.io

Personal portfolio and blog of Zuhaib Ul Zamann, built with [Astro](https://astro.build)
and deployed to GitHub Pages. The design is a "technical field manual" aesthetic —
monospace type (IBM Plex Mono), paper background, numbered sections.

**Live site:** https://zuhaib786.github.io

## Local development

```bash
npm install        # once
npm run dev        # dev server at http://localhost:4321 with live reload
npm run build      # production build into dist/
npm run preview    # serve the production build locally
```

## How publishing works

The site is fully static. Pushing to `main` triggers `.github/workflows/deploy.yml`,
which builds the site with Astro and deploys it to GitHub Pages. No manual build
step needed — just commit and push. (Repo Settings → Pages → Source must be set to
**GitHub Actions**.)

## Adding a new article

Create a markdown file in `src/content/blog/`. The filename becomes the URL
(`my-article.md` → `/blog/my-article`).

```markdown
---
title: "My New Article"
description: "One-line summary shown in listings and under the title."
date: 2026-06-10
tags: ["Python", "Performance"]   # optional
draft: false                       # optional; true hides it from the site
---

Article body in plain markdown...
```

That's it. The article automatically appears on the homepage and `/blog`,
numbered by date. Notes on what's supported in the body:

- **Code blocks** — fenced blocks with a language get syntax highlighting:
  ` ```python ... ``` `
- **Math** — KaTeX is enabled. Inline math with `$x = y$`, display math with
  `$$` fences **on their own lines**:

  ```
  $$
  x = \frac{X}{Z}f
  $$
  ```

- **Images** — put the file in `public/images/` and reference it as
  `![Caption](/images/my-image.jpg)`. Images render framed like manual figures.
- **Section numbering** — `##` and `###` headings are automatically numbered
  (01, 1.1, …) by CSS. Don't number them manually.

Preview drafts locally: the dev server hides `draft: true` content too, so flip
the flag to check it, or just build with the flag off and don't push.

## Adding study notes

Same idea, in `src/content/notes/`. Notes are grouped by `topic` and ordered by
`order` (not date), so chapters stay in sequence:

```markdown
---
title: "Chapter 3: Storage and Retrieval"
description: "Short notes on Chapter 3 of Designing Data-Intensive Applications"
date: 2026-06-10
topic: "Designing Data-Intensive Applications"
order: 3
draft: true
---
```

A new `topic` value automatically creates a new group on the `/notes` page.

## Editing other pages

| What | Where |
| --- | --- |
| Homepage intro / hero text | `src/pages/index.astro` |
| Projects | `src/pages/projects.astro` (edit the `projects` array at the top) |
| Résumé | `src/pages/resume.astro` (edit the `experience`/`skills` arrays at the top) |
| Nav links | `src/components/Header.astro` |
| Footer / social links | `src/components/Footer.astro` |
| Colors, fonts, spacing | `src/styles/global.css` (design tokens in `:root`) |
| Frontmatter schema | `src/content.config.ts` |

## Project structure

```
src/
├── content/
│   ├── blog/          ← articles (markdown)
│   └── notes/         ← study notes (markdown)
├── content.config.ts  ← frontmatter schemas
├── layouts/
│   ├── Base.astro     ← <head>, header, footer wrapper
│   └── Article.astro  ← article masthead + prose styling wrapper
├── components/        ← header, footer, list rows
├── pages/             ← one file per route
└── styles/global.css  ← design system
public/                ← static assets served as-is (images, favicon)
.github/workflows/deploy.yml  ← build + deploy on push to main
```
