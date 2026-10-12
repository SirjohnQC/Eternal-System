/**
 * Which build this is. Injected by Vite's `define` (vite.config.ts) from
 * package.json and the git commit; falls back to 'dev' anywhere it is not
 * defined (headless tools). Shown on the main menu and in Settings so a
 * playtest note can say exactly which build it came from.
 */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
export const APP_COMMIT: string = typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'dev';
export const BUILD_LABEL = `v${APP_VERSION} · ${APP_COMMIT}`;
