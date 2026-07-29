import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Id, SyncState } from "@/lib/domain";
import type { Op } from "@/lib/sync";

/**
 * The IndexedDB schema and connection.
 *
 * One database for the whole app. `state` and `meta` are keyed one row per
 * list, so switching lists never needs a schema change. `outbox` is a single
 * cross-list FIFO queue — an op already carries the list it concerns in its
 * own payload, so partitioning the queue by list would buy nothing and would
 * complicate flushing.
 */

const DB_NAME = "recipus";
const DB_VERSION = 1;

export interface StateRecord {
  listId: Id;
  state: SyncState;
}

export interface SyncMeta {
  listId: Id;
  /** Server op `seq` this list has fully caught up to. Null before first hydration. */
  cursor: number | null;
  /** ISO timestamp of the last full hydration from a `ListSnapshot`. */
  lastHydratedAt: string | null;
}

export interface OutboxRecord {
  /** Local autoIncrement key. Its ascending order IS the FIFO order — see outbox.ts. */
  localSeq?: number;
  clientOpId: string;
  op: Op;
}

interface RecipusDB extends DBSchema {
  state: {
    key: Id;
    value: StateRecord;
  };
  meta: {
    key: Id;
    value: SyncMeta;
  };
  outbox: {
    key: number;
    value: OutboxRecord;
    indexes: { "by-clientOpId": string };
  };
}

let dbPromise: Promise<IDBPDatabase<RecipusDB>> | null = null;

/**
 * Bump-safe upgrade.
 *
 * Each `if (oldVersion < N)` block only ever adds what version N introduced,
 * gated on the version the client is coming FROM. A client that has been
 * closed for months and skips straight from 1 to 4 runs blocks 2, 3 and 4 in
 * one open; a client already on the latest version runs nothing. Never
 * rewrite an old block once shipped — add a new one.
 */
function upgrade(db: IDBPDatabase<RecipusDB>, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore("state", { keyPath: "listId" });
    db.createObjectStore("meta", { keyPath: "listId" });
    const outbox = db.createObjectStore("outbox", {
      keyPath: "localSeq",
      autoIncrement: true,
    });
    outbox.createIndex("by-clientOpId", "clientOpId", { unique: true });
  }
}

function assertIndexedDbAvailable(): void {
  if (typeof indexedDB === "undefined") {
    throw new Error(
      "IndexedDB is not available in this environment (server render or " +
        "non-browser context) — client-store calls must be deferred to an " +
        "effect, not made during render.",
    );
  }
}

/** Single cached connection, opened lazily on first use. */
export function getDb(): Promise<IDBPDatabase<RecipusDB>> {
  assertIndexedDbAvailable();
  if (!dbPromise) {
    dbPromise = openDB<RecipusDB>(DB_NAME, DB_VERSION, { upgrade });
  }
  return dbPromise;
}

/** Closes the cached connection. Real apps rarely need this; tests do, to simulate a reload. */
export async function closeDb(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}

/** Test-only: wipes the database so each test starts from a clean slate. */
export async function deleteDb(): Promise<void> {
  await closeDb();
  await deleteDB(DB_NAME);
}

export async function loadState(listId: Id): Promise<SyncState | null> {
  const db = await getDb();
  const row = await db.get("state", listId);
  return row?.state ?? null;
}

export async function saveState(listId: Id, state: SyncState): Promise<void> {
  const db = await getDb();
  await db.put("state", { listId, state });
}

export async function loadMeta(listId: Id): Promise<SyncMeta | null> {
  const db = await getDb();
  const row = await db.get("meta", listId);
  return row ?? null;
}

export async function saveMeta(meta: SyncMeta): Promise<void> {
  const db = await getDb();
  await db.put("meta", meta);
}

export type { RecipusDB };
