import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { CDPService } from "./cdp/cdp.service.js";
import { ShutdownReason } from "./cdp/plugins/core/base-plugin.js";
import { SessionService } from "./session.service.js";

const profileFs = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  mkdtemp: vi.fn<() => Promise<string>>(),
  rm: vi.fn<(profileDir: string, options?: Record<string, unknown>) => Promise<void>>(
    async () => undefined,
  ),
}));

vi.mock("fs/promises", () => profileFs);

const logger: any = {
  child: vi.fn(() => logger),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

function createHarness(events: string[] = []) {
  const cdpService: any = {
    captureSessionContext: vi.fn(async () => {
      events.push("capture");
    }),
    endSession: vi.fn(async () => undefined),
    getDimensions: vi.fn(() => ({ width: 1920, height: 1080 })),
    getUserAgent: vi.fn(() => "test-agent"),
    launchIdle: vi.fn(async () => {
      events.push("idle-launch");
    }),
    setSessionTerminationHandler: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    shutdownSession: vi.fn(async () => {
      events.push("shutdown");
    }),
    startNewSession: vi.fn(async () => undefined),
  };
  const seleniumService: any = {
    close: vi.fn(),
    launch: vi.fn(async () => undefined),
  };
  const service = new SessionService({
    cdpService,
    seleniumService,
    fileService: {} as any,
    logger,
  });
  const start = (sessionContext?: any, overrides: Record<string, any> = {}) =>
    service.startSession({
      blockAds: true,
      credentials: {} as any,
      sessionContext,
      timezone: "UTC",
      ...overrides,
    });
  return { cdpService, service, start };
}

describe("implicit session profile isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileFs.mkdir.mockReset().mockResolvedValue(undefined);
    profileFs.mkdtemp.mockReset();
    profileFs.rm.mockReset().mockResolvedValue(undefined);
    profileFs.mkdtemp
      .mockResolvedValueOnce("/tmp/steel-session-a")
      .mockResolvedValueOnce("/tmp/steel-idle-a")
      .mockResolvedValueOnce("/tmp/steel-session-b")
      .mockResolvedValueOnce("/tmp/steel-idle-b");
  });

  it("uses different auto-owned profile directories for sequential sessions", async () => {
    const { cdpService, service, start } = createHarness();

    await start();
    await service.endSession();
    await start();

    const first = cdpService.startNewSession.mock.calls[0][0].userDataDir;
    const second = cdpService.startNewSession.mock.calls[1][0].userDataDir;
    expect(first).toBe("/tmp/steel-session-a");
    expect(second).toBe("/tmp/steel-session-b");
    expect(second).not.toBe(first);
  });

  it("passes only the requested context into each new profile", async () => {
    const { cdpService, service, start } = createHarness();
    const firstContext = {
      cookies: [{ name: "tenant", value: "a", domain: "example.com", path: "/" }],
      localStorage: { "https://example.com": { tenant: "a" } },
    };
    const secondContext = {
      cookies: [{ name: "tenant", value: "b", domain: "example.com", path: "/" }],
      localStorage: { "https://example.com": { tenant: "b" } },
    };

    await start(firstContext);
    await service.endSession();
    await start(secondContext);

    const first = cdpService.startNewSession.mock.calls[0][0];
    const second = cdpService.startNewSession.mock.calls[1][0];
    expect(first.sessionContext).toEqual(firstContext);
    expect(second.sessionContext).toEqual(secondContext);
    expect(second.userDataDir).not.toBe(first.userDataDir);
  });

  it("deletes an auto-owned session profile after release", async () => {
    const { service, start } = createHarness();

    await start();
    await service.endSession();

    expect(profileFs.rm).toHaveBeenCalledWith(
      "/tmp/steel-session-a",
      expect.objectContaining({ force: true, recursive: true }),
    );
  });

  it("deletes an auto-owned profile when browser launch fails", async () => {
    const { cdpService, start } = createHarness();
    cdpService.startNewSession.mockRejectedValueOnce(new Error("launch failed"));

    await expect(start()).rejects.toThrow("launch failed");
    expect(profileFs.rm).toHaveBeenCalledWith(
      "/tmp/steel-session-a",
      expect.objectContaining({ force: true, recursive: true }),
    );
  });

  it("relaunches the idle browser on a different auto-owned directory", async () => {
    const { cdpService, service, start } = createHarness();

    await start();
    await service.endSession();

    expect(cdpService.captureSessionContext).toHaveBeenCalledOnce();
    expect(cdpService.shutdownSession).toHaveBeenCalledWith(ShutdownReason.SESSION_END);
    expect(cdpService.launchIdle).toHaveBeenCalledWith("/tmp/steel-idle-a");
    expect("/tmp/steel-idle-a").not.toBe("/tmp/steel-session-a");
  });

  it("captures, shuts down, deletes the live profile, then launches idle", async () => {
    const events: string[] = [];
    const { service, start } = createHarness(events);
    profileFs.rm.mockImplementation(async (profileDir) => {
      events.push(`delete:${profileDir}`);
    });

    await start();
    await service.endSession();

    expect(events).toEqual([
      "capture",
      "shutdown",
      "delete:/tmp/steel-session-a",
      "idle-launch",
    ]);
  });

  it("bounds recursive cleanup retries", async () => {
    const { service, start } = createHarness();

    await start();
    await service.endSession();

    expect(profileFs.rm).toHaveBeenCalledWith("/tmp/steel-session-a", {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100,
    });
  });

  it("does not own or delete an explicit userDataDir", async () => {
    const { cdpService, service, start } = createHarness();

    await start(undefined, { userDataDir: "/profiles/caller-owned" });
    await service.endSession();

    expect(cdpService.startNewSession.mock.calls[0][0].userDataDir).toBe(
      "/profiles/caller-owned",
    );
    expect(profileFs.rm).not.toHaveBeenCalledWith(
      "/profiles/caller-owned",
      expect.anything(),
    );
  });

  it("preserves persist as a non-owned profile", async () => {
    const { cdpService, service, start } = createHarness();

    await start(undefined, { persist: true });
    const profile = cdpService.startNewSession.mock.calls[0][0].userDataDir;
    await service.endSession();

    expect(profile).toContain("user-data-dir");
    expect(profileFs.rm).not.toHaveBeenCalledWith(profile, expect.anything());
  });

  it("cleans the owned live directory when mkdir fails", async () => {
    const { start } = createHarness();
    profileFs.mkdir.mockRejectedValueOnce(new Error("mkdir failed"));

    await expect(start()).rejects.toThrow("mkdir failed");
    expect(profileFs.rm).toHaveBeenCalledWith(
      "/tmp/steel-session-a",
      expect.objectContaining({ force: true, recursive: true }),
    );
  });

  it("never deletes a caller-owned directory when its mkdir fails", async () => {
    const { start } = createHarness();
    profileFs.mkdir.mockRejectedValueOnce(new Error("mkdir failed"));

    await expect(start(undefined, { userDataDir: "/profiles/caller-owned" })).rejects.toThrow(
      "mkdir failed",
    );
    expect(profileFs.rm).not.toHaveBeenCalledWith(
      "/profiles/caller-owned",
      expect.anything(),
    );
  });

  it("shuts down and cleans the live directory when context capture fails", async () => {
    const { cdpService, service, start } = createHarness();
    cdpService.captureSessionContext.mockRejectedValueOnce(new Error("capture failed"));

    await start();
    await expect(service.endSession()).rejects.toThrow("capture failed");

    expect(cdpService.shutdownSession).toHaveBeenCalledWith(ShutdownReason.SESSION_END);
    expect(profileFs.rm).toHaveBeenCalledWith(
      "/tmp/steel-session-a",
      expect.objectContaining({ force: true, recursive: true }),
    );
  });

  it("cleans the live directory when shutdown fails", async () => {
    const { cdpService, service, start } = createHarness();
    cdpService.shutdownSession.mockRejectedValueOnce(new Error("shutdown failed"));

    await start();
    await expect(service.endSession()).rejects.toThrow("shutdown failed");

    expect(profileFs.rm).toHaveBeenCalledWith(
      "/tmp/steel-session-a",
      expect.objectContaining({ force: true, recursive: true }),
    );
  });

  it("cleans live and idle directories and restores ownership when idle launch fails", async () => {
    const { cdpService, service, start } = createHarness();
    cdpService.launchIdle.mockRejectedValueOnce(new Error("idle failed"));

    await start();
    await expect(service.endSession()).rejects.toThrow("idle failed");

    expect(profileFs.rm).toHaveBeenCalledWith(
      "/tmp/steel-session-a",
      expect.objectContaining({ force: true, recursive: true }),
    );
    expect(profileFs.rm).toHaveBeenCalledWith(
      "/tmp/steel-idle-a",
      expect.objectContaining({ force: true, recursive: true }),
    );
    expect((service as any).ownedSessionProfileDir).toBeNull();
    expect((service as any).ownedIdleProfileDir).toBeNull();
  });

  it("does not expose an owned profile path when cleanup fails", async () => {
    const profileDir = "/tmp/steel-session-secret-cleanup";
    profileFs.mkdtemp.mockReset().mockResolvedValueOnce(profileDir);
    profileFs.rm.mockRejectedValueOnce(new Error(`cannot remove ${profileDir}/Default`));
    const { cdpService, start } = createHarness();
    cdpService.startNewSession.mockRejectedValueOnce(new Error("launch failed"));

    await expect(start()).rejects.toThrow("launch failed");

    expect(inspect(logger.error.mock.calls, { depth: null })).not.toContain(profileDir);
  });
});

function createTerminationHarness(events: string[]) {
  const cdpService = new CDPService({ keepAlive: true }, logger);
  vi.spyOn(cdpService, "startNewSession").mockResolvedValue({} as any);
  vi.spyOn(cdpService, "captureSessionContext").mockImplementation(async () => {
    events.push("capture");
  });
  vi.spyOn(cdpService, "shutdownSession").mockImplementation(async (reason) => {
    events.push(`shutdown:${reason}`);
  });
  const launchSpy = vi.spyOn(cdpService, "launch").mockImplementation(async (config) => {
    events.push(`idle-launch:${config?.userDataDir}`);
    return {} as any;
  });
  const service = new SessionService({
    cdpService,
    seleniumService: {
      close: vi.fn(),
      launch: vi.fn(async () => undefined),
    } as any,
    fileService: {} as any,
    logger,
  });
  const start = (overrides: Record<string, any> = {}) =>
    service.startSession({
      blockAds: false,
      credentials: {} as any,
      timezone: "UTC",
      ...overrides,
    });
  return { cdpService, launchSpy, service, start };
}

describe("CDP-driven session termination ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileFs.mkdir.mockReset().mockResolvedValue(undefined);
    profileFs.rm.mockReset().mockImplementation(async (profileDir) => {
      // Each test replaces the event sink below after constructing its harness.
      void profileDir;
    });
    profileFs.mkdtemp
      .mockReset()
      .mockResolvedValueOnce("/tmp/steel-session-event")
      .mockResolvedValueOnce("/tmp/steel-idle-event");
  });

  it("routes a file security violation through capture, shutdown, owned delete, and distinct idle launch", async () => {
    const events: string[] = [];
    profileFs.rm.mockImplementation(async (profileDir) => {
      events.push(`delete:${profileDir}`);
    });
    const { cdpService, launchSpy, start } = createTerminationHarness(events);

    await start();
    await (cdpService as any).handlePageRequest(
      {
        url: () => "file:///tmp/steel-session-event/Default/Cookies",
      },
      {
        close: vi.fn(async () => undefined),
      },
    );
    await vi.waitFor(() => expect(launchSpy).toHaveBeenCalled());

    expect(events).toEqual([
      "capture",
      `shutdown:${ShutdownReason.SECURITY_VIOLATION}`,
      "delete:/tmp/steel-session-event",
      "idle-launch:/tmp/steel-idle-event",
    ]);
    expect(launchSpy.mock.calls.map(([config]) => config?.userDataDir)).not.toContain(
      "/tmp/steel-chrome",
    );
  });

  it("routes browser disconnect through capture, shutdown, owned delete, and distinct idle launch", async () => {
    const events: string[] = [];
    profileFs.rm.mockImplementation(async (profileDir) => {
      events.push(`delete:${profileDir}`);
    });
    const { cdpService, launchSpy, start } = createTerminationHarness(events);

    await start();
    await (cdpService as any).onDisconnect();

    expect(events).toEqual([
      "capture",
      "shutdown:browser_disconnect",
      "delete:/tmp/steel-session-event",
      "idle-launch:/tmp/steel-idle-event",
    ]);
    expect(launchSpy.mock.calls.map(([config]) => config?.userDataDir)).not.toContain(
      "/tmp/steel-chrome",
    );
  });

  it("never deletes a caller-owned explicit profile during a security termination", async () => {
    const events: string[] = [];
    profileFs.mkdtemp.mockReset().mockResolvedValueOnce("/tmp/steel-idle-explicit");
    profileFs.rm.mockImplementation(async (profileDir) => {
      events.push(`delete:${profileDir}`);
    });
    const { cdpService, launchSpy, start } = createTerminationHarness(events);
    const callerOwned = "/profiles/caller-owned-sensitive";

    await start({ userDataDir: callerOwned });
    await (cdpService as any).handlePageRequest(
      { url: () => `file://${callerOwned}/Default/Cookies` },
      { close: vi.fn(async () => undefined) },
    );
    await vi.waitFor(() => expect(launchSpy).toHaveBeenCalled());

    expect(events).toEqual([
      "capture",
      `shutdown:${ShutdownReason.SECURITY_VIOLATION}`,
      "idle-launch:/tmp/steel-idle-explicit",
    ]);
    expect(profileFs.rm).not.toHaveBeenCalledWith(callerOwned, expect.anything());
  });

  it("coalesces a disconnect racing an explicit release into one owned lifecycle", async () => {
    const events: string[] = [];
    profileFs.rm.mockImplementation(async (profileDir) => {
      events.push(`delete:${profileDir}`);
    });
    const { cdpService, launchSpy, service, start } = createTerminationHarness(events);
    const captureGate = Promise.withResolvers<void>();
    vi.mocked(cdpService.captureSessionContext).mockImplementation(async () => {
      events.push("capture");
      await captureGate.promise;
    });

    await start();
    const explicitRelease = service.endSession();
    const disconnectRelease = (cdpService as any).onDisconnect();
    await vi.waitFor(() => {
      expect(cdpService.captureSessionContext).toHaveBeenCalled();
    });
    captureGate.resolve();
    await Promise.all([explicitRelease, disconnectRelease]);

    expect(events).toEqual([
      "capture",
      `shutdown:${ShutdownReason.SESSION_END}`,
      "delete:/tmp/steel-session-event",
      "idle-launch:/tmp/steel-idle-event",
    ]);
    expect(cdpService.captureSessionContext).toHaveBeenCalledOnce();
    expect(profileFs.rm).toHaveBeenCalledOnce();
    expect(launchSpy).toHaveBeenCalledOnce();
  });
});
