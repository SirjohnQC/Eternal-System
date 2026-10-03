/**
 * Progressive zoom as a pure state machine. A gesture that starts at the
 * identity view shows the identity layers under today's CSS transform
 * (instant, no blank areas); SETTLE_MS after the last input it asks once for a
 * camera re-bake, and once the host reports it done, the display shows the
 * camera layers with no CSS transform.
 *
 * Spec 5b: a gesture that starts while the camera layers are shown STAYS on
 * them — no CSS, no identity layers. The host draws the shown set through
 * `liveCamera()` (a pan slides it by whole px, a wheel scales it in the
 * canvas); the settle asks for the next set (a re-centre or a new zoom), and
 * the host swaps it in when its time-sliced bake completes.
 */
import { cameraFromView, identityCamera, type Camera } from './ZoomCamera';

/** Idle before a sharp camera re-bake — short enough to feel continuous. */
export const SETTLE_MS = 90;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** Per-notch scale factors — smaller than the old 0.86/1.16 for a smoother feel. */
const WHEEL_OUT = 0.9;
const WHEEL_IN = 1 / WHEEL_OUT;

export class ZoomController {
  private zoom = 1; private px = 0; private py = 0;
  private lastInput = -Infinity; private panning = false; private pending = false;
  private panOrigin = { x: 0, y: 0, px: 0, py: 0 };
  /** Last pointer position of the active pan (CSS px). */
  private panAt = { x: 0, y: 0 };
  private cam: Camera; private camShown = false;
  private issued: Camera | null = null;
  /** `liveCamera()`'s default target, reused so the per-frame call never allocates. */
  private live: Camera;

  constructor(private rect: { width: number; height: number }, private VW: number, private VH: number) {
    this.cam = identityCamera(VW, VH);
    this.live = identityCamera(VW, VH);
  }

  get viewZoom(): number { return this.zoom; }
  get panX(): number { return this.px; }
  get panY(): number { return this.py; }
  get showCamera(): boolean { return this.camShown; }
  get rendered(): Camera { return this.cam; }

  /**
   * The camera the view shows right now: `cameraFromView` of the current zoom
   * and pan (focus snapped to whole px), written into `out`. Allocation-free.
   */
  liveCamera(out: Camera = this.live): Camera {
    const z = this.zoom;
    const fx = this.VW / 2 - (this.px / z) * (this.VW / this.rect.width);
    const fy = this.VH / 2 - (this.py / z) * (this.VH / this.rect.height);
    out.zoom = z; out.fx = Math.round(fx * z) / z; out.fy = Math.round(fy * z) / z;
    return out;
  }

  /** CSS transform for the display canvas right now. */
  cssTransform(): string {
    if (this.camShown || (this.zoom === 1 && this.px === 0 && this.py === 0)) return 'none';
    return `translate(${this.px}px, ${this.py}px) scale(${this.zoom})`;
  }

  private beginInput(t: number): void {
    this.lastInput = t;
    this.pending = true;
    // Spec 5b: input while the camera layers are shown keeps them (the host
    // slides or scales them). From the identity view, the gesture is CSS over
    // the identity layers and supersedes any camera already requested.
    if (!this.camShown) this.issued = null;
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
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev * (deltaY > 0 ? WHEEL_OUT : WHEEL_IN)));
    if (next === prev) return;
    this.beginInput(t);
    const wx = (mx - this.px) / prev, wy = (my - this.py) / prev;
    this.zoom = next; this.px = mx - wx * next; this.py = my - wy * next;
    this.clamp();
    // A wheel during a drag: the drag continues from the zoomed pan, or the
    // next panMove would rebuild the pan from the pre-wheel origin.
    if (this.panning) this.panOrigin = { x: this.panAt.x, y: this.panAt.y, px: this.px, py: this.py };
  }

  // Drag-vs-click deadzone is deliberately not this controller's job — the host
  // (IsoDioramaRenderer) decides when a pointer-down turns into a pan gesture
  // before calling panStart/panMove.
  panStart(x: number, y: number, t: number): void {
    this.panning = true; this.panOrigin = { x, y, px: this.px, py: this.py }; this.panAt = { x, y }; this.beginInput(t);
  }

  panMove(x: number, y: number, t: number): void {
    if (!this.panning) return;
    this.beginInput(t);
    this.panAt.x = x; this.panAt.y = y;
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
    if (this.zoom === 1) { this.cam = identityCamera(this.VW, this.VH); this.camShown = false; this.issued = null; return null; }
    this.issued = target;
    return target;
  }

  /**
   * The host finished re-baking for `cam`: show the camera layers, CSS identity.
   * From the identity view it is ignored when `cam` is not the camera this
   * controller most recently issued — a later gesture (wheel/pan) between
   * tick() and settled() supersedes it, and applying the stale camera would
   * flash the wrong render for a frame. While the camera layers are shown any
   * finished set is drawn through the live camera, so it is always taken.
   */
  settled(cam: Camera): void {
    if (this.camShown) { this.cam = cam; if (cam === this.issued) this.issued = null; return; }
    if (cam !== this.issued) return;
    this.cam = cam; this.camShown = true; this.issued = null;
  }

  resize(rect: { width: number; height: number }, VW: number, VH: number): void {
    this.rect = rect; this.VW = VW; this.VH = VH; this.clamp();
    this.issued = null; // the in-flight request (if any) was baked for the old size
    if (this.zoom !== 1) { this.pending = true; this.lastInput = -Infinity; this.camShown = false; }
    else this.cam = identityCamera(VW, VH);
  }

  /** New planet: back to identity. */
  reset(): void {
    this.zoom = 1; this.px = 0; this.py = 0; this.pending = false; this.panning = false;
    this.cam = identityCamera(this.VW, this.VH); this.camShown = false; this.issued = null;
  }
}
