import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  MaxforgeWebSocketBridge,
  parseBridgeEvent,
} from "../src/mcp/bridge.js";
import {
  MaxforgePatchRegistration,
  MaxforgeSnapshotEvent,
} from "../src/max/patch-protocol.js";
import {
  createEmptyPatchGraph,
  diffPatchGraphs,
} from "../src/max/patch-graph.js";
import {
  EditHistoryStore,
  JsonLinesEditHistoryStore,
} from "../src/mcp/edit-history-store.js";

const bridges: MaxforgeWebSocketBridge[] = [];
const clients: WebSocket[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.allSettled(bridges.splice(0).map((bridge) => bridge.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MaxforgeWebSocketBridge", () => {
  it("registers multiple patches and routes apply to the selected patcherId", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const first = await connect(status.port);
    const second = await connect(status.port);
    await register(bridge, first, registration("patch-a", "voices", true));
    await register(bridge, second, registration("patch-b", "meters", false));
    const plan = {
      ...diffPatchGraphs(
        createEmptyPatchGraph("meters"),
        createEmptyPatchGraph("meters")
      ),
      baseStructureToken: "f".repeat(16),
    };

    const unexpected = new Promise<never>((_, reject) => {
      first.once("message", () => reject(new Error("apply reached patch-a")));
    });
    second.once("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        type: string;
        requestId: string;
        patcherId: string;
        plan: unknown;
      };
      expect(request).toMatchObject({
        type: "maxforge.apply.request",
        patcherId: "patch-b",
        plan,
      });
      second.send(JSON.stringify({
        type: "maxforge.applied",
        requestId: request.requestId,
        patcherId: "patch-b",
        scope: plan.scope,
        revision: plan.targetRevision,
        operations: plan.operations.length,
      }));
    });

    await expect(Promise.race([
      bridge.apply("patch-b", plan),
      unexpected,
    ])).resolves.toMatchObject({
      type: "maxforge.applied",
      patcherId: "patch-b",
      scope: "meters",
      revision: plan.targetRevision,
    });
    expect(bridge.getLiveRevision("patch-b", "meters"))
      .toBe(plan.targetRevision);
    expect(bridge.listPatches().map((patch) => patch.patcherId))
      .toEqual(["patch-a", "patch-b"]);
  });

  it("cleans up a timed-out apply and ignores its late acknowledgement", async () => {
    const bridge = createBridge(undefined, 30);
    const status = await bridge.start();
    const client = await connect(status.port);
    await register(bridge, client, registration("patch-a", "voices", false));
    const requestPromise = new Promise<{
      requestId: string;
      patcherId: string;
      plan: ReturnType<typeof diffPatchGraphs>;
    }>((resolveRequest) => {
      client.once("message", (data) => resolveRequest(JSON.parse(data.toString())));
    });
    const plan = diffPatchGraphs(
      createEmptyPatchGraph("voices"),
      createEmptyPatchGraph("voices")
    );
    const applying = bridge.apply("patch-a", plan);
    const request = await requestPromise;

    await expect(applying).rejects.toThrow("Timed out waiting for Max patch");
    expect(bridge.getPendingOperationCount()).toBe(0);
    expect(bridge.getLiveRevision("patch-a", "voices")).toBeNull();

    client.send(JSON.stringify({
      type: "maxforge.applied",
      requestId: request.requestId,
      patcherId: request.patcherId,
      scope: request.plan.scope,
      revision: request.plan.targetRevision,
      operations: request.plan.operations.length,
    }));
    await websocketRoundTrip(client);
    expect(bridge.getLiveRevision("patch-a", "voices")).toBeNull();

    client.once("message", (data) => {
      const inspection = JSON.parse(data.toString());
      client.send(JSON.stringify({
        ...snapshotEvent(inspection.requestId),
        patcherId: inspection.patcherId,
        scope: inspection.scope,
      }));
    });
    await expect(bridge.inspect("patch-a", "voices")).resolves.toMatchObject({
      type: "maxforge.snapshot",
    });
  });

  it("correlates errors and inspections per patch", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const client = await connect(status.port);
    await register(bridge, client, registration("patch-a", "voices", true));

    client.once("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        requestId: string;
      };
      client.send(JSON.stringify({
        type: "maxforge.snapshot",
        requestId: request.requestId,
        patcherId: "patch-a",
        scope: "voices",
        revision: null,
        structureToken: "0".repeat(16),
        patcher: snapshotEvent("unused").patcher,
      }));
    });

    await expect(bridge.inspect("patch-a", "voices")).resolves.toMatchObject({
      type: "maxforge.snapshot",
      patcherId: "patch-a",
      scope: "voices",
      patcher: {
        boxes: [{ text: "cycle~ 440" }],
      },
    });

    const plan = diffPatchGraphs(
      createEmptyPatchGraph("voices"),
      createEmptyPatchGraph("voices")
    );
    client.once("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        requestId: string;
      };
      client.send(JSON.stringify({
        type: "maxforge.error",
        requestId: request.requestId,
        patcherId: "patch-a",
        scope: "voices",
        message: "base revision does not match current revision",
      }));
    });

    await expect(bridge.apply("patch-a", plan)).rejects.toThrow(
      'Max patch "patch-a" rejected request'
    );
  });

  it("creates a top-level patch through the controller and waits for registration", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const controller = await connect(status.port);
    await register(
      bridge,
      controller,
      registration("bridge", "bootstrap", true)
    );

    controller.once("message", async (data) => {
      const request = JSON.parse(data.toString()) as {
        type: string;
        requestId: string;
        patcherId: string;
        scope: string;
        title: string;
      };
      expect(request).toMatchObject({
        type: "maxforge.create_patch.request",
        patcherId: "generated-a",
        scope: "voices",
        title: "Generated voices",
      });
      expect(request).not.toHaveProperty("host");
      expect(request).not.toHaveProperty("port");
      controller.send(JSON.stringify({
        type: "maxforge.patch.created",
        requestId: request.requestId,
        patcherId: request.patcherId,
        scope: request.scope,
      }));

      const generated = await connect(status.port);
      await register(
        bridge,
        generated,
        registration("generated-a", "voices", false, "Generated voices")
      );
    });

    await expect(bridge.createPatch({
      patcherId: "generated-a",
      scope: "voices",
      title: "Generated voices",
    })).resolves.toMatchObject({
      patcherId: "generated-a",
      scope: "voices",
      title: "Generated voices",
      controller: false,
    });
  });

  it("opens an existing patch through the controller and waits for registration", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const controller = await connect(status.port);
    await register(
      bridge,
      controller,
      registration("bridge", "bootstrap", true)
    );

    controller.once("message", async (data) => {
      const request = JSON.parse(data.toString()) as {
        type: string;
        requestId: string;
        patcherId: string;
        scope: string;
        path: string;
      };
      expect(request).toMatchObject({
        type: "maxforge.open_patch.request",
        patcherId: "opened-a",
        scope: "voices",
        path: "/tmp/source.maxpat",
      });
      expect(request).not.toHaveProperty("host");
      expect(request).not.toHaveProperty("port");
      controller.send(JSON.stringify({
        type: "maxforge.patch.opened",
        requestId: request.requestId,
        patcherId: request.patcherId,
        scope: request.scope,
      }));

      const opened = await connect(status.port);
      await register(
        bridge,
        opened,
        {
          ...registration("opened-a", "voices", false, "Opened voices"),
          filename: "source.maxpat",
          filepath: "/tmp/source.maxpat",
        }
      );
    });

    await expect(bridge.openPatch({
      patcherId: "opened-a",
      scope: "voices",
      title: "Opened voices",
      path: "/tmp/source.maxpat",
    })).resolves.toMatchObject({
      patcherId: "opened-a",
      filename: "source.maxpat",
      filepath: "/tmp/source.maxpat",
    });
  });

  it("routes save and close operations and updates registration metadata", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const client = await connect(status.port);
    await register(bridge, client, registration("patch-a", "voices", false));

    client.once("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        type: string;
        requestId: string;
        patcherId: string;
        scope: string;
        path: string;
        overwrite: boolean;
      };
      expect(request).toMatchObject({
        type: "maxforge.save_patch.request",
        path: "/tmp/saved.maxpat",
        overwrite: true,
      });
      client.send(JSON.stringify({
        type: "maxforge.patch.saved",
        requestId: request.requestId,
        patcherId: request.patcherId,
        scope: request.scope,
        filename: "saved.maxpat",
        filepath: "/tmp/saved.maxpat",
        dirty: false,
      }));
    });

    await expect(bridge.savePatch({
      patcherId: "patch-a",
      scope: "voices",
      path: "/tmp/saved.maxpat",
      overwrite: true,
    })).resolves.toMatchObject({
      type: "maxforge.patch.saved",
      filepath: "/tmp/saved.maxpat",
      dirty: false,
    });
    expect(bridge.listPatches()[0]).toMatchObject({
      filename: "saved.maxpat",
      filepath: "/tmp/saved.maxpat",
    });

    client.once("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        requestId: string;
        patcherId: string;
        scope: string;
        discard: boolean;
      };
      client.send(JSON.stringify({
        type: "maxforge.patch.closing",
        requestId: request.requestId,
        patcherId: request.patcherId,
        scope: request.scope,
        discarded: request.discard,
      }));
    });

    await expect(bridge.closePatch({
      patcherId: "patch-a",
      scope: "voices",
      discard: true,
    })).resolves.toMatchObject({ discarded: true });
    expect(bridge.listPatches()).toEqual([]);
  });

  it("validates Max-host patch paths before sending file requests", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const controller = await connect(status.port);
    await register(
      bridge,
      controller,
      registration("bridge", "bootstrap", true)
    );

    await expect(bridge.openPatch({
      patcherId: "opened-a",
      scope: "voices",
      title: "Opened voices",
      path: "relative.maxpat",
    })).rejects.toThrow("absolute on the Max host");
    await expect(bridge.openPatch({
      patcherId: "opened-a",
      scope: "voices",
      title: "Opened voices",
      path: "/tmp/source.txt",
    })).rejects.toThrow("end with .maxpat");
  });

  it("removes only the disconnected patch registration", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const first = await connect(status.port);
    const second = await connect(status.port);
    await register(bridge, first, registration("patch-a", "voices", true));
    await register(bridge, second, registration("patch-b", "meters", false));

    second.close();
    await waitFor(() => bridge.listPatches().length === 1);

    expect(bridge.listPatches()).toMatchObject([
      { patcherId: "patch-a", scope: "voices" },
    ]);
    expect(bridge.getStatus()).toMatchObject({
      connectedClients: 1,
      registeredPatches: [{ patcherId: "patch-a" }],
    });
  });

  it("refuses unknown targets and creation without one controller", async () => {
    const bridge = createBridge();
    await bridge.start();
    const plan = diffPatchGraphs(
      createEmptyPatchGraph("voices"),
      createEmptyPatchGraph("voices")
    );

    await expect(bridge.apply("missing", plan)).rejects.toThrow(
      'Max patch "missing" is not registered'
    );
    await expect(bridge.createPatch({
      patcherId: "generated-a",
      scope: "voices",
      title: "Generated voices",
    })).rejects.toThrow("Exactly one patch-creation controller is required");
  });

  it("requires a token for non-loopback binding", () => {
    expect(
      () => new MaxforgeWebSocketBridge({ host: "0.0.0.0" })
    ).toThrow('WebSocket token is required for non-loopback host "0.0.0.0"');
    expect(
      () => new MaxforgeWebSocketBridge({ host: "localhost" })
    ).toThrow('WebSocket token is required for non-loopback host "localhost"');
  });

  it("authenticates clients when a LAN token is configured", async () => {
    const bridge = new MaxforgeWebSocketBridge({
      host: "0.0.0.0",
      port: 0,
      token: "studio-session_1",
      applyTimeoutMs: 1000,
    });
    bridges.push(bridge);
    const status = await bridge.start();

    const authenticated = await connect(status.port);
    authenticated.send(JSON.stringify({
      type: "maxforge.authenticate",
      token: "studio-session_1",
    }));
    await register(
      bridge,
      authenticated,
      registration("patch-a", "voices", true)
    );
    expect(bridge.listPatches()).toHaveLength(1);

    const rejected = await connect(status.port);
    const closed = new Promise<number>((resolve) => {
      rejected.once("close", (code) => resolve(code));
    });
    rejected.send(JSON.stringify({
      type: "maxforge.authenticate",
      token: "wrong-token",
    }));
    await expect(closed).resolves.toBe(1008);

    const unauthenticated = await connect(status.port);
    const unauthenticatedClosed = new Promise<number>((resolve) => {
      unauthenticated.once("close", (code) => resolve(code));
    });
    unauthenticated.send(JSON.stringify(
      registration("patch-b", "voices", false)
    ));
    await expect(unauthenticatedClosed).resolves.toBe(1008);
    expect(bridge.listPatches()).toHaveLength(1);
  });

  it("rejects invalid token characters", () => {
    expect(
      () => new MaxforgeWebSocketBridge({ token: "contains spaces" })
    ).toThrow("WebSocket token must contain 1 to 256 URL-safe characters");
  });

  it("retains bounded edit observations only for their registered patch", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const first = await connect(status.port);
    const second = await connect(status.port);
    await register(bridge, first, registration("patch-a", "voices", false));
    await register(bridge, second, registration("patch-b", "meters", false));

    first.send(JSON.stringify(editObservation("patch-a", "voices", {
      causes: ["box"],
    })));
    second.send(JSON.stringify(editObservation("patch-b", "meters", {
      causes: ["line"],
    })));
    await waitFor(() =>
      bridge.getEditObservationHistory("patch-a", "voices")
        .observations.length === 1
    );

    expect(bridge.getEditObservationHistory("patch-a", "voices"))
      .toMatchObject({
        supported: true,
        droppedEvents: 0,
        observations: [{
          sequence: expect.any(Number),
          sessionSequence: 1,
          sessionId: expect.any(String),
          instanceId: "instance_patch-a",
          sessionStartedAt: expect.any(String),
          observedAt: expect.any(String),
          event: { causes: ["box"] },
        }],
      });
    expect(bridge.getEditObservationHistory("patch-b", "meters"))
      .toMatchObject({ observations: [{ event: { causes: ["line"] } }] });
  });

  it("restores project-scoped edit observations after bridge restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-bridge-history-"));
    temporaryDirectories.push(directory);
    const firstStore = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    const firstBridge = createBridge(firstStore);
    const firstStatus = await firstBridge.start();
    const firstClient = await connect(firstStatus.port);
    await register(
      firstBridge,
      firstClient,
      registration("patch-a", "voices", false)
    );
    firstClient.send(JSON.stringify(editObservation("patch-a", "voices", {
      causes: ["box"],
    })));
    await waitFor(() =>
      firstBridge.getEditObservationHistory("patch-a", "voices")
        .observations.length === 1
    );
    const original = firstBridge.getEditObservationHistory("patch-a", "voices")
      .observations[0];
    firstClient.terminate();
    await waitFor(() => firstBridge.listPatches().length === 0);
    await firstBridge.close();

    const secondStore = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    const secondBridge = createBridge(secondStore);
    const secondStatus = await secondBridge.start();
    const secondClient = await connect(secondStatus.port);
    await register(
      secondBridge,
      secondClient,
      registration("patch-a", "voices", false)
    );

    expect(secondBridge.getEditObservationHistory("patch-a", "voices"))
      .toMatchObject({
        persistence: {
          enabled: true,
          projectId: "studio_patchset",
          location: directory,
          warnings: [],
        },
        observations: [{
          sequence: original.sequence,
          sessionId: original.sessionId,
          event: { causes: ["box"] },
        }],
      });
  });

  it("enforces one active bridge writer per project history directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-bridge-writer-"));
    temporaryDirectories.push(directory);
    const firstBridge = createBridge(new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    }));
    const secondBridge = createBridge(new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    }));

    await firstBridge.start();
    await expect(secondBridge.start()).rejects.toThrow(
      "already has an active writer lease"
    );
    await firstBridge.close();
    await expect(secondBridge.start()).resolves.toMatchObject({
      editHistoryPersistence: {
        enabled: true,
        projectId: "studio_patchset",
      },
    });
  });

  it("queries original evidence through an explicitly rekeyed history identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maxforge-bridge-rekey-"));
    temporaryDirectories.push(directory);
    const firstStore = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    const firstBridge = createBridge(firstStore);
    const firstStatus = await firstBridge.start();
    const firstClient = await connect(firstStatus.port);
    await register(
      firstBridge,
      firstClient,
      registration("patch-a", "voices", false)
    );
    firstClient.send(JSON.stringify(editObservation("patch-a", "voices", {
      causes: ["box"],
    })));
    await waitFor(() =>
      firstBridge.getEditObservationHistory("patch-a", "voices")
        .observations.length === 1
    );
    firstClient.terminate();
    await waitFor(() => firstBridge.listPatches().length === 0);
    await firstBridge.close();

    firstStore.resolvePatchIdentity({
      action: "rekey",
      expectedProjectId: "studio_patchset",
      source: { patcherId: "patch-a", scope: "voices" },
      target: { patcherId: "patch-renamed", scope: "voices" },
      reason: "The Max object was deliberately renamed",
    });

    const secondStore = new JsonLinesEditHistoryStore({
      directory,
      project: { id: "studio_patchset" },
    });
    const secondBridge = createBridge(secondStore);
    const secondStatus = await secondBridge.start();
    const secondClient = await connect(secondStatus.port);
    await register(
      secondBridge,
      secondClient,
      registration("patch-renamed", "voices", false)
    );

    expect(secondBridge.getEditObservationHistory("patch-renamed", "voices"))
      .toMatchObject({
        identity: {
          canonical: { patcherId: "patch-renamed", scope: "voices" },
          aliases: [{ patcherId: "patch-a", scope: "voices" }],
        },
        patchMetadata: [
          expect.objectContaining({ patcherId: "patch-a" }),
          expect.objectContaining({ patcherId: "patch-renamed" }),
        ],
        observations: [{ event: { patcherId: "patch-a", causes: ["box"] } }],
      });
  });

  it("ignores edit observations from mismatched or incapable clients", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const capable = await connect(status.port);
    await register(bridge, capable, registration("patch-a", "voices", false));

    capable.send(JSON.stringify(editObservation("patch-a", "wrong", {})));
    await websocketRoundTrip(capable);
    expect(bridge.getEditObservationHistory("patch-a", "voices").observations)
      .toEqual([]);

    const incapable = await connect(status.port);
    await register(
      bridge,
      incapable,
      { ...registration("patch-b", "meters", false), capabilities: [] }
    );
    incapable.send(JSON.stringify(editObservation("patch-b", "meters", {})));
    await websocketRoundTrip(incapable);
    expect(bridge.getEditObservationHistory("patch-b", "meters"))
      .toMatchObject({
        supported: false,
        droppedEvents: 0,
        persistence: { enabled: false },
        patchMetadata: [],
        observations: [],
      });
  });

  it("reports external version mismatches and blocks mutation", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const client = await connect(status.port);
    await register(bridge, client, {
      ...registration("patch-a", "voices", true),
      externalVersion: "0.3.0",
    });

    expect(bridge.getStatus()).toMatchObject({
      expectedExternalVersion: "0.4.0",
      registeredPatches: [{
        patcherId: "patch-a",
        externalVersion: "0.3.0",
        versionCompatible: false,
      }],
    });

    const plan = diffPatchGraphs(
      createEmptyPatchGraph("voices"),
      createEmptyPatchGraph("voices")
    );
    await expect(bridge.apply("patch-a", plan)).rejects.toThrow(
      'loaded maxforge.sync version "0.3.0", but this MCP runtime requires "0.4.0"'
    );
  });
});

describe("parseBridgeEvent", () => {
  it("accepts registrations and rejects malformed protocol data", () => {
    const value = registration("patch-a", "voices", true);
    expect(parseBridgeEvent(JSON.stringify(value))).toEqual(value);
    expect(parseBridgeEvent(
      '{"type":"maxforge.applied","patcherId":"patch-a","scope":"voices","revision":"bad","operations":1,"requestId":"r"}'
    )).toBeUndefined();
    expect(parseBridgeEvent("not json")).toBeUndefined();
  });

  it("rejects malformed structural snapshots", () => {
    const malformed = snapshotEvent("request-1");
    const value = {
      ...malformed,
      patcher: {
        ...malformed.patcher,
        boxes: [{
          ...malformed.patcher.boxes[0],
          patchingRect: [0, Number.NaN, 60, 20],
        }],
      },
    };
    expect(parseBridgeEvent(JSON.stringify(value))).toBeUndefined();
    expect(parseBridgeEvent(JSON.stringify({
      ...malformed,
      structureToken: "not-a-token",
    }))).toBeUndefined();
    const { structureToken: _structureToken, ...withoutToken } = malformed;
    expect(parseBridgeEvent(JSON.stringify(withoutToken))).toBeUndefined();
    expect(parseBridgeEvent(JSON.stringify({
      ...malformed,
      patcher: {
        ...malformed.patcher,
        boxes: [{
          ...malformed.patcher.boxes[0],
          attributes: { color: { red: 1 } },
        }],
      },
    }))).toBeUndefined();
  });

  it("parses serializable box attributes and rejects snapshots without them", () => {
    const current = snapshotEvent("request-1");
    const parsedCurrent = parseBridgeEvent(JSON.stringify({
      ...current,
      patcher: {
        ...current.patcher,
        boxes: [{
          ...current.patcher.boxes[0],
          comment: "human label",
          attributes: {
            presentation: 1,
            textcolor: [1, 0.5, 0, 1],
          },
        }],
      },
    }));
    expect(parsedCurrent).toMatchObject({
      patcher: {
        boxes: [{
          comment: "human label",
          attributes: {
            presentation: 1,
            textcolor: [1, 0.5, 0, 1],
          },
        }],
      },
    });

    const { attributes: _attributes, ...withoutAttributes } = current.patcher.boxes[0];
    expect(parseBridgeEvent(JSON.stringify({
      ...current,
      patcher: { ...current.patcher, boxes: [withoutAttributes] },
    }))).toBeUndefined();
  });

  it("validates observed edit evidence", () => {
    const event = editObservation("patch-a", "voices", {
      causes: ["patcher", "box"],
    });
    expect(parseBridgeEvent(JSON.stringify(event))).toMatchObject({
      type: "maxforge.edit.observed",
      causes: ["patcher", "box"],
    });
    expect(parseBridgeEvent(JSON.stringify({
      ...event,
      causes: ["box", "box"],
    }))).toBeUndefined();
    expect(parseBridgeEvent(JSON.stringify({
      ...event,
      causes: ["invented"],
    }))).toBeUndefined();
  });

  it("accepts registration capabilities it does not yet implement", () => {
    expect(parseBridgeEvent(JSON.stringify({
      ...registration("patch-a", "voices", false),
      capabilities: ["edit_observation_v1", "future_observation_v2"],
    }))).toMatchObject({
      type: "maxforge.registered",
      capabilities: ["edit_observation_v1", "future_observation_v2"],
    });
  });

  it("registers legacy externals as unknown and incompatible", () => {
    const { externalVersion: _externalVersion, ...legacy } = registration(
      "patch-a",
      "voices",
      false
    );
    expect(parseBridgeEvent(JSON.stringify(legacy))).toMatchObject({
      type: "maxforge.registered",
      externalVersion: "unknown",
    });
  });

  it("assigns a new session while preserving the native instance identity", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const first = await connect(status.port);
    await register(bridge, first, registration("patch-a", "voices", false));
    const firstInfo = bridge.listPatches()[0];
    first.terminate();
    await waitFor(() => bridge.listPatches().length === 0);

    const second = await connect(status.port);
    await register(bridge, second, registration("patch-a", "voices", false));
    const secondInfo = bridge.listPatches()[0];

    expect(secondInfo.instanceId).toBe(firstInfo.instanceId);
    expect(secondInfo.sessionId).not.toBe(firstInfo.sessionId);
  });
});

function createBridge(
  editHistoryStore?: EditHistoryStore,
  applyTimeoutMs = 1000
): MaxforgeWebSocketBridge {
  const bridge = new MaxforgeWebSocketBridge({
    port: 0,
    applyTimeoutMs,
    expectedExternalVersion: "0.4.0",
  }, editHistoryStore);
  bridges.push(bridge);
  return bridge;
}

async function connect(port: number): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  return client;
}

async function websocketRoundTrip(client: WebSocket): Promise<void> {
  await new Promise<void>((resolvePong, reject) => {
    const handlePong = () => {
      client.off("error", handleError);
      resolvePong();
    };
    const handleError = (error: Error) => {
      client.off("pong", handlePong);
      reject(error);
    };
    client.once("pong", handlePong);
    client.once("error", handleError);
    client.ping();
  });
}

async function register(
  bridge: MaxforgeWebSocketBridge,
  client: WebSocket,
  event: MaxforgePatchRegistration
): Promise<void> {
  client.send(JSON.stringify(event));
  await waitFor(() =>
    bridge.listPatches().some((patch) => patch.patcherId === event.patcherId)
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (deadline < Date.now()) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function registration(
  patcherId: string,
  scope: string,
  controller: boolean,
  title = patcherId
): MaxforgePatchRegistration {
  return {
    type: "maxforge.registered",
    patcherId,
    scope,
    instanceId: `instance_${patcherId}`,
    revision: null,
    controller,
    title,
    filename: "",
    filepath: "",
    externalVersion: "0.4.0",
    capabilities: ["edit_observation_v1"],
    observationBaseline: {
      structureToken: "0".repeat(16),
      patcher: snapshotEvent("registration").patcher,
    },
  };
}

function snapshotEvent(requestId: string): MaxforgeSnapshotEvent {
  return {
    type: "maxforge.snapshot",
    requestId,
    patcherId: "patch-a",
    scope: "voices",
    revision: null,
    structureToken: "0".repeat(16),
    patcher: {
      title: "inspection test",
      filename: "inspection.maxpat",
      filepath: "/tmp/inspection.maxpat",
      dirty: true,
      locked: false,
      presentation: false,
      boxes: [{
        targetPath: [],
        runtimeId: "obj-1",
        varName: "maxforge_voices_obj_osc",
        maxclass: "cycle~",
        patchingRect: [10, 20, 60, 22],
        managed: true,
        text: "cycle~ 440",
        attributes: {},
      }],
      connections: [],
    },
  };
}

function editObservation(
  patcherId: string,
  scope: string,
  options: {
    readonly causes?: readonly string[];
  }
) {
  const snapshot = snapshotEvent("unused");
  return {
    type: "maxforge.edit.observed",
    patcherId,
    scope,
    revision: null,
    structureToken: "1".repeat(16),
    causes: options.causes ?? ["unknown"],
    patcher: {
      ...snapshot.patcher,
      boxes: snapshot.patcher.boxes,
    },
  };
}
