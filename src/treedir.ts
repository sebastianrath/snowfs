/* eslint-disable no-empty-function */
/* eslint-disable no-useless-constructor */
import * as fse from 'fs-extra';
import * as crypto from 'crypto';

import {
  join, relative, normalize, extname,
} from './path';
import { Repository } from './repository';
import {
  FileInfo, getPartHash, HashBlock, MB20, StatsSubset,
} from './common';

export const enum FILEMODE {
  UNREADABLE = 0,
  TREE = 16384,
  BLOB = 33188,
  EXECUTABLE = 33261,
  LINK = 40960,
  COMMIT = 57344,
}

export const enum DETECTIONMODE {
  /**
   * Only perform a size and mktime check. If the modified time differs between the commited file
   * and the one in the working directory, the file is identified as modified.
   * If the modified time is the same, the file is not identified as modified.
   */
  ONLY_SIZE_AND_MKTIME = 1,

  /**
   * Perform a size and hash check for all files smaller than 20 MB.
   */
  SIZE_AND_HASH_FOR_SMALL_FILES = 2,

  /**
   * Perform a size and hash check for all files. Please note,
   * that this is the slowest of all detection modes.
   */
  SIZE_AND_HASH_FOR_ALL_FILES = 3
}

export class TreeEntry {
  constructor(
    public hash: string,
    public path: string,
    public stats: StatsSubset,
  ) {
  }

  isDirectory(): boolean {
    return this instanceof TreeDir;
  }

  isFile(): boolean {
    return this instanceof TreeFile;
  }
}

export class TreeFile extends TreeEntry {
  constructor(
    hash: string,
    path: string,
    stats: StatsSubset,
    public ext: string,
    public parent: TreeDir,
  ) {
    super(hash, path, stats);
  }

  toString(): string {
    if (!this.parent && this.path) {
      throw new Error('parent has no path');
    } else if (this.parent && !this.path) {
      // only the root path with no parent has no path
      throw new Error('item must have path');
    }

    const output: any = {
      hash: this.hash,
      path: this.path,
      ext: this.ext,
      stats: {
        size: this.stats.size,
        ctimeMs: this.stats.ctimeMs,
        mtimeMs: this.stats.mtimeMs,
      },
    };
    return JSON.stringify(output);
  }

  isFileModified(repo: Repository, detectionMode: DETECTIONMODE): Promise<{file : TreeFile; modified : boolean, newStats: fse.Stats}> {
    const filepath = join(repo.workdir(), this.path);
    return fse.stat(filepath).then((newStats: fse.Stats) => {
      // first we check for for modification time and file size
      if (this.stats.size !== newStats.size) {
        return { file: this, modified: true, newStats };
      }

      if (Math.floor(this.stats.mtimeMs) !== Math.floor(newStats.mtimeMs)) {
        switch (detectionMode) {
          case DETECTIONMODE.ONLY_SIZE_AND_MKTIME:
            return { file: this, modified: true, newStats };
          case DETECTIONMODE.SIZE_AND_HASH_FOR_SMALL_FILES:
            if (this.stats.size >= MB20) {
              return { file: this, modified: true, newStats };
            }
            break;
          case DETECTIONMODE.SIZE_AND_HASH_FOR_ALL_FILES:
          default:
            break;
        }

        return getPartHash(filepath)
          .then((hashBlock: HashBlock) => {
            return { file: this, modified: this.hash !== hashBlock.hash, newStats };
          });
      }

      return { file: this, modified: false, newStats };
    });
  }
}

export class TreeDir extends TreeEntry {
  static ROOT = undefined;

  hash: string;

  children: (TreeEntry)[] = [];

  constructor(public path: string,
              public stats: StatsSubset,
              public parent: TreeDir = null) {
    super('', path, stats);
  }

  static createRootTree(): TreeDir {
    return new TreeDir('', { size: 0, ctimeMs: 0, mtimeMs: 0 });
  }

  toString(includeChildren?: boolean): string {
    if (!this.parent && this.path) {
      throw new Error('parent has no path');
    } else if (this.parent && (!this.path || this.path.length === 0)) {
      // only the root path with no parent has no path
      throw new Error('item must have path');
    }

    const children: string[] = this.children.map((value: TreeDir | TreeFile) => value.toString(includeChildren));
    const stats = JSON.stringify(this.stats);
    return `{"hash": "${this.hash.toString()}", "path": "${this.path ?? ''}", "stats": ${stats}, "children": [${children.join(',')}]}`;
  }

  getAllTreeFiles(opt: {entireHierarchy: boolean, includeDirs: boolean}): Map<string, TreeEntry> {
    const visit = (obj: TreeEntry[] | TreeEntry, map: Map<string, TreeEntry>) => {
      if (Array.isArray(obj)) {
        return obj.forEach((c: any) => visit(c, map));
      }
      if (obj instanceof TreeDir) {
        if (opt.includeDirs) {
          map.set(obj.path, obj);
        }
        return (obj as TreeDir).children.forEach((c: any) => visit(c, map));
      }
      map.set(obj.path, obj);
    };

    const map: Map<string, TreeEntry> = new Map();

    if (opt.entireHierarchy) {
      visit(this.children, map);
    } else {
      this.children.forEach((o: TreeDir | TreeFile) => {
        if (o instanceof TreeFile || opt.entireHierarchy) {
          map.set(o.path, o);
        }
      });
    }
    return map;
  }

  find(relativePath: string): TreeEntry | null {
    let tree: TreeEntry | null = null;
    // TODO: (Seb) return faster if found
    TreeDir.walk(this, (entry: TreeDir | TreeFile) => {
      if (entry.path === relativePath) {
        tree = entry;
      }
    });
    return tree;
  }

  /**
   * Browse through the entire hierarchy of the tree and remove the given file.
   * Doesn't throw an error if the element is not found.
   *
   * @param relativePath      The relative file path to remove.
   */
  remove(relativePath: string): void {
    function privateDelete(
      tree: TreeDir,
      cb: (entry: TreeEntry, index: number, length: number) => boolean,
    ) {
      let i = 0;

      for (const entry of tree.children) {
        if (cb(entry, i, tree.children.length)) {
          tree.children.splice(i, 1);
          return;
        }
        if (entry.isDirectory()) {
          privateDelete(entry as TreeDir, cb);
        }
        i++;
      }
    }

    // TODO: (Seb) return faster if found
    privateDelete(this, (entry: TreeEntry): boolean => {
      if (entry.path === relativePath) {
        return true;
      }
    });
  }

  static walk(
    tree: TreeDir,
    cb: (entry: TreeDir | TreeFile, index: number, length: number) => void,
  ): void {
    let i = 0;
    for (const entry of tree.children) {
      cb(<TreeFile>entry, i, tree.children.length);
      if (entry.isDirectory()) {
        TreeDir.walk(entry as TreeDir, cb);
      }
      i++;
    }
  }
}
// This function has the same basic functioanlity as io.osWalk(..) but works with Tree
export function constructTree(
  dirPath: string,
  processed: Map<string, FileInfo>,
  tree?: TreeDir,
  root?: string,
): Promise<TreeDir> {
  if (dirPath.endsWith('/')) {
    // if directory ends with a seperator, we cut it of to ensure
    // we don't return a path like /foo/directory//file.jpg
    dirPath = dirPath.substr(0, dirPath.length - 1);
  }

  if (!root) {
    root = dirPath;
  }

  if (!tree) {
    tree = TreeDir.createRootTree();
  }

  return new Promise<string[]>((resolve, reject) => {
    fse.readdir(dirPath, (error, entries: string[]) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(entries.map(normalize));
    });
  })
    .then((entries: string[]) => {
      const promises: Promise<any>[] = [];

      for (const entry of entries) {
        if (entry === '.snow' || entry === '.git') {
          continue;
        }

        const absPath = `${dirPath}/${entry}`;
        promises.push(
          fse.stat(absPath).then((stat: fse.Stats) => {
            if (stat.isDirectory()) {
              const subtree: TreeDir = new TreeDir(
                relative(root, absPath),
                {
                  ctimeMs: stat.ctimeMs,
                  mtimeMs: stat.mtimeMs,
                  size: stat.size,
                },
                tree,
              );
              tree.children.push(subtree);
              return constructTree(absPath, processed, subtree, root);
            }
            const fileinfo: FileInfo | null = processed?.get(relative(root, absPath));
            if (fileinfo) {
              const path: string = relative(root, absPath);
              const entry: TreeFile = new TreeFile(fileinfo.hash,
                path, {
                  size: stat.size,
                  ctimeMs: stat.ctimeMs,
                  mtimeMs: stat.mtimeMs,
                }, extname(path), tree);
              tree.children.push(entry);
            } else {
              // console.warn(`No hash for ${absPath}`);
            }
          }),
        );
      }

      return Promise.all(promises);
    })
    .then(() => {
      // assign the parent 'tree' a hash of all its children
      // and calculate their size
      const hash = crypto.createHash('sha256');
      let size = 0;
      for (const r of tree.children) {
        size += r.stats.size;
        hash.update(r.hash.toString());
      }
      tree.stats.size = size;
      tree.hash = hash.digest('hex');
      return tree;
    });
}
