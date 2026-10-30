import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { DirectorEngine } from "./engine/director-engine.js";
import { GuardrailEngine } from "./engine/guardrails.js";
import { DirectorEventBroker } from "./events.js";
import { EventIngestor } from "./ingest/sse-client.js";
import { McpExecutor } from "./mcp/mcp-executor.js";
import { OllamaDirectorClient } from "./ollama/client.js";
import { registerRoutes } from "./routes.js";
import { CameraMotionTracker } from "./state/camera-motion-tracker.js";
import { DecisionLogger } from "./state/decision-logger.js";
import { WorldTracker } from "./state/world-tracker.js";

export interface BuildAppOptions {
  fetchFn?: typeof fetch | undefined;
  autoEvaluateOnCue?: boolean | undefined;
  decisionLogPath?: string | undefined;
  broadcastsDir?: string | undefined;
}

export interface BuildAppResult {
  app: FastifyInstance;
  engine: DirectorEngine;
  world: WorldTracker;
  cameraMotion: CameraMotionTracker;
  decisionLogger: DecisionLogger;
  guardrails: GuardrailEngine;
  ollama: OllamaDirectorClient;
  mcpExecutor: McpExecutor;
  ingestor: EventIngestor;
  eventBroker: DirectorEventBroker;
}

export function buildApp(config: AppConfig, options?: BuildAppOptions): BuildAppResult {
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : true,
  });

  const eventBroker = new DirectorEventBroker();
  const decisionLogger = new DecisionLogger({
    eventBroker,
    logFilePath: options?.decisionLogPath ?? config.decisionLogPath,
    broadcastsDir: options?.broadcastsDir ?? config.broadcastsDir,
  });
  const world = new WorldTracker(eventBroker, config.minShotDwellSec, config.maxShotDwellSec);
  const cameraMotion = new CameraMotionTracker(eventBroker, {
    cameraInputMap: config.cameraInputMap,
  });

  const guardrails = new GuardrailEngine({
    wideFallbackCameraInput: config.wideFallbackCameraInput,
    wideFallbackPreset: config.wideFallbackPreset,
  });

  const ollama = new OllamaDirectorClient({
    baseUrl: config.ollamaUrl,
    fastModel: config.fastModel,
    reasoningModel: config.reasoningModel,
    timeoutMs: config.ollamaTimeoutMs,
    rollingDecisionWindow: config.rollingDecisionWindow,
    rollingTranscriptWindow: config.rollingTranscriptWindow,
    fetchFn: options?.fetchFn,
  });

  const mcpExecutor = new McpExecutor({
    mcpUrl: config.mcpUrl,
    mcpToken: config.mcpToken,
    settleTimeoutMs: config.cameraSettleTimeoutMs,
    fetchFn: options?.fetchFn,
  });

  const engine = new DirectorEngine({
    initialMode: config.mode,
    world,
    cameraMotion,
    guardrails,
    ollama,
    mcpExecutor,
    eventBroker,
    decisionLogger,
    wideFallbackCameraInput: config.wideFallbackCameraInput,
  });

  const ingestor = new EventIngestor({
    gatewayUrl: config.pigatewayUrl,
    picamUrl: config.picamUrl,
    pitubeUrl: config.pitubeUrl,
    world,
    cameraMotion,
    engine,
    decisionLogger,
    autoEvaluateOnCue: options?.autoEvaluateOnCue ?? true,
    fetchFn: options?.fetchFn,
    logger: app.log,
  });

  registerRoutes(app, {
    engine,
    world,
    cameraMotion,
    decisionLogger,
    eventBroker,
    ingestor,
    ollama,
  });

  if (config.autoConnectSse) {
    ingestor.start();
  }

  app.addHook("onClose", async () => {
    ingestor.stop();
  });

  return {
    app,
    engine,
    world,
    cameraMotion,
    decisionLogger,
    guardrails,
    ollama,
    mcpExecutor,
    ingestor,
    eventBroker,
  };
}
