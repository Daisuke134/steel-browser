import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
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

describe("CDP profile path log safety", () => {
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
