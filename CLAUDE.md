# aschanged

VS Code extension ("AS Changed") that adds a Branch Changes view to the
Explorer: files changed in the current branch relative to its base branch,
distinguishing committed from uncommitted changes.

## Architecture

Four source files under `src/`, bundled with esbuild into `dist/extension.js`:

- `extension.ts` — activation, command registration, view wiring.
- `treeProvider.ts` — the Explorer tree/flat view (mode is remembered).
- `git.ts` — git plumbing (diffs against the merge-base, status letters).
- `baseResolver.ts` — base-branch resolution: manual per-branch override →
  auto-detect (stacked branches) → repo main branch, preferring `origin/*`
  refs over local ones (mirrors a PR's three-dot diff).

## Commands

- `npm run build` — production bundle (also runs on `vscode:prepublish`).
- `npm run watch` — esbuild watch mode for development.
- `npm run typecheck` — `tsc --noEmit`; there is no separate lint step.

There are no tests. Verify changes by launching the extension host (F5 in
VS Code) or packaging with `vsce package` and installing the `.vsix`.
