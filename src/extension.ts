import * as vscode from "vscode";
import { minimatch } from "minimatch";
import {
  ChangedFile,
  committedFiles,
  fetchBranch,
  getCurrentBranch,
  getRepoRoot,
  listBranches,
  mergeBase,
  pendingFiles,
  RawChange,
} from "./git";
import { BaseResolver } from "./baseResolver";
import {
  buildNodes,
  ChangedFileItem,
  ChangedFilesProvider,
  StatusDecorationProvider,
  TreeNode,
  ViewMode,
} from "./treeProvider";

interface RepoContext {
  repoRoot: string;
  branch: string | null;
  base: string | null;
  mergeBaseSha: string | null;
}

let provider: ChangedFilesProvider;
let decorations: StatusDecorationProvider;
let resolver: BaseResolver;
let treeView: vscode.TreeView<TreeNode>;
let current: RepoContext | null = null;
let refreshTimer: NodeJS.Timeout | undefined;
let viewMode: ViewMode = "tree";
let globalState: vscode.Memento;
let workspaceState: vscode.Memento;

const VIEW_MODE_KEY = "aschanged.viewMode";
const CACHE_KEY = "aschanged.snapshot";

/**
 * Last computed view state, persisted per workspace. On reactivation it is
 * painted synchronously so the view shows the previous files immediately —
 * like the built-in Explorer — instead of an empty/"no data" gap while the
 * async refresh recomputes everything from git.
 */
interface Snapshot {
  repoRoot: string;
  mergeBaseSha: string;
  branch: string | null;
  base: string;
  overridden: boolean;
  files: ChangedFile[];
}

/** Whether folders should be compacted, mirroring the Explorer's setting. */
function compactFoldersEnabled(): boolean {
  return vscode.workspace.getConfiguration("explorer").get<boolean>("compactFolders", true);
}

/**
 * Highlights the active editor's file in the view so it's easy to locate,
 * mirroring the Explorer's auto-reveal. The highlight is a file decoration we
 * control (the TreeView API can't clear a row selection), so it appears on the
 * active file and disappears when the active file isn't one of the changed
 * files. When present and the view is open, the file is also scrolled into view
 * (respecting `explorer.autoReveal`); focus:false keeps the cursor in the editor.
 */
function revealActive(): void {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const node = uri?.scheme === "file" ? provider.findByPath(uri.fsPath) : undefined;

  // Accent the active file, or clear the accent if it isn't in the view.
  decorations.setActive(node ? uri!.fsPath : undefined);
  if (!node || !treeView.visible) return;

  // `explorer.autoReveal` is true | false | "focusNoScroll"; only false disables it.
  const autoReveal = vscode.workspace
    .getConfiguration("explorer")
    .get<boolean | string>("autoReveal", true);
  if (autoReveal === false) return;

  void treeView.reveal(node, { select: false, focus: false, expand: true });
}

/** Persists (or clears, with null) the last view state for instant repaint. */
function saveSnapshot(snap: Snapshot | null): void {
  void workspaceState.update(CACHE_KEY, snap ?? undefined);
}

/**
 * Paints the cached snapshot synchronously, before the first async refresh.
 * Best-effort: if the branch changed since last session, the refresh will
 * reconcile it a moment later (same way git decorations settle in the Explorer).
 */
function seedFromCache(): void {
  const snap = workspaceState.get<Snapshot>(CACHE_KEY);
  if (!snap || snap.files.length === 0) return;
  treeView.description = `${snap.branch ?? "(detached)"} ← ${snap.base}${
    snap.overridden ? " (manual)" : ""
  }`;
  decorations.update(snap.repoRoot, snap.files);
  provider.setRoots(
    buildNodes(snap.files, snap.repoRoot, snap.mergeBaseSha, viewMode, compactFoldersEnabled())
  );
}

export function activate(context: vscode.ExtensionContext) {
  provider = new ChangedFilesProvider();
  decorations = new StatusDecorationProvider();
  resolver = new BaseResolver(context.workspaceState);
  globalState = context.globalState;
  workspaceState = context.workspaceState;

  viewMode = globalState.get<ViewMode>(VIEW_MODE_KEY, "tree");
  void vscode.commands.executeCommand("setContext", VIEW_MODE_KEY, viewMode);

  treeView = vscode.window.createTreeView("aschanged.view", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // Mark the view when running from the Extension Development Host (F5),
  // so it's distinguishable from an installed build active at the same time.
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    treeView.title = "Branch Changes [DEV]";
  }

  // Paint last session's files right away, then refresh reconciles in background.
  seedFromCache();
  revealActive();

  context.subscriptions.push(
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.commands.registerCommand("aschanged.refresh", () => refresh()),
    vscode.commands.registerCommand("aschanged.setBase", () => setBaseCommand()),
    vscode.commands.registerCommand("aschanged.autoDetectBase", () =>
      autoDetectCommand()
    ),
    vscode.commands.registerCommand("aschanged.clearBase", () => clearBaseCommand()),
    vscode.commands.registerCommand("aschanged.openDiff", (item: ChangedFileItem) =>
      openDiff(item)
    ),
    vscode.commands.registerCommand("aschanged.viewAsTree", () => setViewMode("tree")),
    vscode.commands.registerCommand("aschanged.viewAsList", () => setViewMode("list")),
    vscode.commands.registerCommand("aschanged.fetchBase", () => fetchBaseCommand())
  );

  // Keep the active editor's file highlighted in the view so it's easy to locate.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => revealActive()),
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) revealActive();
    })
  );

  // Reactive refreshes.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => scheduleRefresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRefresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("aschanged") ||
        e.affectsConfiguration("explorer.compactFolders")
      ) {
        scheduleRefresh();
      }
    })
  );

  // Built-in git events (commit, checkout, staging...).
  wireGitExtension(context);

  refresh();
}

export function deactivate() {
  if (refreshTimer) clearTimeout(refreshTimer);
}

/** Hooks into the built-in git API to listen for state changes. */
function wireGitExtension(context: vscode.ExtensionContext) {
  const ext = vscode.extensions.getExtension<any>("vscode.git");
  if (!ext) return;

  const hook = () => {
    try {
      const api = ext.exports.getAPI(1);
      const subscribe = (repo: any) =>
        context.subscriptions.push(repo.state.onDidChange(() => scheduleRefresh()));
      api.repositories.forEach(subscribe);
      context.subscriptions.push(api.onDidOpenRepository(subscribe));
    } catch {
      // API unavailable; the other triggers remain (save, manual command).
    }
  };

  if (ext.isActive) hook();
  else ext.activate().then(hook, () => undefined);
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), 250);
}

/** Switches between flat-list and folder-tree views. */
async function setViewMode(mode: ViewMode): Promise<void> {
  if (viewMode === mode) return;
  viewMode = mode;
  await globalState.update(VIEW_MODE_KEY, mode);
  await vscode.commands.executeCommand("setContext", VIEW_MODE_KEY, mode);
  await refresh();
}

/** Recomputes the whole state and repaints the view. */
async function refresh(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    current = null;
    saveSnapshot(null);
    provider.setRoots([]);
    treeView.message = "Open a folder with a git repository.";
    return;
  }

  const repoRoot = await getRepoRoot(folder.uri.fsPath);
  if (!repoRoot) {
    current = null;
    saveSnapshot(null);
    provider.setRoots([]);
    treeView.message = "No git repository detected in the workspace.";
    return;
  }

  const branch = await getCurrentBranch(repoRoot);
  const base = await resolver.resolve(repoRoot, branch);

  if (!base) {
    current = { repoRoot, branch, base: null, mergeBaseSha: null };
    saveSnapshot(null);
    provider.setRoots([]);
    decorations.update(repoRoot, []);
    treeView.message =
      "Couldn't determine a base branch. Use 'Pick base branch...' or set mainBranchCandidates.";
    return;
  }

  const mb = await mergeBase(repoRoot, base, "HEAD");
  if (!mb) {
    current = { repoRoot, branch, base, mergeBaseSha: null };
    saveSnapshot(null);
    provider.setRoots([]);
    decorations.update(repoRoot, []);
    treeView.message = `The current branch shares no history with '${base}'.`;
    return;
  }

  current = { repoRoot, branch, base, mergeBaseSha: mb };

  const [committed, pending] = await Promise.all([
    committedFiles(repoRoot, mb),
    pendingFiles(repoRoot),
  ]);

  const files = buildFileList(committed, pending);
  const visible = applyExcludes(files);

  // Header: current branch + base + base origin.
  const overridden = branch ? !!resolver.getOverride(repoRoot, branch) : false;
  treeView.description = `${branch ?? "(detached)"} ← ${base}${overridden ? " (manual)" : ""}`;
  treeView.message = visible.length === 0 ? "No files changed relative to the base." : undefined;

  decorations.update(repoRoot, visible);
  provider.setRoots(buildNodes(visible, repoRoot, mb, viewMode, compactFoldersEnabled()));
  // Re-select the active file: rebuilding the tree dropped the prior selection.
  revealActive();

  // Persist for the next reactivation's instant repaint (only the populated state).
  saveSnapshot(
    visible.length > 0
      ? { repoRoot, mergeBaseSha: mb, branch, base, overridden, files: visible }
      : null
  );
}

/**
 * Merges committed and pending into a single list. If a file is in both,
 * "pending" wins (it has uncommitted changes).
 */
function buildFileList(committed: RawChange[], pending: RawChange[]): ChangedFile[] {
  const map = new Map<string, ChangedFile>();

  for (const c of committed) {
    map.set(c.relPath, { relPath: c.relPath, status: "committed", kind: c.kind });
  }
  // If a file also has uncommitted changes, "pending" overrides.
  for (const p of pending) {
    map.set(p.relPath, { relPath: p.relPath, status: "pending", kind: p.kind });
  }

  return [...map.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** Filters out files matching the files.exclude globs. */
function applyExcludes(files: ChangedFile[]): ChangedFile[] {
  const respect = vscode.workspace
    .getConfiguration("aschanged")
    .get<boolean>("respectFilesExclude", true);
  if (!respect) return files;

  const exclude = vscode.workspace.getConfiguration("files").get<Record<string, boolean>>("exclude", {});
  const patterns = Object.entries(exclude)
    .filter(([, enabled]) => enabled)
    .map(([glob]) => glob);
  if (patterns.length === 0) return files;

  return files.filter((f) => !patterns.some((p) => matchesGlob(f.relPath, p)));
}

/** VSCode-style matching: tests the path and each folder segment. */
function matchesGlob(relPath: string, pattern: string): boolean {
  const opts = { dot: true, nocase: process.platform === "darwin" || process.platform === "win32" };
  if (minimatch(relPath, pattern, opts)) return true;
  // files.exclude uses patterns like "**/node_modules" that must also catch
  // files inside that folder.
  return minimatch(relPath, `${pattern}/**`, opts);
}

// ---------- Commands ----------

async function setBaseCommand(): Promise<void> {
  if (!current) return;
  const { repoRoot, branch } = current;
  if (!branch) {
    vscode.window.showWarningMessage("You're in detached HEAD; can't save a per-branch base.");
    return;
  }

  const branches = await listBranches(repoRoot);
  const pick = await vscode.window.showQuickPick(branches, {
    title: `Base branch for '${branch}'`,
    placeHolder: "Pick which branch to compare against",
  });
  if (!pick) return;

  await resolver.setOverride(repoRoot, branch, pick);
  await refresh();
}

async function autoDetectCommand(): Promise<void> {
  if (!current) return;
  const { repoRoot, branch } = current;
  if (!branch) {
    vscode.window.showWarningMessage("You're in detached HEAD; can't auto-detect the base.");
    return;
  }

  const detected = await resolver.autoDetect(repoRoot, branch);
  if (!detected) {
    vscode.window.showInformationMessage("No candidate base branch found.");
    return;
  }

  const confirm = await vscode.window.showInformationMessage(
    `Detected base: '${detected}'. Use it for '${branch}'?`,
    "Use",
    "Cancel"
  );
  if (confirm !== "Use") return;

  await resolver.setOverride(repoRoot, branch, detected);
  await refresh();
}

async function clearBaseCommand(): Promise<void> {
  if (!current) return;
  const { repoRoot, branch } = current;
  if (!branch) return;
  await resolver.clearOverride(repoRoot, branch);
  await refresh();
}

/**
 * Updates the base's remote ref (`git fetch origin <branch>`) and refreshes.
 * Needed for the comparison to match the server's PR: the merge-base is only
 * correct when `origin/<base>` is up to date.
 */
async function fetchBaseCommand(): Promise<void> {
  if (!current?.base) return;
  const { repoRoot, base } = current;
  const remote = "origin";
  const branch = base.startsWith(`${remote}/`) ? base.slice(remote.length + 1) : base;

  await vscode.window.withProgress(
    { location: { viewId: "aschanged.view" }, title: `Fetch ${remote}/${branch}…` },
    async () => {
      try {
        await fetchBranch(repoRoot, remote, branch);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Couldn't fetch ${remote}/${branch}: ${msg}`);
      }
    }
  );
  await refresh();
}

/** Opens a diff between the base (merge-base) and the file in the working tree. */
async function openDiff(item: ChangedFileItem): Promise<void> {
  const fileUri = item.resourceUri!;
  const baseUri = toGitUri(fileUri, item.mergeBaseSha);

  if (!baseUri) {
    await vscode.commands.executeCommand("vscode.open", fileUri);
    return;
  }

  const title = `${item.file.relPath} (base ↔ working)`;
  try {
    await vscode.commands.executeCommand("vscode.diff", baseUri, fileUri, title);
  } catch {
    await vscode.commands.executeCommand("vscode.open", fileUri);
  }
}

/** Builds a git: URI to show a file's contents at a given ref. */
function toGitUri(fileUri: vscode.Uri, ref: string): vscode.Uri | null {
  try {
    const ext = vscode.extensions.getExtension<any>("vscode.git");
    if (!ext?.isActive) return null;
    const api = ext.exports.getAPI(1);
    return api.toGitUri(fileUri, ref);
  } catch {
    return null;
  }
}
