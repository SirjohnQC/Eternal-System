import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

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

/** Short commit of this build: CI's GITHUB_SHA, else local git, else 'dev'. */
function buildCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? `${sha}+` : sha;
  } catch {
    return 'dev';
  }
}
const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(buildCommit()),
  },
  server: { port: 3000 },
  publicDir: 'public',
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
