import * as vscode from "vscode";
import * as path from "node:path";
import { ChangedFile, ChangeKind } from "./git";

/** How the view presents its items. */
export type ViewMode = "list" | "tree";

/** View node: a changed file. */
export class ChangedFileItem extends vscode.TreeItem {
  /** Set while building the tree so the view can reveal this node. */
  parent?: ChangedFolderItem;

  constructor(
    public readonly file: ChangedFile,
    public readonly repoRoot: string,
    public readonly mergeBaseSha: string,
    /** Label to show: full path (list) or just the file name (tree). */
    label: string = file.relPath
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    const absPath = path.join(repoRoot, file.relPath);
    this.resourceUri = vscode.Uri.file(absPath);
    // The native file-type icon comes from resourceUri.
    this.label = label;
    // Tooltip is just the path; the status is conveyed once by the dot badge's
    // own tooltip (see StatusDecorationProvider), avoiding a duplicate phrase.
    this.tooltip = file.relPath;
    this.contextValue = "changedFile";
    // A deleted file has nothing to open in the working tree, so clicking it
    // shows the diff against the base instead; otherwise open the source file.
    this.command =
      file.kind === "deleted"
        ? { command: "aschanged.openDiff", title: "Show diff", arguments: [this] }
        : { command: "vscode.open", title: "Open file", arguments: [this.resourceUri] };
  }
}

/** View node: a folder grouping changed files (tree mode). */
export class ChangedFolderItem extends vscode.TreeItem {
  public children: TreeNode[] = [];
  /** Set while building the tree so the view can reveal nested nodes. */
  parent?: ChangedFolderItem;

  constructor(
    /** Folder path relative to the repo root (POSIX). */
    public readonly relPath: string,
    public readonly repoRoot: string,
    /** Label (plain name, or segments merged via compact folders). */
    label: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    // Stable id so the expanded/collapsed state survives a tree rebuild (we
    // rebuild to clear the selection; files get no id so the selection drops).
    this.id = `dir:${relPath}`;
    this.resourceUri = vscode.Uri.file(path.join(repoRoot, relPath));
    this.iconPath = vscode.ThemeIcon.Folder;
    this.contextValue = "changedFolder";
  }
}

export type TreeNode = ChangedFileItem | ChangedFolderItem;

export class ChangedFilesProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: TreeNode[] = [];
  /** fsPath → file node, so the view can reveal the active editor's file. */
  private byPath = new Map<string, ChangedFileItem>();

  setRoots(roots: TreeNode[]): void {
    this.roots = roots;
    this.byPath = new Map();
    index(roots, this.byPath);
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) return this.roots;
    if (element instanceof ChangedFolderItem) return element.children;
    return [];
  }

  /** Required for treeView.reveal() to walk up to the root. */
  getParent(element: TreeNode): TreeNode | undefined {
    return element.parent;
  }

  /** The file node for a given absolute path, or undefined if not in the view. */
  findByPath(fsPath: string): ChangedFileItem | undefined {
    return this.byPath.get(fsPath);
  }
}

/** Walks the tree filling a fsPath → file node index. */
function index(nodes: TreeNode[], into: Map<string, ChangedFileItem>): void {
  for (const node of nodes) {
    if (node instanceof ChangedFolderItem) {
      index(node.children, into);
    } else if (node.resourceUri) {
      into.set(node.resourceUri.fsPath, node);
    }
  }
}

/** Last segment of a POSIX path. */
function baseName(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? relPath : relPath.slice(i + 1);
}

/**
 * Builds the view's root nodes from the file list.
 * In "list" mode it returns one node per file with the full path.
 * In "tree" mode it builds nested folders, like the Explorer's file section.
 */
export function buildNodes(
  files: ChangedFile[],
  repoRoot: string,
  mergeBaseSha: string,
  mode: ViewMode,
  compactFolders: boolean
): TreeNode[] {
  if (mode === "list") {
    return files.map((f) => new ChangedFileItem(f, repoRoot, mergeBaseSha));
  }

  const root = new DirNode("", "");
  for (const f of files) {
    const parts = f.relPath.split("/");
    parts.pop(); // the file name is not a folder
    let dir = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let next = dir.dirs.get(part);
      if (!next) {
        next = new DirNode(part, acc);
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push(f);
  }

  return toNodes(root, repoRoot, mergeBaseSha, compactFolders, undefined);
}

/** Intermediate structure for building the folder tree. */
class DirNode {
  readonly dirs = new Map<string, DirNode>();
  readonly files: ChangedFile[] = [];
  constructor(readonly name: string, readonly relPath: string) {}
}

/** Converts a DirNode's contents (subfolders + files) into view nodes. */
function toNodes(
  dir: DirNode,
  repoRoot: string,
  mergeBaseSha: string,
  compact: boolean,
  parent: ChangedFolderItem | undefined
): TreeNode[] {
  const folders = [...dir.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((sub) => toFolder(sub, repoRoot, mergeBaseSha, compact, parent));

  const fileItems = dir.files
    .sort((a, b) => baseName(a.relPath).localeCompare(baseName(b.relPath)))
    .map((f) => {
      const item = new ChangedFileItem(f, repoRoot, mergeBaseSha, baseName(f.relPath));
      item.parent = parent;
      return item;
    });

  // Folders first, then files (like the Explorer).
  return [...folders, ...fileItems];
}

/** Builds a folder node, merging single-child folder chains when compact is on. */
function toFolder(
  dir: DirNode,
  repoRoot: string,
  mergeBaseSha: string,
  compact: boolean,
  parent: ChangedFolderItem | undefined
): ChangedFolderItem {
  let label = dir.name;
  let cur = dir;
  // Compact folders: "a" → "b" → files is shown as "a/b".
  if (compact) {
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const only = [...cur.dirs.values()][0];
      label = `${label}/${only.name}`;
      cur = only;
    }
  }
  const folder = new ChangedFolderItem(cur.relPath, repoRoot, label);
  folder.parent = parent;
  folder.children = toNodes(cur, repoRoot, mergeBaseSha, compact, folder);
  return folder;
}

/** Per-kind badge: a git-style letter plus the matching git theme color. */
const KIND_BADGE: Record<ChangeKind, { letter: string; colorId: string; tooltip: string }> = {
  added: {
    letter: "A",
    colorId: "gitDecoration.addedResourceForeground",
    tooltip: "Added (uncommitted)",
  },
  modified: {
    letter: "M",
    colorId: "gitDecoration.modifiedResourceForeground",
    tooltip: "Modified (uncommitted)",
  },
  deleted: {
    letter: "D",
    colorId: "gitDecoration.deletedResourceForeground",
    tooltip: "Deleted (uncommitted)",
  },
  renamed: {
    letter: "R",
    colorId: "gitDecoration.renamedResourceForeground",
    tooltip: "Renamed (uncommitted)",
  },
  untracked: {
    letter: "U",
    colorId: "gitDecoration.untrackedResourceForeground",
    tooltip: "Untracked",
  },
};

/**
 * Decorates files that have uncommitted (pending) changes with a git-style
 * letter badge (M/A/D/R/U) in the matching git theme color. Committed files get
 * no badge: being part of the branch is the default state for the view.
 */
export class StatusDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private kindByPath = new Map<string, ChangeKind>();

  update(repoRoot: string, files: ChangedFile[]): void {
    const next = new Map<string, ChangeKind>();
    for (const f of files) {
      if (f.status !== "pending") continue; // committed files are not decorated
      const fsPath = vscode.Uri.file(path.join(repoRoot, f.relPath)).fsPath;
      next.set(fsPath, f.kind);
    }
    // URIs whose status changed (or appeared/disappeared).
    const changed: vscode.Uri[] = [];
    for (const key of new Set([...this.kindByPath.keys(), ...next.keys()])) {
      if (this.kindByPath.get(key) !== next.get(key)) {
        changed.push(vscode.Uri.file(key));
      }
    }
    this.kindByPath = next;
    this._onDidChange.fire(changed);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const kind = this.kindByPath.get(uri.fsPath);
    if (!kind) return undefined;
    const badge = KIND_BADGE[kind];
    return {
      badge: badge.letter,
      tooltip: badge.tooltip,
      color: new vscode.ThemeColor(badge.colorId),
    };
  }
}
