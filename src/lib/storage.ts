import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Files on disk, behind an interface — the household's convention, copied from
 * longhaul's `src/lib/storage.ts` (expense-app does the same for receipts).
 *
 * On disk rather than in Postgres, decided 2026-11-16: every nightly dump and
 * every pre-migration dump would otherwise carry every recipe photo again,
 * compressed so restic cannot deduplicate it. A bind mount under
 * `~/services/recipus/data/storage` is backed up by backrest with no change.
 * See docs/superpowers/specs/2026-11-16-recipe-file-import-design.md §5.2.
 */
export interface StorageAdapter {
  put(key: string, bytes: Buffer): Promise<void>;
  /** Rejects with `code: "ENOENT"` when the key holds nothing. */
  get(key: string): Promise<Buffer>;
  /** Removing what is not there is not an error. */
  delete(key: string): Promise<void>;
  /** The files directly under a prefix ending in "/", with their write time. */
  list(prefix: string): Promise<{ key: string; modifiedAt: Date }[]>;
}

export class LocalFSStorage implements StorageAdapter {
  constructor(private readonly root: string) {}

  /**
   * The key is ours (`sources/<uuid>.<ext>`), never a filename someone typed —
   * but the containment check stays, because a key is one refactor away from
   * being built out of something that was.
   */
  private resolve(key: string): string {
    const root = path.resolve(this.root);
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return p;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async list(prefix: string): Promise<{ key: string; modifiedAt: Date }[]> {
    const dir = this.resolve(prefix + "_").slice(0, -1);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const files = await Promise.all(
      names.map(async (name) => {
        const info = await stat(path.join(dir, name));
        return info.isFile() ? { key: prefix + name, modifiedAt: info.mtime } : null;
      }),
    );
    return files.filter((f) => f !== null);
  }
}

let current: StorageAdapter = new LocalFSStorage(
  process.env.STORAGE_DIR || "./data/storage",
);

/** The process's storage. A function, so tests can swap it underneath callers. */
export function storage(): StorageAdapter {
  return current;
}

/** Test seam: point every caller at another adapter. Returns the previous one. */
export function setStorageForTests(adapter: StorageAdapter): StorageAdapter {
  const previous = current;
  current = adapter;
  return previous;
}
