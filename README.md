# GIF Generator

A browser-only MP4-to-GIF converter designed for GitHub Pages. Users can select a local MP4, preview it, crop, trim, compress, choose output width/FPS/loop count, and encode with either `ffmpeg.wasm` or Gifski WASM.

## Requirements

- Node.js `26.4.0`
- npm `11.17.0`

## Scripts

```bash
npm install
npm run dev
npm run build
npm run preview
```

The production build is emitted to `dist/` and can be published to GitHub Pages. The Vite config uses a relative base path (`./`) so the build can work from a repository subpath.

## Privacy

Video files are read by the browser from the local filesystem. They are not uploaded to a server by this app.
