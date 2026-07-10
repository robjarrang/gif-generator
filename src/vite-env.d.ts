/// <reference types="vite/client" />

declare module 'gifski-wasm' {
  export type GifskiEncodeOptions = {
    frames: Array<Uint8ClampedArray | Uint8Array | ImageData>;
    width: number;
    height: number;
    fps?: number;
    quality?: number;
    repeat?: number;
    resizeWidth?: number;
    resizeHeight?: number;
  };
  export default function encode(options: GifskiEncodeOptions): Promise<Uint8Array>;
}
