import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import * as cdpModule from "./cdp.service.js";

function createLogger() {
  const messages: string[] = [];
  const logger: any = {
    child: vi.fn(() => logger),
    debug: vi.fn((value: unknown) => messages.push(String(value))),
    error: vi.fn((value: unknown) => messages.push(String(value))),
    info: vi.fn((value: unknown) => messages.push(String(value))),
    warn: vi.fn((value: unknown) => messages.push(String(value))),
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

    expect(messages.join("\n")).not.toContain(profileDir);
    expect(messages).toContain("[CDPService] Dumping session data");
  });
});
