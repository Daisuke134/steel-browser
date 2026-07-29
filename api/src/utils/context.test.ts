import { describe, expect, it, vi } from "vitest";
import { SessionContextSchema } from "../services/context/types.js";
import {
  extractStorageForPage,
  groupSessionStorageByOrigin,
  handleFrameNavigated,
} from "./context.js";

const logger: any = {
  debug: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};

function extractionPage(
  requestData: (params: Record<string, unknown>) => unknown,
  url = "https://fixture.test/account",
  includeDomStorage = false,
) {
  const client = {
    detach: vi.fn(async () => undefined),
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "frame-1" } } };
      }
      if (method === "DOMStorage.getDOMStorageItems") {
        const local = Boolean((params as any)?.storageId?.isLocalStorage);
        return {
          entries: includeDomStorage
            ? [[local ? "local-key" : "session-key", local ? "local-value" : "session-value"]]
            : [],
        };
      }
      if (method === "IndexedDB.requestDatabaseNames") {
        return { databaseNames: ["proof-db"] };
      }
      if (method === "IndexedDB.requestDatabase") {
        return {
          databaseWithObjectStores: {
            name: "proof-db",
            version: 1,
            objectStores: [{
              name: "markers",
              keyPath: { type: "null" },
              autoIncrement: false,
              indexes: [],
            }],
          },
        };
      }
      if (method === "IndexedDB.requestData") return requestData(params || {});
      throw new Error(`unexpected CDP method: ${method}`);
    }),
  };
  const page: any = {
    url: () => url,
    target: () => ({ createCDPSession: async () => client }),
  };
  return { client, page };
}

const liveEntries = [{
  key: { type: "string", value: "tenant-key" },
  primaryKey: { type: "string", value: "tenant-key" },
  value: { type: "string", value: "tenant-value" },
}];

describe("IndexedDB session context fidelity", () => {
  it("requests object-store data without the indexName parameter", async () => {
    const { client, page } = extractionPage((params) => {
      if (Object.prototype.hasOwnProperty.call(params, "indexName")) {
        throw new Error("Chromium rejects indexName for object-store data requests");
      }
      return { objectStoreDataEntries: liveEntries, hasMore: false };
    });

    const context = await extractStorageForPage(page, logger);

    expect(context.indexedDB).toEqual({
      "https://fixture.test": [{
        id: 0,
        name: "proof-db",
        data: [{
          id: 0,
          name: "markers",
          records: [{
            encoding: "json_v1",
            key: "tenant-key",
            value: "tenant-value",
          }],
        }],
      }],
    });
    const request = client.send.mock.calls.find(
      ([method]) => method === "IndexedDB.requestData",
    );
    expect(request?.[1]).not.toHaveProperty("indexName");
  });

  it("exports only JSON by-value RemoteObjects and drops opaque or unserializable records", async () => {
    const entries = [
      ...liveEntries,
      {
        key: { type: "string", value: "opaque-key" },
        primaryKey: { type: "string", value: "opaque-key" },
        value: { type: "object", objectId: "runtime-handle-only" },
      },
      {
        key: { type: "string", value: "unserializable-key" },
        primaryKey: { type: "string", value: "unserializable-key" },
        value: { type: "number", unserializableValue: "NaN" },
      },
    ];
    const { page } = extractionPage(() => ({
      objectStoreDataEntries: entries,
      hasMore: false,
    }));

    const context = await extractStorageForPage(page, logger);
    const records = context.indexedDB?.["https://fixture.test"]?.[0]?.data[0]?.records;

    expect(records).toEqual([{
      encoding: "json_v1",
      key: "tenant-key",
      value: "tenant-value",
    }]);
    expect(JSON.stringify(context)).not.toContain("runtime-handle-only");
    expect(JSON.stringify(context)).not.toContain("unserializableValue");
  });

  it("keys every exported storage provider by the exact scheme, host, and port origin", async () => {
    const { page } = extractionPage(
      () => ({ objectStoreDataEntries: liveEntries, hasMore: false }),
      "https://fixture.test:8443/account",
      true,
    );

    const context = await extractStorageForPage(page, logger);

    expect(context.localStorage).toEqual({
      "https://fixture.test:8443": { "local-key": "local-value" },
    });
    expect(context.sessionStorage).toEqual({
      "https://fixture.test:8443": { "session-key": "session-value" },
    });
    expect(Object.keys(context.indexedDB || {})).toEqual([
      "https://fixture.test:8443",
    ]);
  });

  it("round-trips the exact exporter output through grouping and navigation restore", async () => {
    const { page } = extractionPage(
      () => ({ objectStoreDataEntries: liveEntries, hasMore: false }),
    );
    const exported = await extractStorageForPage(page, logger);
    const grouped = groupSessionStorageByOrigin(exported);
    const puts: Array<{ value: unknown; key: unknown }> = [];
    const objectStoreNames = new Set<string>();
    const database = {
      objectStoreNames: {
        contains: (name: string) => objectStoreNames.has(name),
      },
      createObjectStore: (name: string) => objectStoreNames.add(name),
      transaction: () => {
        const transaction: any = {
          objectStore: () => ({
            put: (value: unknown, key: unknown) => puts.push({ value, key }),
          }),
        };
        queueMicrotask(() => transaction.oncomplete?.());
        return transaction;
      },
    };
    const indexedDB = {
      open: vi.fn(() => {
        const request: any = {};
        queueMicrotask(() => {
          request.onupgradeneeded?.({ target: { result: database } });
          request.onsuccess?.({ target: { result: database } });
        });
        return request;
      }),
    };
    const frame: any = {
      parentFrame: () => null,
      url: () => "https://fixture.test/account",
      evaluate: async (callback: (...args: any[]) => unknown, ...args: any[]) => {
        const previous = globalThis.indexedDB;
        Object.defineProperty(globalThis, "indexedDB", {
          configurable: true,
          value: indexedDB,
        });
        try {
          return await callback(...args);
        } finally {
          Object.defineProperty(globalThis, "indexedDB", {
            configurable: true,
            value: previous,
          });
        }
      },
    };

    await handleFrameNavigated(frame, grouped, logger);

    expect(indexedDB.open).toHaveBeenCalledWith("proof-db", 1);
    expect(puts).toEqual([{ value: "tenant-value", key: "tenant-key" }]);
  });

  it("restores JSON records with an out-of-line raw key and unchanged raw value", async () => {
    const createdStores: Array<{ name: string; options: unknown }> = [];
    const puts: Array<{ value: unknown; key: unknown }> = [];
    const objectStoreNames = new Set<string>();
    const database = {
      objectStoreNames: {
        contains: (name: string) => objectStoreNames.has(name),
      },
      createObjectStore: (name: string, options?: unknown) => {
        objectStoreNames.add(name);
        createdStores.push({ name, options });
      },
      transaction: (_name: string, _mode: string) => {
        const transaction: any = {
          objectStore: () => ({
            put: (value: unknown, key: unknown) => puts.push({ value, key }),
          }),
        };
        queueMicrotask(() => transaction.oncomplete?.());
        return transaction;
      },
      close: vi.fn(),
    };
    const indexedDB = {
      open: vi.fn(() => {
        const request: any = {};
        queueMicrotask(() => {
          request.onupgradeneeded?.({ target: { result: database } });
          request.onsuccess?.({ target: { result: database } });
        });
        return request;
      }),
    };
    const frame: any = {
      parentFrame: () => null,
      url: () => "https://fixture.test/account",
      evaluate: async (callback: (...args: any[]) => unknown, ...args: any[]) => {
        const previous = globalThis.indexedDB;
        Object.defineProperty(globalThis, "indexedDB", {
          configurable: true,
          value: indexedDB,
        });
        try {
          return await callback(...args);
        } finally {
          Object.defineProperty(globalThis, "indexedDB", {
            configurable: true,
            value: previous,
          });
        }
      },
    };
    const storage = new Map([[
      "https://fixture.test",
      {
        indexedDB: [{
          id: 0,
          name: "proof-db",
          data: [{
            id: 0,
            name: "markers",
            records: [{
              encoding: "json_v1",
              key: "tenant-key",
              value: "tenant-value",
            }],
          }],
        }],
      },
    ]]);

    await handleFrameNavigated(frame, storage as any, logger);

    expect(createdStores).toEqual([{ name: "markers", options: undefined }]);
    expect(puts).toEqual([{ value: "tenant-value", key: "tenant-key" }]);
  });

  it("does not create a database store when every record is unsupported", async () => {
    const createdStores: string[] = [];
    const objectStoreNames = new Set<string>();
    const database = {
      objectStoreNames: { contains: (name: string) => objectStoreNames.has(name) },
      createObjectStore: (name: string) => {
        objectStoreNames.add(name);
        createdStores.push(name);
      },
      transaction: () => {
        const transaction: any = {
          objectStore: () => ({ put: vi.fn() }),
        };
        queueMicrotask(() => transaction.oncomplete?.());
        return transaction;
      },
    };
    const indexedDB = {
      open: vi.fn(() => {
        const request: any = {};
        queueMicrotask(() => {
          request.onupgradeneeded?.({ target: { result: database } });
          request.onsuccess?.({ target: { result: database } });
        });
        return request;
      }),
    };
    const frame: any = {
      parentFrame: () => null,
      url: () => "https://fixture.test/account",
      evaluate: async (callback: (...args: any[]) => unknown, ...args: any[]) => {
        const previous = globalThis.indexedDB;
        Object.defineProperty(globalThis, "indexedDB", {
          configurable: true,
          value: indexedDB,
        });
        try {
          return await callback(...args);
        } finally {
          Object.defineProperty(globalThis, "indexedDB", {
            configurable: true,
            value: previous,
          });
        }
      },
    };
    const storage = new Map([[
      "https://fixture.test",
      {
        indexedDB: [{
          id: 0,
          name: "proof-db",
          data: [{
            id: 0,
            name: "markers",
            records: [{
              key: { type: "string", value: "opaque-key" },
              value: { type: "object", objectId: "runtime-handle-only" },
            }],
          }],
        }],
      },
    ]]);

    await handleFrameNavigated(frame, storage as any, logger);

    expect(indexedDB.open).not.toHaveBeenCalled();
    expect(createdStores).toEqual([]);
  });

  it("restores legacy JSON-safe RemoteObject records without descriptor wrappers", async () => {
    const puts: Array<{ value: unknown; key: unknown }> = [];
    const objectStoreNames = new Set<string>();
    const database = {
      objectStoreNames: {
        contains: (name: string) => objectStoreNames.has(name),
      },
      createObjectStore: (name: string) => objectStoreNames.add(name),
      transaction: () => {
        const transaction: any = {
          objectStore: () => ({
            put: (value: unknown, key: unknown) => puts.push({ value, key }),
          }),
        };
        queueMicrotask(() => transaction.oncomplete?.());
        return transaction;
      },
    };
    const indexedDB = {
      open: vi.fn(() => {
        const request: any = {};
        queueMicrotask(() => {
          request.onupgradeneeded?.({ target: { result: database } });
          request.onsuccess?.({ target: { result: database } });
        });
        return request;
      }),
    };
    const frame: any = {
      parentFrame: () => null,
      url: () => "https://fixture.test/account",
      evaluate: async (callback: (...args: any[]) => unknown, ...args: any[]) => {
        const previous = globalThis.indexedDB;
        Object.defineProperty(globalThis, "indexedDB", {
          configurable: true,
          value: indexedDB,
        });
        try {
          return await callback(...args);
        } finally {
          Object.defineProperty(globalThis, "indexedDB", {
            configurable: true,
            value: previous,
          });
        }
      },
    };
    const storage = new Map([[
      "https://fixture.test",
      {
        indexedDB: [{
          id: 0,
          name: "proof-db",
          data: [{
            id: 0,
            name: "markers",
            records: [{
              key: { type: "string", value: "legacy-key" },
              value: { type: "string", value: "legacy-value" },
            }],
          }],
        }],
      },
    ]]);

    await handleFrameNavigated(frame, storage as any, logger);

    expect(puts).toEqual([{ value: "legacy-value", key: "legacy-key" }]);
  });

  it("keeps the IndexedDB JSON encoding marker through SessionContext validation", () => {
    const context = SessionContextSchema.parse({
      indexedDB: {
        "https://fixture.test": [{
          id: 0,
          name: "proof-db",
          data: [{
            id: 0,
            name: "markers",
            records: [{
              encoding: "json_v1",
              key: "tenant-key",
              value: "tenant-value",
            }],
          }],
        }],
      },
    });

    expect(context.indexedDB?.["https://fixture.test"]?.[0]
      ?.data[0]?.records[0]).toEqual({
      encoding: "json_v1",
      key: "tenant-key",
      value: "tenant-value",
    });
  });
});
