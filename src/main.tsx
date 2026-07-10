import React, { ChangeEvent, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import encodeGifski from 'gifski-wasm';
import { Download, Film, Scissors, Settings, Sparkles } from 'lucide-react';
import './styles.css';

type Encoder = 'ffmpeg' | 'gifski';
type Crop = { x: number; y: number; width: number; height: number };

type VideoMeta = { duration: number; width: number; height: number };

const DEFAULTS = { fps: 10, outputWidth: 800, loop: 0, quality: 80 };

const LOG_PREFIX = '[gif-generator]';

function logInfo(message: string, details?: unknown) {
  if (details !== undefined) {
    console.log(`${LOG_PREFIX} ${message}`, details);
  } else {
    console.log(`${LOG_PREFIX} ${message}`);
  }
}

function logError(stage: string, error: unknown, context?: Record<string, unknown>) {
  console.groupCollapsed(`${LOG_PREFIX} Error during: ${stage}`);
  console.error(error);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  if (context) {
    console.error('Context:', context);
  }
  console.groupEnd();
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function useObjectUrl(file: File | null) {
  return useMemo(() => (file ? URL.createObjectURL(file) : ''), [file]);
}

function gifBlobPart(data: string | Uint8Array): BlobPart {
  if (typeof data === 'string') return data;
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

async function loadFfmpeg(onLog: (message: string) => void) {
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    console.log(`${LOG_PREFIX} [ffmpeg]`, message);
    onLog(message);
  });
  ffmpeg.on('progress', ({ progress, time }) => {
    console.log(`${LOG_PREFIX} [ffmpeg progress]`, { progress, time });
  });

  // Vite bundles the ffmpeg worker as an ES module (see `worker: { format: 'es' }` in
  // vite.config.ts), so `importScripts()` is unavailable inside it and ffmpeg.wasm falls
  // back to a dynamic `import()` of the core script. That only works with the ESM build
  // of ffmpeg-core (which has a `default` export) — the UMD build fails silently there.
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';

  let coreURL: string;
  let wasmURL: string;
  try {
    logInfo('Fetching ffmpeg core JS', `${baseURL}/ffmpeg-core.js`);
    coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
    logInfo('Fetching ffmpeg core wasm', `${baseURL}/ffmpeg-core.wasm`);
    wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
  } catch (error) {
    logError('fetching ffmpeg core assets', error, { baseURL });
    throw new Error(`Failed to download ffmpeg core assets from ${baseURL}: ${describeError(error)}`);
  }

  try {
    logInfo('Loading ffmpeg core into worker…');
    await ffmpeg.load({ coreURL, wasmURL });
    logInfo('ffmpeg core loaded successfully.');
  } catch (error) {
    logError('ffmpeg.load()', error, { baseURL });
    throw new Error(`Failed to initialize ffmpeg.wasm: ${describeError(error)}`);
  }

  return ffmpeg;
}

async function seek(video: HTMLVideoElement, time: number) {
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', () => reject(new Error('Unable to seek video')), { once: true });
    video.currentTime = time;
  });
}

async function framesFromVideo(video: HTMLVideoElement, crop: Crop, start: number, end: number, fps: number, outputWidth: number) {
  const ratio = outputWidth / crop.width;
  const outWidth = Math.round(outputWidth);
  const outHeight = Math.max(1, Math.round(crop.height * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available in this browser.');

  const total = Math.max(1, Math.floor((end - start) * fps));
  const frames: ImageData[] = [];
  for (let i = 0; i < total; i += 1) {
    await seek(video, start + i / fps);
    ctx.clearRect(0, 0, outWidth, outHeight);
    ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, outWidth, outHeight);
    frames.push(ctx.getImageData(0, 0, outWidth, outHeight));
  }
  return { frames, width: outWidth, height: outHeight };
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, width: 0, height: 0 });
  const [fps, setFps] = useState(DEFAULTS.fps);
  const [outputWidth, setOutputWidth] = useState(DEFAULTS.outputWidth);
  const [loop, setLoop] = useState(DEFAULTS.loop);
  const [quality, setQuality] = useState(DEFAULTS.quality);
  const [encoder, setEncoder] = useState<Encoder>('ffmpeg');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Choose a local MP4 to begin.');
  const [gifUrl, setGifUrl] = useState('');
  const [gifSize, setGifSize] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const url = useObjectUrl(file);

  const outputHeight = meta && crop.width ? Math.round((crop.height / crop.width) * outputWidth) : 0;

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0] ?? null;
    setFile(next);
    setGifUrl('');
    setGifSize(0);
    setMeta(null);
    setStatus(next ? 'Loading video metadata…' : 'Choose a local MP4 to begin.');
  }

  function onLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    const next = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    setMeta(next);
    setEnd(Number(video.duration.toFixed(2)));
    setCrop({ x: 0, y: 0, width: next.width, height: next.height });
    setStatus('Ready. Adjust crop, trim, compression, and encoder options.');
  }

  function updateCrop(key: keyof Crop, value: number) {
    if (!meta) return;
    setCrop((current) => {
      const next = { ...current, [key]: value };
      next.x = clamp(Math.round(next.x), 0, meta.width - 1);
      next.y = clamp(Math.round(next.y), 0, meta.height - 1);
      next.width = clamp(Math.round(next.width), 1, meta.width - next.x);
      next.height = clamp(Math.round(next.height), 1, meta.height - next.y);
      return next;
    });
  }

  async function convert() {
    if (!file || !meta || !videoRef.current) return;
    setBusy(true);
    setGifUrl('');
    console.groupCollapsed(`${LOG_PREFIX} Starting conversion`);
    logInfo('Parameters', {
      file: { name: file.name, size: file.size, type: file.type },
      meta,
      start,
      end,
      crop,
      fps,
      outputWidth,
      loop,
      quality,
      encoder,
    });
    console.groupEnd();

    let stage = 'setup';
    try {
      const safeStart = clamp(start, 0, meta.duration);
      const safeEnd = clamp(end, safeStart + 0.1, meta.duration);
      const safeFps = clamp(fps, 1, 30);
      const safeWidth = clamp(outputWidth, 64, 1200);
      const safeLoop = Math.max(0, Math.round(loop));

      if (encoder === 'ffmpeg') {
        stage = 'loading ffmpeg.wasm';
        setStatus('Loading ffmpeg.wasm…');
        const ffmpeg = await loadFfmpeg((message) => setStatus(message));

        stage = 'writing input file to ffmpeg FS';
        logInfo(stage);
        await ffmpeg.writeFile('input.mp4', await fetchFile(file));

        const colors = Math.round(clamp(quality, 1, 100) * 2.55);
        const filter = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},fps=${safeFps},scale=${safeWidth}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${colors}[p];[s1][p]paletteuse=dither=bayer`;
        const args = ['-ss', String(safeStart), '-t', String(safeEnd - safeStart), '-i', 'input.mp4', '-vf', filter, '-loop', String(safeLoop), 'output.gif'];

        stage = 'running ffmpeg.exec()';
        logInfo(stage, { args });
        setStatus('Encoding with ffmpeg…');
        const exitCode = await ffmpeg.exec(args);
        logInfo('ffmpeg.exec() finished', { exitCode });
        if (exitCode !== 0) {
          throw new Error(`ffmpeg exited with non-zero code ${exitCode}. Check console logs above for [ffmpeg] output.`);
        }

        stage = 'reading output.gif from ffmpeg FS';
        const data = await ffmpeg.readFile('output.gif');
        logInfo(stage, { bytes: data.length });

        const blob = new Blob([gifBlobPart(data)], { type: 'image/gif' });
        setGifUrl(URL.createObjectURL(blob));
        setGifSize(blob.size);
        setStatus('GIF ready.');
        logInfo('Conversion complete', { size: blob.size });
      } else {
        stage = 'extracting frames from video';
        setStatus('Extracting frames for Gifski…');
        const { frames, width, height } = await framesFromVideo(videoRef.current, crop, safeStart, safeEnd, safeFps, safeWidth);
        logInfo(stage, { frameCount: frames.length, width, height });

        stage = 'encoding with gifski';
        setStatus(`Encoding ${frames.length} frames with Gifski…`);
        const data = await encodeGifski({ frames, width, height, fps: safeFps, quality: clamp(quality, 1, 100), repeat: safeLoop });
        logInfo('gifski encoding finished', { bytes: data.length });

        const blob = new Blob([gifBlobPart(data)], { type: 'image/gif' });
        setGifUrl(URL.createObjectURL(blob));
        setGifSize(blob.size);
        setStatus('GIF ready.');
        logInfo('Conversion complete', { size: blob.size });
      }
    } catch (error) {
      logError(stage, error, { encoder, crop, start, end, fps, outputWidth, quality, loop });
      setStatus(`Conversion failed at "${stage}": ${describeError(error)} (see browser console for details)`);
    } finally {
      setBusy(false);
    }
  }

  return <main className="shell">
    <section className="hero"><div><p className="eyebrow"><Sparkles size={16}/> Browser MP4 → GIF</p><h1>Local video to shareable GIF, ready for GitHub Pages.</h1><p>Everything runs in the visitor’s browser; uploaded MP4 files stay on their machine.</p></div><label className="upload"><Film/> <span>{file ? file.name : 'Choose MP4 video'}</span><input type="file" accept="video/mp4,video/*" onChange={onFile}/></label></section>

    <section className="grid">
      <div className="card preview"><h2>Preview</h2>{url ? <video ref={videoRef} src={url} controls onLoadedMetadata={onLoadedMetadata}/> : <div className="empty">Drop in an MP4 from your desktop or file system.</div>}{meta && <p className="muted">Source: {meta.width}×{meta.height}, {meta.duration.toFixed(2)}s</p>}</div>
      <div className="card"><h2><Settings size={20}/> Output controls</h2>
        <div className="row"><label>Encoder<select value={encoder} onChange={(e) => setEncoder(e.target.value as Encoder)}><option value="ffmpeg">ffmpeg.wasm</option><option value="gifski">Gifski WASM</option></select></label><label>FPS<input type="number" min="1" max="30" value={fps} onChange={(e)=>setFps(Number(e.target.value))}/></label></div>
        <div className="row"><label>Output width<input type="number" min="64" max="1200" step="10" value={outputWidth} onChange={(e)=>setOutputWidth(Number(e.target.value))}/></label><label>Loop count<input type="number" min="0" value={loop} onChange={(e)=>setLoop(Number(e.target.value))}/><small>0 loops forever</small></label></div>
        <label>Compression / quality ({quality})<input type="range" min="1" max="100" value={quality} onChange={(e)=>setQuality(Number(e.target.value))}/><small>Lower values produce smaller files; higher values preserve more color detail.</small></label>
        {outputHeight > 0 && <p className="pill">Output: {outputWidth}×{outputHeight}px</p>}
      </div>
    </section>

    <section className="card"><h2><Scissors size={20}/> Crop and trim</h2>
      <div className="row"><label>Start seconds<input type="number" min="0" max={meta?.duration ?? 0} step="0.1" value={start} onChange={(e)=>setStart(Number(e.target.value))}/></label><label>Finish seconds<input type="number" min="0" max={meta?.duration ?? 0} step="0.1" value={end} onChange={(e)=>setEnd(Number(e.target.value))}/></label></div>
      <div className="row four">{(['x','y','width','height'] as const).map((key)=><label key={key}>Crop {key}<input type="number" min="0" value={crop[key]} onChange={(e)=>updateCrop(key, Number(e.target.value))}/></label>)}</div>
      <button disabled={!file || busy || !meta} onClick={convert}>{busy ? 'Converting…' : 'Create GIF'}</button><p className="status">{status}</p>
    </section>

    {gifUrl && <section className="card result"><h2>Result</h2><img src={gifUrl} alt="Generated GIF"/><p>{formatBytes(gifSize)}</p><a className="download" href={gifUrl} download="converted.gif"><Download size={18}/> Download GIF</a></section>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
