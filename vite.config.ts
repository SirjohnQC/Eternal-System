import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Keep source assets in /assets and mirror into /public/assets for Vite.
 * Never use a junction — deleting through public/ would wipe the source tree.
 */
function syncAssetsToPublic(): void {
  const src = path.resolve('assets');
  const dest = path.resolve('public/assets');
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.resolve('public'), { recursive: true });
  // If dest is a leftover junction, remove the link only (not the target)
  try {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink()) fs.unlinkSync(dest);
  } catch { /* missing is fine */ }
  fs.cpSync(src, dest, { recursive: true });
}

syncAssetsToPublic();

export default defineConfig({
  server: { port: 3000 },
  publicDir: 'public',
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
