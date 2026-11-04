import test from "node:test";
import assert from "node:assert/strict";
import { WorldTracker } from "../src/state/world-tracker.js";
import { CameraMotionTracker } from "../src/state/camera-motion-tracker.js";
import { GuardrailEngine } from "../src/engine/guardrails.js";
import { OllamaDirectorClient } from "../src/ollama/client.js";
import { McpExecutor } from "../src/mcp/mcp-executor.js";
import { DirectorEngine } from "../src/engine/director-engine.js";
import { DirectorEventBroker } from "../src/events.js";
import { DecisionLogger } from "../src/state/decision-logger.js";
import { EventIngestor } from "../src/ingest/sse-client.js";
import type { GraphicTemplateSummary } from "../src/types.js";

test("Graphics catalog sync via HTTP and MCP fallback", async () => {
  const world = new WorldTracker();
  const cameraMotion = new CameraMotionTracker();
  const eventBroker = new DirectorEventBroker();
  const decisionLogger = new DecisionLogger({ logPath: undefined, eventBroker });
  const guardrails = new GuardrailEngine();
  const ollama = new OllamaDirectorClient({
    baseUrl: "http://127.0.0.1:11434",
    fastModel: "llama3.2:3b",
    reasoningModel: "qwen2.5:7b-instruct",
    timeoutMs: 800,
  });

  const mockTemplates = [
    {
      id: "lower-third-speaker",
      name: "Speaker Lower Third",
      description: "Standard speaker strap",
      tags: ["lower-third", "speaker"],
      layers: [
        { id: "speaker-name", binding: "speaker" },
        { id: "speaker-title", binding: "title" },
      ],
    },
    {
      id: "scripture-reading",
      name: "Scripture Reading Strap",
      description: "Scripture citation",
      tags: ["scripture", "overlay"],
      layers: [
        { id: "scripture-box", binding: "reference" },
        { id: "scripture-text", binding: "scripture_text" },
      ],
    },
    {
      id: "hymn-ticker",
      name: "Hymn Ticker",
      tags: ["hymn", "music"],
      layers: [{ id: "hymn-num", binding: "hymn_number" }],
    },
  ];

  // 1. Successful HTTP sync from pigraphics
  const mockFetchHttp: typeof fetch = async (url) => {
    if (String(url).includes("/api/v1/graphics/templates")) {
      return new Response(JSON.stringify(mockTemplates), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const mcpExecutor = new McpExecutor({
    mcpUrl: "http://127.0.0.1:3200/mcp",
    settleTimeoutMs: 1000,
    fetchFn: mockFetchHttp,
  });

  const engine = new DirectorEngine({
    initialMode: "autonomous",
    world,
    cameraMotion,
    guardrails,
    ollama,
    mcpExecutor,
    eventBroker,
    decisionLogger,
  });

  const ingestorHttp = new EventIngestor({
    gatewayUrl: "http://127.0.0.1:3100",
    pigraphicsUrl: "http://127.0.0.1:3107",
    world,
    cameraMotion,
    engine,
    mcpExecutor,
    fetchFn: mockFetchHttp,
  });

  const syncedHttp = await ingestorHttp.syncGraphicsCatalog();
  assert.ok(syncedHttp);
  assert.equal(syncedHttp.length, 3);
  assert.equal(syncedHttp[0]?.id, "lower-third-speaker");
  assert.deepEqual(syncedHttp[0]?.bindings, ["speaker", "title"]);
  assert.equal(world.getGraphicsCatalog().length, 3);

  // 2. Fallback to MCP resource pi://graphics/templates when pigraphics HTTP fails
  const mockFetchMcp: typeof fetch = async (url, init) => {
    if (String(url).includes("/api/v1/graphics/templates")) {
      return new Response("Service Unavailable", { status: 503 });
    }
    if (String(url).includes("/mcp")) {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.method === "resources/read" && body.params?.uri === "pi://graphics/templates") {
        return new Response(
          JSON.stringify({
            result: {
              contents: [
                {
                  uri: "pi://graphics/templates",
                  mimeType: "application/json",
                  text: JSON.stringify([mockTemplates[0]]),
                },
              ],
            },
          }),
          { status: 200 }
        );
      }
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const mcpFallbackExecutor = new McpExecutor({
    mcpUrl: "http://127.0.0.1:3200/mcp",
    settleTimeoutMs: 1000,
    fetchFn: mockFetchMcp,
  });

  const ingestorMcp = new EventIngestor({
    gatewayUrl: "http://127.0.0.1:3100",
    pigraphicsUrl: "http://127.0.0.1:3107",
    world,
    cameraMotion,
    engine,
    mcpExecutor: mcpFallbackExecutor,
    fetchFn: mockFetchMcp,
  });

  const syncedMcp = await ingestorMcp.syncGraphicsCatalog();
  assert.ok(syncedMcp);
  assert.equal(syncedMcp.length, 1);
  assert.equal(syncedMcp[0]?.id, "lower-third-speaker");
});

test("WorldTracker filtering by item-scoped graphicsOptions", () => {
  const world = new WorldTracker();
  const catalog: GraphicTemplateSummary[] = [
    { id: "lower-third-speaker", name: "Speaker Lower Third", tags: ["lower-third"] },
    { id: "scripture-reading", name: "Scripture Reading", tags: ["overlay"] },
    { id: "hymn-ticker", name: "Hymn Ticker", tags: ["overlay", "hymn"] },
  ];
  world.setGraphicsCatalog(catalog);

  // Unfiltered when no options provided
  assert.equal(world.getFilteredGraphicsCatalog().length, 3);
  assert.equal(world.getFilteredGraphicsCatalog({}).length, 3);

  // Filtered by lowerThird whitelist
  const lowerThirdOnly = world.getFilteredGraphicsCatalog({
    lowerThird: ["lower-third-speaker"],
  });
  assert.equal(lowerThirdOnly.length, 1);
  assert.equal(lowerThirdOnly[0]?.id, "lower-third-speaker");

  // Filtered by overlay whitelist
  const overlayOnly = world.getFilteredGraphicsCatalog({
    overlay: ["scripture-reading", "hymn-ticker"],
  });
  assert.equal(overlayOnly.length, 2);

  // Filtered by explicit templates list
  const explicitOnly = world.getFilteredGraphicsCatalog({
    templates: ["hymn-ticker"],
  });
  assert.equal(explicitOnly.length, 1);
  assert.equal(explicitOnly[0]?.id, "hymn-ticker");
});

test("Ollama prompt builder injects item-scoped availableGraphics into user payload", () => {
  const world = new WorldTracker();
  const cameraMotion = new CameraMotionTracker();
  const client = new OllamaDirectorClient({
    baseUrl: "http://127.0.0.1:11434",
    fastModel: "llama3.2:3b",
    reasoningModel: "qwen2.5:7b-instruct",
    timeoutMs: 800,
  });

  world.setGraphicsCatalog([
    { id: "lower-third-speaker", name: "Speaker Lower Third" },
    { id: "scripture-reading", name: "Scripture Reading" },
  ]);

  // Set rundown with item-scoped graphicsOptions
  world.updateRundownContext({
    title: "Sunday Worship",
    currentCueTitle: "Sermon",
    currentItemAi: {
      instructions: "Preacher speaking at pulpit",
      graphicsOptions: {
        lowerThird: ["lower-third-speaker"],
      },
    },
  });

  const prompt = client.buildPrompt("cue_change", world, cameraMotion);
  assert.ok(prompt.system.includes('"templateId"'));

  const userPayload = JSON.parse(prompt.user);
  assert.ok(userPayload.availableGraphics);
  assert.equal(userPayload.availableGraphics.length, 1);
  assert.equal(userPayload.availableGraphics[0].id, "lower-third-speaker");
});

test("Deterministic decision and McpExecutor dispatch graphic templateId", async () => {
  const world = new WorldTracker();
  const cameraMotion = new CameraMotionTracker();
  const eventBroker = new DirectorEventBroker();
  const decisionLogger = new DecisionLogger({ logPath: undefined, eventBroker });
  const guardrails = new GuardrailEngine();
  const ollama = new OllamaDirectorClient({
    baseUrl: "http://127.0.0.1:11434",
    fastModel: "llama3.2:3b",
    reasoningModel: "qwen2.5:7b-instruct",
    timeoutMs: 800,
  });

  const executedMcpCalls: Array<{ method: string; params: any }> = [];
  const mockFetchMcp: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    executedMcpCalls.push({ method: body.method, params: body.params });
    return new Response(JSON.stringify({ result: { isError: false } }), { status: 200 });
  };

  const mcpExecutor = new McpExecutor({
    mcpUrl: "http://127.0.0.1:3200/mcp",
    settleTimeoutMs: 1000,
    fetchFn: mockFetchMcp,
  });

  const engine = new DirectorEngine({
    initialMode: "autonomous",
    world,
    cameraMotion,
    guardrails,
    ollama,
    mcpExecutor,
    eventBroker,
    decisionLogger,
  });

  // Current program on Cam 1, cue points to Cam 2 with lowerThird cue and graphicsOptions
  world.updateAtem({ programInput: 1, previewInput: 2 });
  world.updateRundownContext({
    title: "Sunday Worship",
    currentCueTitle: "Saarna",
    currentItemAi: {
      targetZone: "pulpit",
      graphicsCue: {
        lowerThird: {
          title: "Saarna",
          subtitle: "Pastori",
          autoShowSec: 6,
        },
      },
      graphicsOptions: {
        lowerThird: ["lower-third-speaker"],
      },
    },
  });

  // 1. Verify deterministic decision includes templateId
  const deterministicDecision = engine.computeDeterministicDecision("cue_change");
  assert.equal(deterministicDecision.recommendedAction, "cut");
  assert.equal(deterministicDecision.cutToInput, 2);
  assert.ok(deterministicDecision.graphics?.showLowerThird);
  assert.equal(deterministicDecision.graphics?.templateId, "lower-third-speaker");
  assert.equal(deterministicDecision.graphics?.title, "Saarna");

  // 2. Verify McpExecutor sends templateId to picontrol-mcp graphics_lower_third
  const execResult = await mcpExecutor.executeDecision(deterministicDecision, world, cameraMotion);
  assert.equal(execResult.executed, true);

  const gfxCall = executedMcpCalls.find(
    (c) => c.method === "tools/call" && c.params?.name === "graphics_lower_third"
  );
  assert.ok(gfxCall, "graphics_lower_third was called");
  assert.equal(gfxCall.params.arguments.action, "show");
  assert.equal(gfxCall.params.arguments.templateId, "lower-third-speaker");
  assert.equal(gfxCall.params.arguments.title, "Saarna");
  assert.equal(gfxCall.params.arguments.subtitle, "Pastori");
  assert.equal(gfxCall.params.arguments.durationMs, 6000);
});
