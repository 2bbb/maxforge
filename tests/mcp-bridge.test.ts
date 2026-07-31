import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  MaxforgeWebSocketBridge,
  parseBridgeEvent,
} from "../src/mcp/bridge.js";
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
  it("sends a raw PatchPlan and resolves only after the matching Max acknowledgement", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const client = await connect(status.port);
    const plan = diffPatchGraphs(
      createEmptyPatchGraph("voices"),
      createEmptyPatchGraph("voices")
    );

    client.once("message", (data) => {
      expect(JSON.parse(data.toString())).toEqual(plan);
      client.send(JSON.stringify({
        type: "maxforge.applied",
        scope: plan.scope,
        revision: plan.targetRevision,
        operations: plan.operations.length,
      }));
    });

    await expect(bridge.apply(plan)).resolves.toEqual({
      type: "maxforge.applied",
      scope: "voices",
      revision: plan.targetRevision,
      operations: 0,
    });
    expect(bridge.getLiveRevision("voices")).toBe(plan.targetRevision);
  });

  it("rejects a pending apply immediately when Max reports an error", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const client = await connect(status.port);
    const plan = diffPatchGraphs(
      createEmptyPatchGraph("voices"),
      createEmptyPatchGraph("voices")
    );

    client.once("message", () => {
      client.send(JSON.stringify({
        type: "maxforge.error",
        scope: "voices",
        message: "base revision does not match current revision",
      }));
    });

    await expect(bridge.apply(plan)).rejects.toThrow(
      'Max rejected scope "voices" while applying "voices": base revision does not match current revision'
    );
  });

  it("requests and validates a correlated live patcher snapshot", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const client = await connect(status.port);

    client.once("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        type: string;
        requestId: string;
        scope: string;
      };
      expect(request).toMatchObject({
        type: "maxforge.inspect.request",
        scope: "voices",
      });
      client.send(JSON.stringify(snapshotEvent(request.requestId)));
    });

    await expect(bridge.inspect("voices")).resolves.toMatchObject({
      type: "maxforge.snapshot",
      scope: "voices",
      revision: null,
      patcher: {
        dirty: true,
        boxes: [{
          runtimeId: "obj-1",
          varName: "maxforge_voices_obj_osc",
          text: "cycle~ 440",
        }],
      },
    });
    expect(bridge.getLiveRevision("voices")).toBeNull();
  });

  it("rejects an inspection when Max reports an error", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const client = await connect(status.port);

    client.once("message", () => {
      client.send(JSON.stringify({
        type: "maxforge.error",
        scope: "voices",
        message: "inspection failed",
      }));
    });

    await expect(bridge.inspect("voices")).rejects.toThrow(
      'Max rejected inspection of scope "voices": inspection failed'
    );
  });

  it("serializes applies globally because error events have no request identifier", async () => {
    const bridge = createBridge();
    const status = await bridge.start();
    const client = await connect(status.port);
    const firstPlan = diffPatchGraphs(
      createEmptyPatchGraph("voices"),
      createEmptyPatchGraph("voices")
    );
    const secondPlan = diffPatchGraphs(
      createEmptyPatchGraph("meters"),
      createEmptyPatchGraph("meters")
    );
    const firstApply = bridge.apply(firstPlan);
    await new Promise<void>((resolve) => client.once("message", () => resolve()));

    await expect(bridge.apply(secondPlan)).rejects.toThrow(
      'An apply is already pending for scope "voices"'
    );

    client.send(JSON.stringify({
      type: "maxforge.applied",
      scope: firstPlan.scope,
      revision: firstPlan.targetRevision,
      operations: 0,
    }));
    await expect(firstApply).resolves.toMatchObject({
      scope: "voices",
      revision: firstPlan.targetRevision,
    });
  });

  it("refuses mutation unless exactly one Max client is connected", async () => {
    const bridge = createBridge();
    await bridge.start();
    const plan = diffPatchGraphs(
      createEmptyPatchGraph("voices"),
      createEmptyPatchGraph("voices")
    );

    await expect(bridge.apply(plan)).rejects.toThrow(
      "Exactly one Max client is required, connected: 0"
    );
  });

  it("rejects non-loopback binding", () => {
    expect(
      () => new MaxforgeWebSocketBridge({ host: "0.0.0.0" })
    ).toThrow('WebSocket host must be loopback-only, received "0.0.0.0"');
    expect(
      () => new MaxforgeWebSocketBridge({ host: "localhost" })
    ).toThrow('WebSocket host must be loopback-only, received "localhost"');
  });
});

describe("parseBridgeEvent", () => {
  it("accepts revision events and rejects malformed protocol data", () => {
    expect(parseBridgeEvent(
      '{"type":"maxforge.revision","scope":"voices","revision":null}'
    )).toEqual({
      type: "maxforge.revision",
      scope: "voices",
      revision: null,
    });
    expect(parseBridgeEvent(
      '{"type":"maxforge.applied","scope":"voices","revision":"bad","operations":1}'
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

function snapshotEvent(requestId: string) {
  return {
    type: "maxforge.snapshot",
    requestId,
    scope: "voices",
    revision: null,
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
      }],
      connections: [],
    },
  };
}
