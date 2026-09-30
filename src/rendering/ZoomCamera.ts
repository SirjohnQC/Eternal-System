/**
 * The zoom camera: which part of the diorama the canvas shows, and at what
 * scale. Pure. Positions are in BASE virtual pixels (the identity render's
 * coordinates); the canvas size never changes, so at zoom z it shows 1/z of the
 * scene at z times the detail. See docs/superpowers/specs/2026-09-30-zoom-camera-design.md.
 */
import type { HabitableGeom } from './HabitableCutawayEngine';

export interface Camera { zoom: number; fx: number; fy: number }

export const FAR_PARALLAX = 0.1;

export function identityCamera(VW: number, VH: number): Camera {
  return { zoom: 1, fx: VW / 2, fy: VH / 2 };
}

export function isIdentity(cam: Camera, VW: number, VH: number): boolean {
  return cam.zoom === 1 && cam.fx === VW / 2 && cam.fy === VH / 2;
}

export function worldToScreen(cam: Camera, VW: number, VH: number, x: number, y: number): { x: number; y: number } {
  return { x: (x - cam.fx) * cam.zoom + VW / 2, y: (y - cam.fy) * cam.zoom + VH / 2 };
}

export function screenToWorld(cam: Camera, VW: number, VH: number, x: number, y: number): { x: number; y: number } {
  return { x: (x - VW / 2) / cam.zoom + cam.fx, y: (y - VH / 2) / cam.zoom + cam.fy };
}

/** Geometry as seen through the camera: lengths x zoom, centres mapped. Identity returns `base` unchanged. */
export function applyCamera(base: HabitableGeom, cam: Camera, VW: number, VH: number): HabitableGeom {
  if (isIdentity(cam, VW, VH)) return base;
  const z = cam.zoom;
  const c = worldToScreen(cam, VW, VH, base.cx, base.cyTop);
  const b = worldToScreen(cam, VW, VH, base.cx, base.cyBody);
  return { ...base, cx: c.x, cyTop: c.y, cyBody: b.y, R: base.R * z, rx: base.rx * z, ry: base.ry * z, wall: base.wall * z, T: base.T * z };
}

/**
 * Today's CSS view state -> camera. The display is scaled about its centre by
 * `zoom` and translated by `pan` (CSS px), so the screen centre shows the virtual
 * point VW/2 - pan/zoom (in virtual px). Snapped so centres land on whole pixels.
 */
export function cameraFromView(
  zoom: number, panX: number, panY: number,
  rect: { width: number; height: number }, VW: number, VH: number,
): Camera {
  const fx = VW / 2 - (panX / zoom) * (VW / rect.width);
  const fy = VH / 2 - (panY / zoom) * (VH / rect.height);
  return { zoom, fx: Math.round(fx * zoom) / zoom, fy: Math.round(fy * zoom) / zoom };
}

/** Far layers (backdrop, sky) scale by this, not by the zoom: a mild parallax. */
export function farScale(zoom: number): number {
  return 1 + FAR_PARALLAX * (zoom - 1);
}
