import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeContextService } from "../context/chrome-context.service.js";
import { ChromeLocalStorageReader } from "../leveldb/localstorage.js";
import { ChromeSessionStorageReader } from "../leveldb/sessionstorage.js";
import { BasePlugin, ShutdownReason } from "./plugins/core/base-plugin.js";
import * as cdpModule from "./cdp.service.js";

function createLogger() {
  const messages: unknown[] = [];
  const logger: any = {
    child: vi.fn(() => logger),
    debug: vi.fn((...values: unknown[]) => messages.push(...values)),
    error: vi.fn((...values: unknown[]) => messages.push(...values)),
    info: vi.fn((...values: unknown[]) => messages.push(...values)),
    warn: vi.fn((...values: unknown[]) => messages.push(...values)),
  };
  return { logger, messages };
}

function expectNoProfilePath(messages: unknown[], profileDir: string) {
  const logged = inspect(messages, { depth: null });
  expect(logged).not.toContain(profileDir);
  expect(logged).not.toContain(path.basename(profileDir));
  expect(logged).not.toContain("Default/Local Storage/leveldb");
  expect(logged).not.toContain("Default/Session Storage");
}

describe("CDP profile path log safety", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["auto-owned temporary", "/tmp/steel-session-secret-context"],
    ["caller-owned explicit", "/profiles/caller-owned-secret-context"],
  ])(
    "real ChromeContextService redacts %s paths and path-bearing extraction failures",
    async (_kind, profileDir) => {
      const { logger, messages } = createLogger();
      const service = new ChromeContextService(logger);
      vi.spyOn(ChromeLocalStorageReader, "readLocalStorage").mockRejectedValueOnce(
        new Error(`cannot open ${profileDir}/Default/Local Storage/leveldb/LOG`, {
          cause: new Error(`leveldb cause at ${profileDir}`),
        }),
      );
      vi.spyOn(ChromeSessionStorageReader, "readSessionStorage").mockRejectedValueOnce(
        new Error(`cannot open ${profileDir}/Default/Session Storage/CURRENT`, {
          cause: new Error(`session cause at ${profileDir}`),
        }),
      );

      await expect(service.getSessionData(profileDir)).resolves.toEqual({});

      expectNoProfilePath(messages, profileDir);
    },
  );

  it("redacts path-bearing plugin and shutdown failures without replacing ChromeContextService", async () => {
    const { logger, messages } = createLogger();
    const service = new cdpModule.CDPService({ keepAlive: true }, logger);
    const profileDir = "/tmp/steel-session-secret-shutdown";

    class PathFailurePlugin extends BasePlugin {
      public override async onShutdown(): Promise<void> {
        throw new Error(`plugin failed at ${profileDir}/Default`, {
          cause: new Error(`plugin cause at ${profileDir}`),
        });
      }
    }

    service.registerPlugin(new PathFailurePlugin({ name: "path-failure" }));
    service.registerShutdownHook(async () => {
      throw new Error(`shutdown failed at ${profileDir}/Default`, {
        cause: new Error(`shutdown cause at ${profileDir}`),
      });
    });

    await expect(service.shutdown(ShutdownReason.SESSION_END)).rejects.toThrow();

    expect((service as any).chromeSessionService).toBeInstanceOf(ChromeContextService);
    expectNoProfilePath(messages, profileDir);
  });

  it("redacts temporary and caller-owned userDataDir values from launch logs", () => {
    const redact = (cdpModule as any).redactLaunchOptionsForLog;
    expect(redact).toBeTypeOf("function");
    if (typeof redact !== "function") return;

    for (const profileDir of [
      "/tmp/steel-session-secret-tenant",
      "/profiles/caller-owned-sensitive",
    ]) {
      const logged = JSON.stringify(
        redact({
          args: ["--headless"],
          executablePath: "/usr/bin/chromium",
          userDataDir: profileDir,
        }),
      );
      expect(logged).not.toContain(profileDir);
      expect(logged).toContain("[redacted]");
    }
  });

  it("uses the redacted launch options at the logger boundary", async () => {
    const source = await readFile(new URL("./cdp.service.ts", import.meta.url), "utf8");
    expect(source).toContain("redactLaunchOptionsForLog(finalLaunchOptions)");
    expect(source).not.toContain("JSON.stringify(finalLaunchOptions, null, 2)");
  });

  it("never logs the profile path while extracting browser state", async () => {
    const { logger, messages } = createLogger();
    const service = new cdpModule.CDPService({ keepAlive: true }, logger);
    const profileDir = "/tmp/steel-session-secret-tenant";

    (service as any).browserInstance = {};
    (service as any).primaryPage = {};
    (service as any).launchConfig = { options: {}, userDataDir: profileDir };
    (service as any).chromeSessionService = {
      getSessionData: vi.fn(async () => ({})),
    };
    (service as any).getExistingPageSessionData = vi.fn(async () => ({}));
    vi.spyOn(service, "getCookies").mockResolvedValue([]);

    await service.getBrowserState();

    expect(inspect(messages, { depth: null })).not.toContain(profileDir);
    expect(messages).toContain("[CDPService] Dumping session data");
  });

  it.each([
    ["auto-owned temporary", "/tmp/steel-session-secret-tenant"],
    ["caller-owned explicit", "/profiles/caller-owned-sensitive"],
  ])(
    "redacts %s profile paths from browser-state failure logs",
    async (_kind, profileDir) => {
      const { logger, messages } = createLogger();
      const service = new cdpModule.CDPService({ keepAlive: true }, logger);

      (service as any).browserInstance = {};
      (service as any).primaryPage = {};
      (service as any).launchConfig = { options: {}, userDataDir: profileDir };
      (service as any).chromeSessionService = {
        getSessionData: vi.fn(async () => {
          throw new Error(`failed to read ${profileDir}/Default/Cookies`);
        }),
      };
      (service as any).getExistingPageSessionData = vi.fn(async () => ({}));
      vi.spyOn(service, "getCookies").mockResolvedValue([]);

      await service.getBrowserState();

      const logged = inspect(messages, { depth: null });
      expect(logged).not.toContain(profileDir);
      expect(logged).toContain("[CDPService] Error dumping session data");
    },
  );

  it.each([
    ["auto-owned temporary", "/tmp/steel-session-secret-tenant"],
    ["caller-owned explicit", "/profiles/caller-owned-sensitive"],
  ])("redacts %s profile paths from file-protocol security logs", async (_kind, profileDir) => {
    const { logger, messages } = createLogger();
    const service = new cdpModule.CDPService({ keepAlive: true }, logger);
    service.setSessionTerminationHandler(async () => undefined);

    await (service as any).handlePageRequest(
      { url: () => `file://${profileDir}/Default/Cookies` },
      { close: vi.fn(async () => undefined) },
    );

    const logged = inspect(messages, { depth: null });
    expect(logged).not.toContain(profileDir);
    expect(logged).toContain("[CDPService] Blocked request from file protocol");
  });
});
