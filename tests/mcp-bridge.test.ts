import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  MaxforgeWebSocketBridge,
  parseBridgeEvent,
} from "../src/mcp/bridge.js";
import { MaxforgePatchRegistration } from "../src/max/patch-protocol.js";
import {
  createEmptyPatchGraph,
  diffPatchGraphs,
} from "../src/max/patch-graph.js";

const bridges: MaxforgeWebSocketBridge[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.allSettled(bridges.splice(0).map((bridge) => bridge.close()));
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
});

function createBridge(): MaxforgeWebSocketBridge {
  const bridge = new MaxforgeWebSocketBridge({
    port: 0,
    applyTimeoutMs: 1000,
  });
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
    revision: null,
    controller,
    title,
    filename: "",
    filepath: "",
  };
}

function snapshotEvent(requestId: string) {
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
