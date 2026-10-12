# Releasing

Every release is a git tag `vX.Y.Z` on `main` that matches `package.json`.
Pushing the tag runs `.github/workflows/release.yml`: tests, smoke test,
production build, then a GitHub Release with the playable build
(`eternal-system-vX.Y.Z.zip`) attached and notes generated from merged PRs.

## Steps

1. Bump the version in a PR (no tag yet):
   ```sh
   npm version minor --no-git-tag-version   # or patch / major
   ```
   Merge it once CI is green.
2. Tag the merged commit on `main` and push the tag:
   ```sh
   git checkout main && git pull
   git tag v$(node -p "require('./package.json').version")
   git push origin --tags
   ```
3. The Release appears under GitHub → Releases a few minutes later.

## Versions

- `0.x.y` releases are marked pre-release.
- **minor** (`0.2.0 → 0.3.0`): a playtest build with new features.
- **patch** (`0.2.0 → 0.2.1`): fixes only.
- A save-format change (`SAVE_VERSION` in `src/simulation/SaveFormat.ts`) should
  be called out in the release notes.

## Release notes

Notes are grouped by **PR labels** (see `.github/release.yml`): `enhancement`,
`bug`, `area:infra` / `documentation`. Label PRs when opening them.

## Which build is this?

The main menu and the Settings header show `vX.Y.Z · <commit>` (a trailing `+`
means uncommitted local changes). Put it in every playtest note.
