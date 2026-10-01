/**
 * The progressive-zoom settle step, shared by IsoDioramaRenderer (once per
 * frame, before drawing) and tools/zoomCheck (headless). Types only: no DOM,
 * no engine or controller code is pulled in.
 *
 * Every frame:
 *  - `controller.tick(t)` -> when a settle is due it returns the camera to
 *    re-bake: `hooks.beforeCamera(cam)` (the host's merged 4 s rebake),
 *    `engine.setCamera(cam)`, `hooks.afterCamera(cam)` (far backdrop, cached
 *    buffers), then `controller.settled(cam)`;
 *  - back at zoom 1 the camera layers are dropped (`setCamera(identity)`);
 *  - `engine.showCamera` follows `controller.showCamera`: false while a
 *    gesture runs (identity layers under the CSS transform), true from the
 *    settle frame on. The host applies `controller.cssTransform()` after this
 *    call, so the CSS reset and the sharp camera frame land in the same frame.
 */
import type { HabitableCutawayEngine } from './HabitableCutawayEngine';
import type { ZoomController } from './ZoomController';
import type { Camera } from './ZoomCamera';

export interface SettleHooks {
  /** Runs after a settle is decided and before the camera re-bake. */
  beforeCamera?(cam: Camera): void;
  /** Runs right after `engine.setCamera(cam)`, before the camera set is shown. */
  afterCamera?(cam: Camera): void;
}

/** Returns the camera re-baked this frame, or null. Allocates nothing when no settle is due. */
export function applySettle(
  engine: HabitableCutawayEngine, controller: ZoomController, t: number, hooks?: SettleHooks,
): Camera | null {
  const cam = controller.tick(t);
  if (cam) {
    hooks?.beforeCamera?.(cam);
    engine.setCamera(cam);
    hooks?.afterCamera?.(cam);
    controller.settled(cam);
  } else if (controller.viewZoom === 1 && engine.camera.zoom !== 1) {
    // Zoomed back out to 1: drop the camera layers (identity path).
    engine.clearCamera();
  }
  if (engine.showCamera !== controller.showCamera) engine.showCamera = controller.showCamera;
  return cam;
}
