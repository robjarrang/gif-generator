# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

`gif-generator` is a browser-only MP4-to-GIF converter designed to be hosted on GitHub Pages. Users select a local MP4 file, preview it, crop, trim, compress, choose output width/FPS/loop count, and encode with either `ffmpeg.wasm` or Gifski WASM. All processing happens client-side in the browser — no files are ever uploaded to a server.

## Tech stack

- React + TypeScript
- Vite (build tool, config in [vite.config.ts](vite.config.ts))
- `@ffmpeg/ffmpeg` / `@ffmpeg/util` and `gifski-wasm` for encoding
- `lucide-react` for icons

## Requirements

- Node.js `26.4.0`
- npm `11.17.0`

## Common commands

```bash
npm install       # install dependencies
npm run dev        # start local dev server (0.0.0.0)
npm run build       # type-check (tsc -b) then build to dist/
npm run preview      # preview the production build
```

There is currently no automated test suite or linter configured. Always run `npm run build` after making changes to confirm the project still type-checks and builds.

## Project structure

- [index.html](index.html) — Vite entry HTML
- [src/main.tsx](src/main.tsx) — React app entry point
- [src/styles.css](src/styles.css) — global styles
- [vite.config.ts](vite.config.ts) — Vite config; uses a relative base path (`./`) so the build works from a GitHub Pages subpath, and excludes the WASM packages from dependency pre-bundling
- [tsconfig.json](tsconfig.json) — TypeScript config

## Conventions & constraints

- This is a client-only, static-hosted app. Do not introduce a backend/server component or any code that uploads user video files off the device.
- Keep the Vite `base: './'` setting intact so builds continue to work when published under a repository subpath on GitHub Pages.
- Encoding-related work (`ffmpeg.wasm`, `gifski-wasm`) can be heavy; prefer running it off the main thread (workers) where practical, consistent with the existing `worker: { format: 'es' }` Vite setting.
- Use `latest` version ranges as already set in [package.json](package.json) unless there's a specific reason to pin a version.
- After adding dependencies or changing build-affecting config, run `npm run build` to verify.
