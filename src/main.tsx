import React, {
  ChangeEvent,
  DragEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import encodeGifski from 'gifski-wasm';
import {
  Crop as CropIcon,
  Download,
  Film,
  Gauge,
  Moon,
  Repeat,
  Scissors,
  ShieldCheck,
  Sliders,
  Sparkles,
  Sun,
  UploadCloud,
  Wand2,
} from 'lucide-react';
import './styles.css';

type Theme = 'light' | 'dark';

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

function formatTime(seconds: number) {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  return minutes > 0 ? `${minutes}:${rest.toFixed(1).padStart(4, '0')}` : `${rest.toFixed(1)}s`;
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

type CropToolProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  meta: VideoMeta;
  crop: Crop;
  editing: boolean;
  onChange: (crop: Crop) => void;
};

type CropDragMode = 'move' | 'new' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

type CropDragState = {
  mode: CropDragMode;
  startX: number;
  startY: number;
  orig: Crop;
  rect: DOMRect;
  anchorX: number;
  anchorY: number;
};

const CROP_HANDLES: CropDragMode[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// Interactive drag-to-crop overlay. It measures the video's rendered box so the
// selection maps precisely between on-screen pixels and source-video pixels.
function CropTool({ videoRef, meta, crop, editing, onChange }: CropToolProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<CropDragState | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const measure = () => {
      const stage = video.parentElement;
      if (!stage) return;
      const vr = video.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      setBox({ left: vr.left - sr.left, top: vr.top - sr.top, width: vr.width, height: vr.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [videoRef, meta]);

  if (!box) return null;

  const sel = {
    left: (crop.x / meta.width) * box.width,
    top: (crop.y / meta.height) * box.height,
    width: (crop.width / meta.width) * box.width,
    height: (crop.height / meta.height) * box.height,
  };

  const lp = (sel.left / box.width) * 100;
  const tp = (sel.top / box.height) * 100;
  const rp = ((sel.left + sel.width) / box.width) * 100;
  const bp = ((sel.top + sel.height) / box.height) * 100;
  const holeClip = `polygon(0% 0%, 0% 100%, ${lp}% 100%, ${lp}% ${tp}%, ${rp}% ${tp}%, ${rp}% ${bp}%, ${lp}% ${bp}%, ${lp}% 100%, 100% 100%, 100% 0%)`;

  function begin(event: React.PointerEvent, mode: CropDragMode) {
    const video = videoRef.current;
    if (!video) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = video.getBoundingClientRect();
    const scaleX = meta.width / rect.width;
    const scaleY = meta.height / rect.height;
    drag.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      orig: { ...crop },
      rect,
      anchorX: clamp((event.clientX - rect.left) * scaleX, 0, meta.width),
      anchorY: clamp((event.clientY - rect.top) * scaleY, 0, meta.height),
    };
    layerRef.current?.setPointerCapture(event.pointerId);
  }

  function move(event: React.PointerEvent) {
    const state = drag.current;
    if (!state) return;
    const { mode, startX, startY, orig, rect, anchorX, anchorY } = state;
    const scaleX = meta.width / rect.width;
    const scaleY = meta.height / rect.height;
    const dx = (event.clientX - startX) * scaleX;
    const dy = (event.clientY - startY) * scaleY;
    let next: Crop = { ...orig };

    if (mode === 'new') {
      const cx = clamp((event.clientX - rect.left) * scaleX, 0, meta.width);
      const cy = clamp((event.clientY - rect.top) * scaleY, 0, meta.height);
      next = {
        x: Math.min(anchorX, cx),
        y: Math.min(anchorY, cy),
        width: Math.abs(cx - anchorX),
        height: Math.abs(cy - anchorY),
      };
    } else if (mode === 'move') {
      next.x = orig.x + dx;
      next.y = orig.y + dy;
    } else {
      if (mode.includes('e')) next.width = orig.width + dx;
      if (mode.includes('s')) next.height = orig.height + dy;
      if (mode.includes('w')) {
        next.x = orig.x + dx;
        next.width = orig.width - dx;
      }
      if (mode.includes('n')) {
        next.y = orig.y + dy;
        next.height = orig.height - dy;
      }
    }
    onChange(next);
  }

  function end(event: React.PointerEvent) {
    if (!drag.current) return;
    drag.current = null;
    layerRef.current?.releasePointerCapture(event.pointerId);
  }

  return (
    <div
      ref={layerRef}
      className={editing ? 'crop-layer is-editing' : 'crop-layer'}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={(event) => begin(event, 'new')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {editing && <div className="crop-shade" style={{ clipPath: holeClip }} />}
      <div
        className="crop-box"
        style={{ left: sel.left, top: sel.top, width: sel.width, height: sel.height }}
        onPointerDown={(event) => begin(event, 'move')}
      >
        {CROP_HANDLES.map((dir) => (
          <span
            key={dir}
            className={`crop-handle h-${dir}`}
            onPointerDown={(event) => begin(event, dir)}
          />
        ))}
      </div>
    </div>
  );
}

type TrimToolProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  duration: number;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
};

// Visual drag-to-trim timeline. Two handles set the range; clicking the track
// scrubs the preview, and a playhead reflects the video's current time.
function TrimTool({ videoRef, duration, start, end, onChange }: TrimToolProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<'start' | 'end' | null>(null);
  const [playhead, setPlayhead] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setPlayhead(video.currentTime);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeked', onTime);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeked', onTime);
    };
  }, [videoRef]);

  const pct = (t: number) => (duration > 0 ? clamp((t / duration) * 100, 0, 100) : 0);

  function timeAt(clientX: number) {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1) * duration;
  }

  function beginHandle(event: React.PointerEvent, which: 'start' | 'end') {
    event.preventDefault();
    event.stopPropagation();
    drag.current = which;
    trackRef.current?.setPointerCapture(event.pointerId);
  }

  function moveHandle(event: React.PointerEvent) {
    if (!drag.current) return;
    const t = timeAt(event.clientX);
    if (drag.current === 'start') onChange(Math.min(t, end - 0.1), end);
    else onChange(start, Math.max(t, start + 0.1));
  }

  function endHandle(event: React.PointerEvent) {
    if (!drag.current) return;
    drag.current = null;
    trackRef.current?.releasePointerCapture(event.pointerId);
  }

  function seek(event: React.PointerEvent) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clamp(timeAt(event.clientX), 0, duration);
    setPlayhead(video.currentTime);
  }

  const leftPct = pct(start);
  const rightPct = pct(end);

  return (
    <div className="trim">
      <div
        className="trim-track"
        ref={trackRef}
        onPointerDown={seek}
        onPointerMove={moveHandle}
        onPointerUp={endHandle}
        onPointerCancel={endHandle}
      >
        <div className="trim-shade" style={{ left: 0, width: `${leftPct}%` }} />
        <div className="trim-shade" style={{ right: 0, width: `${100 - rightPct}%` }} />
        <div className="trim-range" style={{ left: `${leftPct}%`, width: `${rightPct - leftPct}%` }} />
        <div className="trim-playhead" style={{ left: `${pct(playhead)}%` }} />
        <div
          className="trim-handle"
          style={{ left: `${leftPct}%` }}
          role="slider"
          aria-label="Trim start"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={start}
          onPointerDown={(event) => beginHandle(event, 'start')}
        />
        <div
          className="trim-handle"
          style={{ left: `${rightPct}%` }}
          role="slider"
          aria-label="Trim end"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={end}
          onPointerDown={(event) => beginHandle(event, 'end')}
        />
      </div>
      <div className="trim-scale">
        <span>{formatTime(start)}</span>
        <span className="trim-selected">{formatTime(Math.max(0, end - start))} selected</span>
        <span>{formatTime(end)}</span>
      </div>
    </div>
  );
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
  const [isError, setIsError] = useState(false);
  const [gifUrl, setGifUrl] = useState('');
  const [gifSize, setGifSize] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [cropEditing, setCropEditing] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const url = useObjectUrl(file);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const outputHeight = meta && crop.width ? Math.round((crop.height / crop.width) * outputWidth) : 0;
  const isCropped = Boolean(
    meta && (crop.x > 0 || crop.y > 0 || crop.width < meta.width || crop.height < meta.height),
  );

  function applyFile(next: File | null) {
    setFile(next);
    setGifUrl('');
    setGifSize(0);
    setMeta(null);
    setIsError(false);
    setStatus(next ? 'Loading video metadata…' : 'Choose a local MP4 to begin.');
  }

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    applyFile(event.target.files?.[0] ?? null);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped && dropped.type.startsWith('video/')) applyFile(dropped);
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

  function commitCrop(next: Crop) {
    if (!meta) return;
    const x = clamp(Math.round(next.x), 0, meta.width - 1);
    const y = clamp(Math.round(next.y), 0, meta.height - 1);
    const width = clamp(Math.round(next.width), 1, meta.width - x);
    const height = clamp(Math.round(next.height), 1, meta.height - y);
    setCrop({ x, y, width, height });
  }

  function resetCrop() {
    if (!meta) return;
    setCrop({ x: 0, y: 0, width: meta.width, height: meta.height });
  }

  function commitTrim(nextStart: number, nextEnd: number) {
    if (!meta) return;
    const s = clamp(Number(nextStart.toFixed(2)), 0, meta.duration);
    const e = clamp(Number(nextEnd.toFixed(2)), s + 0.1, meta.duration);
    setStart(s);
    setEnd(e);
  }

  async function convert() {
    if (!file || !meta || !videoRef.current) return;
    setBusy(true);
    setIsError(false);
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
      setIsError(true);
      setStatus(`Conversion failed at "${stage}": ${describeError(error)} (see browser console for details)`);
    } finally {
      setBusy(false);
    }
  }

  const canConvert = Boolean(file && meta && !busy);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Film size={20} />
          </span>
          <span>GIF Studio</span>
        </div>
        <div className="topbar-actions">
          <span className="badge">
            <ShieldCheck size={15} /> 100% on-device
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">
            <Sparkles size={16} /> Browser MP4 → GIF
          </p>
          <h1>Turn any local video into a shareable GIF.</h1>
          <p className="lede">
            Crop, trim, and compress with ffmpeg or Gifski — entirely in your browser.
            Your files never leave your device.
          </p>
        </div>
        <label
          className={dragging ? 'dropzone is-dragging' : 'dropzone'}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <span className="dropzone-icon">
            <UploadCloud size={26} />
          </span>
          <span className="dropzone-title">{file ? file.name : 'Choose or drop an MP4'}</span>
          <span className="dropzone-hint">MP4 · processed locally, never uploaded</span>
          <input type="file" accept="video/mp4,video/*" onChange={onFile} />
        </label>
      </section>

      <div className="bento">
        <section className="panel panel--preview">
          <div className="panel-head">
            <Film size={18} />
            <h2>Preview</h2>
          </div>
          {url ? (
            <div className="preview-stage">
              <video
                ref={videoRef}
                className="media"
                src={url}
                controls
                onLoadedMetadata={onLoadedMetadata}
              />
              {meta && (
                <CropTool
                  videoRef={videoRef}
                  meta={meta}
                  crop={crop}
                  editing={cropEditing}
                  onChange={commitCrop}
                />
              )}
            </div>
          ) : (
            <div className="empty">
              <UploadCloud size={28} />
              Drop in an MP4 from your desktop or file system.
            </div>
          )}
          {meta && (
            <div className="crop-bar">
              <button
                type="button"
                className={cropEditing ? 'btn btn--sm' : 'btn btn--ghost btn--sm'}
                onClick={() => setCropEditing((v) => !v)}
              >
                <CropIcon size={15} /> {cropEditing ? 'Done' : 'Adjust crop'}
              </button>
              <div className="crop-bar-meta">
                {cropEditing && <span className="hint">Drag the frame or its handles</span>}
                <span className="chip">
                  Crop {crop.width}×{crop.height}
                </span>
                {isCropped && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={resetCrop}>
                    Reset
                  </button>
                )}
              </div>
            </div>
          )}
          {meta && (
            <div className="meta-line">
              <span className="chip">
                Source {meta.width}×{meta.height}px
              </span>
              <span className="chip">{meta.duration.toFixed(2)}s</span>
            </div>
          )}
        </section>

        <section className="panel panel--controls">
          <div className="panel-head">
            <Sliders size={18} />
            <h2>Output</h2>
          </div>

          <div className="field" style={{ marginBottom: 16 }}>
            <span className="field-label">Encoder</span>
            <div className="segmented" role="group" aria-label="Encoder">
              <button
                type="button"
                aria-pressed={encoder === 'ffmpeg'}
                onClick={() => setEncoder('ffmpeg')}
              >
                ffmpeg.wasm
              </button>
              <button
                type="button"
                aria-pressed={encoder === 'gifski'}
                onClick={() => setEncoder('gifski')}
              >
                Gifski
              </button>
            </div>
          </div>

          <div className="field-grid" style={{ marginBottom: 16 }}>
            <label className="field">
              <span className="field-label">
                <span>FPS</span>
                <Gauge size={14} color="var(--text-faint)" />
              </span>
              <input
                type="number"
                min="1"
                max="30"
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field-label">Output width</span>
              <input
                type="number"
                min="64"
                max="1200"
                step="10"
                value={outputWidth}
                onChange={(e) => setOutputWidth(Number(e.target.value))}
              />
              <span className="hint">Final GIF width. Height follows the crop.</span>
            </label>
          </div>

          <label className="field" style={{ marginBottom: 16 }}>
            <span className="field-label">
              <span>
                <Repeat size={14} color="var(--text-faint)" /> Loop count
              </span>
            </span>
            <input
              type="number"
              min="0"
              value={loop}
              onChange={(e) => setLoop(Number(e.target.value))}
            />
            <span className="hint">0 loops forever.</span>
          </label>

          <label className="field">
            <span className="field-label">
              <span>Quality</span>
              <span className="value">{quality}</span>
            </span>
            <input
              type="range"
              min="1"
              max="100"
              value={quality}
              onChange={(e) => setQuality(Number(e.target.value))}
            />
            <span className="hint">
              Lower values produce smaller files; higher values preserve more color detail.
            </span>
          </label>

          {outputHeight > 0 && (
            <p className="summary-pill">
              <Wand2 size={15} /> Final GIF {outputWidth}×{outputHeight}px
            </p>
          )}
        </section>

        <section className="panel panel--crop">
          <div className="panel-head">
            <Scissors size={18} />
            <h2>Trim</h2>
          </div>

          {meta && (
            <TrimTool
              videoRef={videoRef}
              duration={meta.duration}
              start={start}
              end={end}
              onChange={commitTrim}
            />
          )}

          <div className="field-grid" style={{ marginBottom: 16 }}>
            <label className="field">
              <span className="field-label">Start (seconds)</span>
              <input
                type="number"
                min="0"
                max={meta?.duration ?? 0}
                step="0.1"
                value={start}
                onChange={(e) => commitTrim(Number(e.target.value), end)}
              />
            </label>
            <label className="field">
              <span className="field-label">Finish (seconds)</span>
              <input
                type="number"
                min="0"
                max={meta?.duration ?? 0}
                step="0.1"
                value={end}
                onChange={(e) => commitTrim(start, Number(e.target.value))}
              />
            </label>
          </div>

          <div className="actions">
            <button className="btn btn--block" disabled={!canConvert} onClick={convert}>
              {busy ? (
                <>
                  <span className="spinner" /> Converting…
                </>
              ) : (
                <>
                  <Wand2 size={18} /> Create GIF
                </>
              )}
            </button>
            <p
              className={
                'status' + (isError ? ' is-error' : '') + (busy ? ' is-busy' : '')
              }
            >
              <span className="status-dot" />
              {status}
            </p>
          </div>
        </section>

        {gifUrl && (
          <section className="panel panel--result">
            <div className="panel-head">
              <Sparkles size={18} />
              <h2>Result</h2>
            </div>
            <div className="result-body">
              <img className="media" src={gifUrl} alt="Generated GIF" />
              <div className="result-side">
                <span className="hint">File size</span>
                <span className="result-size">{formatBytes(gifSize)}</span>
                <a className="btn btn--block" href={gifUrl} download="converted.gif">
                  <Download size={18} /> Download GIF
                </a>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
