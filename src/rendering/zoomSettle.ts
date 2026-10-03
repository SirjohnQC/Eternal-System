/**
 * The progressive-zoom settle step, shared by IsoDioramaRenderer (once per
 * frame, before drawing) and tools/zoomCheck (headless). Types only: no DOM,
 * no engine or controller code is pulled in.
 *
 * Every frame:
 *  - `controller.tick(t)` -> when a settle is due it returns the camera to
 *    bake: `hooks.beforeCamera(cam)` (the host's merged 4 s rebake), then
 *    `engine.requestCamera(cam)` starts (or queues) its bake;
 *  - `engine.stepBake(budgetMs)` advances the pending bake (spec 5b: time-
 *    sliced, the current set or the identity view keeps being drawn); when it
 *    completes, its set is swapped in, `hooks.afterCamera(cam)` runs (far
 *    backdrop) and `controller.settled(cam)`;
 *  - back at zoom 1 the camera layers are dropped (`clearCamera`);
 *  - `engine.showCamera` follows `controller.showCamera`, and the engine draws
 *    the shown set through `controller.liveCamera()` (a pan slides it, a wheel
 *    scales it). The host applies `controller.cssTransform()` after this call,
 *    so the CSS reset and the sharp camera frame land in the same frame.
 * `budgetMs` Infinity (the default) bakes to completion in this call.
 */
import type { HabitableCutawayEngine } from './HabitableCutawayEngine';
import type { ZoomController } from './ZoomController';
import type { Camera } from './ZoomCamera';

export interface SettleHooks {
  /** Runs after a settle is decided and before the camera bake is requested. */
  beforeCamera?(cam: Camera): void;
  /** Runs when a camera bake has completed and its set is swapped in, before it is drawn. */
  afterCamera?(cam: Camera): void;
}

/** Returns the camera whose set was swapped in this frame, or null. Allocates nothing when no settle is due. */
export function applySettle(
  engine: HabitableCutawayEngine, controller: ZoomController, t: number, hooks?: SettleHooks,
  budgetMs = Infinity,
): Camera | null {
  const cam = controller.tick(t);
  if (cam) {
    hooks?.beforeCamera?.(cam);
    // Nothing to bake (the set already shows `cam`): settled at once.
    if (!engine.requestCamera(cam)) controller.settled(cam);
  } else if (controller.viewZoom === 1 && (engine.camera.zoom !== 1 || engine.bakePending)) {
    // Zoomed back out to 1: drop the camera layers and any bake in flight (identity path).
    engine.clearCamera();
  }
  const done = engine.stepBake(budgetMs);
  if (done) {
    hooks?.afterCamera?.(done);
    controller.settled(done);
  }
  if (engine.showCamera !== controller.showCamera) engine.showCamera = controller.showCamera;
  engine.setView(controller.liveCamera());
  return done;
}
