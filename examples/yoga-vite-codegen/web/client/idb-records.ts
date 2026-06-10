import type { GraphDataRecord, GraphDataRecordMap, GraphDataRecords } from "@gqlens/core";

const databaseName = "gqlens-yoga-vite-codegen";
const databaseVersion = 1;
const objectStoreName = "graph-records";
const staleExpires = 1;

type RecordBucket = "fields" | "slots";

export interface CacheRestoreSummary {
  readonly fields: number;
  readonly slots: number;
}

export interface IndexedDBGraphDataRecords {
  readonly records: GraphDataRecords;
  readonly restored: CacheRestoreSummary;
  clearStorage(): Promise<void>;
}

interface PersistedGraphDataRecord {
  readonly id: string;
  readonly bucket: RecordBucket;
  readonly key: string;
  readonly record: GraphDataRecord;
}

export async function createIndexedDBGraphDataRecords(): Promise<IndexedDBGraphDataRecords> {
  if (!globalThis.indexedDB) {
    return createMemoryGraphDataRecords();
  }

  const db = await openDatabase();
  const restored = await readRecords(db);
  const fields = new PersistedRecordMap(db, "fields", restored.fields);
  const slots = new PersistedRecordMap(db, "slots", restored.slots);

  return {
    records: { fields, slots },
    restored: {
      fields: restored.fields.size,
      slots: restored.slots.size,
    },
    clearStorage: () => clearDatabase(db),
  };
}

function createMemoryGraphDataRecords(): IndexedDBGraphDataRecords {
  return {
    records: {
      fields: new Map<string, GraphDataRecord>(),
      slots: new Map<string, GraphDataRecord>(),
    },
    restored: { fields: 0, slots: 0 },
    clearStorage: async () => undefined,
  };
}

class PersistedRecordMap implements GraphDataRecordMap {
  readonly #db: IDBDatabase;
  readonly #bucket: RecordBucket;
  readonly #records: Map<string, GraphDataRecord>;

  constructor(db: IDBDatabase, bucket: RecordBucket, records: Map<string, GraphDataRecord>) {
    this.#db = db;
    this.#bucket = bucket;
    this.#records = records;
  }

  get(key: string): GraphDataRecord | undefined {
    return this.#records.get(key);
  }

  set(key: string, record: GraphDataRecord): void {
    this.#records.set(key, record);
    persist(() => putRecord(this.#db, this.#bucket, key, record));
  }

  delete(key: string): boolean {
    const deleted = this.#records.delete(key);
    if (deleted) {
      persist(() => deleteRecord(this.#db, this.#bucket, key));
    }
    return deleted;
  }

  clear(): void {
    if (this.#records.size === 0) {
      return;
    }
    this.#records.clear();
    persist(() => clearBucket(this.#db, this.#bucket));
  }

  entries(): Iterable<readonly [string, GraphDataRecord]> {
    return this.#records.entries();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(objectStoreName)) {
        db.createObjectStore(objectStoreName, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readRecords(db: IDBDatabase): Promise<{
  readonly fields: Map<string, GraphDataRecord>;
  readonly slots: Map<string, GraphDataRecord>;
}> {
  const rows = await requestToPromise<PersistedGraphDataRecord[]>(
    db.transaction(objectStoreName, "readonly").objectStore(objectStoreName).getAll(),
  );
  const fields = new Map<string, GraphDataRecord>();
  const slots = new Map<string, GraphDataRecord>();

  for (const row of rows) {
    const target = row.bucket === "fields" ? fields : slots;
    target.set(row.key, { value: row.record.value, expires: staleExpires });
  }

  return { fields, slots };
}

function putRecord(
  db: IDBDatabase,
  bucket: RecordBucket,
  key: string,
  record: GraphDataRecord,
): Promise<void> {
  const tx = db.transaction(objectStoreName, "readwrite");
  tx.objectStore(objectStoreName).put({
    id: recordId(bucket, key),
    bucket,
    key,
    record,
  } satisfies PersistedGraphDataRecord);
  return transactionDone(tx);
}

function deleteRecord(db: IDBDatabase, bucket: RecordBucket, key: string): Promise<void> {
  const tx = db.transaction(objectStoreName, "readwrite");
  tx.objectStore(objectStoreName).delete(recordId(bucket, key));
  return transactionDone(tx);
}

function clearBucket(db: IDBDatabase, bucket: RecordBucket): Promise<void> {
  const tx = db.transaction(objectStoreName, "readwrite");
  const store = tx.objectStore(objectStoreName);
  const request = store.openCursor();

  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      return;
    }
    const row = cursor.value as PersistedGraphDataRecord;
    if (row.bucket === bucket) {
      cursor.delete();
    }
    cursor.continue();
  };

  return transactionDone(tx);
}

function clearDatabase(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(objectStoreName, "readwrite");
  tx.objectStore(objectStoreName).clear();
  return transactionDone(tx);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
  });
}

function recordId(bucket: RecordBucket, key: string): string {
  return `${bucket}:${key}`;
}

function persist(run: () => Promise<void>): void {
  void run().catch((error: unknown) => {
    console.warn("[gqlens example] Failed to persist cache record.", error);
  });
}
