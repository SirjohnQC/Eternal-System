/**
 * Minimal DOM stub so the real simulation can run under Node.
 *
 * Import this module FIRST (before any `src/` import) — the engine touches
 * `document` / `window` at module-evaluation time. Every 2D context call is a
 * no-op; image-data calls return correctly sized zeroed buffers.
 */

const noopCtx = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 1200, height: 800 };
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'getImageData') {
      return (_x: number, _y: number, w = 1, h = 1) =>
        ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
    }
    if (prop === 'createImageData') {
      return (w = 1, h = 1) =>
        ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
    }
    if (prop === 'measureText') return () => ({ width: 10 });
    return () => undefined;
  },
  set() { return true; },
});

export function makeCanvas(): any {
  return {
    width: 1200, height: 800, style: {},
    getContext: () => noopCtx,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    toDataURL: () => '',
  };
}

const g = globalThis as any;
g.document ??= {
  createElement: () => makeCanvas(),
  getElementById: () => null, querySelector: () => null,
  querySelectorAll: () => [], addEventListener() {},
};
g.window ??= g;
g.requestAnimationFrame ??= () => 0;
g.cancelAnimationFrame ??= () => {};
g.addEventListener ??= () => {};
g.eternalSpeed ??= 60;
