/**
 * Progressive zoom as a pure state machine. During a gesture the display shows
 * the identity layers under today's CSS transform (instant, no blank areas);
 * SETTLE_MS after the last input it asks once for a camera re-bake, and once the
 * host reports it done, the display shows the camera layers with no CSS transform.
 */
import { cameraFromView, identityCamera, type Camera } from './ZoomCamera';

export const SETTLE_MS = 150;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export class ZoomController {
  private zoom = 1; private px = 0; private py = 0;
  private lastInput = -Infinity; private panning = false; private pending = false;
  private panOrigin = { x: 0, y: 0, px: 0, py: 0 };
  private cam: Camera; private camShown = false;

  constructor(private rect: { width: number; height: number }, private VW: number, private VH: number) {
    this.cam = identityCamera(VW, VH);
  }

  get viewZoom(): number { return this.zoom; }
  get panX(): number { return this.px; }
  get panY(): number { return this.py; }
  get showCamera(): boolean { return this.camShown; }
  get rendered(): Camera { return this.cam; }

  /** CSS transform for the display canvas right now. */
  cssTransform(): string {
    if (this.camShown || (this.zoom === 1 && this.px === 0 && this.py === 0)) return 'none';
    return `translate(${this.px}px, ${this.py}px) scale(${this.zoom})`;
  }

  private beginInput(t: number): void {
    this.lastInput = t;
    this.pending = true;
    this.camShown = false;      // back to the identity layers + CSS while gesturing
  }

  private clamp(): void {
    if (this.zoom <= MIN_ZOOM + 0.001) { this.zoom = MIN_ZOOM; this.px = 0; this.py = 0; return; }
    const mx = (this.zoom - 1) * this.rect.width * 0.5, my = (this.zoom - 1) * this.rect.height * 0.5;
    this.px = Math.max(-mx, Math.min(mx, this.px));
    this.py = Math.max(-my, Math.min(my, this.py));
  }

  /** mx, my: cursor relative to the mount centre, CSS px. deltaY > 0 zooms out. */
  wheel(mx: number, my: number, deltaY: number, t: number): void {
    const prev = this.zoom;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev * (deltaY > 0 ? 0.86 : 1.16)));
    if (next === prev) return;
    this.beginInput(t);
    const wx = (mx - this.px) / prev, wy = (my - this.py) / prev;
    this.zoom = next; this.px = mx - wx * next; this.py = my - wy * next;
    this.clamp();
  }

  panStart(x: number, y: number, t: number): void {
    this.panning = true; this.panOrigin = { x, y, px: this.px, py: this.py }; this.beginInput(t);
  }

  panMove(x: number, y: number, t: number): void {
    if (!this.panning) return;
    this.beginInput(t);
    this.px = this.panOrigin.px + (x - this.panOrigin.x);
    this.py = this.panOrigin.py + (y - this.panOrigin.y);
    this.clamp();
  }

  panEnd(t: number): void { if (this.panning) { this.panning = false; this.lastInput = t; } }

  /** Once per frame. Returns a camera to re-bake when a settle is due (at most once per settle). */
  tick(t: number): Camera | null {
    if (!this.pending || this.panning || t - this.lastInput < SETTLE_MS) return null;
    this.pending = false;
    const target = cameraFromView(this.zoom, this.px, this.py, this.rect, this.VW, this.VH);
    if (this.zoom === 1) { this.cam = identityCamera(this.VW, this.VH); this.camShown = false; return null; }
    return target;
  }

  /** The host finished re-baking for `cam`: show the camera layers, CSS identity. */
  settled(cam: Camera): void { this.cam = cam; this.camShown = true; }

  resize(rect: { width: number; height: number }, VW: number, VH: number): void {
    this.rect = rect; this.VW = VW; this.VH = VH; this.clamp();
    if (this.zoom !== 1) { this.pending = true; this.lastInput = -Infinity; this.camShown = false; }
    else this.cam = identityCamera(VW, VH);
  }

  /** New planet: back to identity. */
  reset(): void {
    this.zoom = 1; this.px = 0; this.py = 0; this.pending = false; this.panning = false;
    this.cam = identityCamera(this.VW, this.VH); this.camShown = false;
  }
}
