import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DirectorEngine } from "./engine/director-engine.js";
import type { DirectorEventBroker } from "./events.js";
import type { EventIngestor } from "./ingest/sse-client.js";
import type { OllamaDirectorClient } from "./ollama/client.js";
import type { CameraMotionTracker } from "./state/camera-motion-tracker.js";
import { formatLogsForCli, type DecisionLogger } from "./state/decision-logger.js";
import type { WorldTracker } from "./state/world-tracker.js";
import { DirectorModeSchema, HumanSteeringPatchSchema } from "./types.js";

const openApiSpec = JSON.parse(
  readFileSync(new URL("../openapi/openapi.json", import.meta.url), "utf8")
);

export interface RouteDependencies {
  engine: DirectorEngine;
  world: WorldTracker;
  cameraMotion: CameraMotionTracker;
  decisionLogger: DecisionLogger;
  eventBroker: DirectorEventBroker;
  ingestor: EventIngestor;
  ollama: OllamaDirectorClient;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { engine, world, cameraMotion, decisionLogger, eventBroker, ingestor, ollama } = deps;

  app.get("/health", async () => {
    return {
      status: "ok",
      service: "pidirector",
      mode: engine.getMode(),
      lastActiveMode: engine.getLastActiveMode(),
      time: new Date().toISOString(),
    };
  });

  app.get("/openapi.json", async () => {
    return openApiSpec;
  });

  app.get("/api/v1/status", async () => {
    const ollamaHealthy = await ollama.isHealthy();
    return {
      service: "pidirector",
      mode: engine.getMode(),
      lastActiveMode: engine.getLastActiveMode(),
      ollamaHealthy,
      sseConnected: ingestor.isConnected(),
      switcher: world.getSwitcher(),
      cameras: cameraMotion.getAllSnapshots(),
      audio: world.getAudio(),
      spatial: world.getSpatial(),
      rundown: world.getRundown(),
      steering: world.getSteering(),
      effectiveConstraints: world.getEffectiveConstraints(),
      pendingAdvisory: engine.getPendingAdvisory(),
      recentLogs: decisionLogger.getEntries(15),
      recentHistory: engine.getHistory(10),
    };
  });

  app.get("/api/v1/events", (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const sendEvent = (type: string, data: unknown) => {
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify({ type, data })}\n\n`);
    };

    sendEvent("ready", {
      status: "connected",
      mode: engine.getMode(),
      time: new Date().toISOString(),
    });

    const unsubscribe = eventBroker.subscribe((evt) => {
      sendEvent(evt.type, evt.data);
    });

    request.raw.on("close", () => {
      unsubscribe();
    });
  });

  app.post("/api/v1/start", async (request, reply) => {
    const bodySchema = z
      .object({
        mode: z.enum(["autonomous", "advisory"]).default("autonomous"),
        reason: z.string().optional(),
        evaluateNow: z.boolean().default(false),
      })
      .default({});
    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid start payload",
        details: parsed.error.format(),
      });
    }

    const res = engine.start(parsed.data.mode, parsed.data.reason);
    const evaluation = parsed.data.evaluateNow
      ? await engine.evaluate("director_started", { tier: "reasoning" })
      : undefined;

    return {
      ok: true,
      ...res,
      ...(evaluation ? { evaluation } : {}),
    };
  });

  app.post("/api/v1/stop", async (request) => {
    const body = (request.body ?? {}) as {
      reason?: string;
      actor?: string;
    };
    const res = engine.stop(
      body.reason ?? "Operator stopped director",
      body.actor ?? "operator"
    );
    return {
      ok: true,
      ...res,
    };
  });

  app.post("/api/v1/continue", async (request, reply) => {
    const bodySchema = z
      .object({
        mode: z.enum(["autonomous", "advisory"]).optional(),
        reason: z.string().optional(),
        evaluateNow: z.boolean().default(false),
      })
      .default({});
    const parsed = bodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid continue payload",
        details: parsed.error.format(),
      });
    }

    const res = engine.continue(parsed.data.mode, parsed.data.reason);
    const evaluation = parsed.data.evaluateNow
      ? await engine.evaluate("director_continued", { tier: "reasoning" })
      : undefined;

    return {
      ok: true,
      ...res,
      ...(evaluation ? { evaluation } : {}),
    };
  });

  app.post("/api/v1/mode", async (request, reply) => {
    const bodySchema = z.object({
      mode: DirectorModeSchema,
      reason: z.string().optional(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid mode payload",
        details: parsed.error.format(),
      });
    }

    const previousMode = engine.getMode();
    const mode = engine.setMode(parsed.data.mode, parsed.data.reason);
    return {
      ok: true,
      previousMode,
      mode,
    };
  });

  app.get("/api/v1/steer", async () => {
    return {
      steering: world.getSteering(),
      effectiveConstraints: world.getEffectiveConstraints(),
    };
  });

  app.post("/api/v1/steer", async (request, reply) => {
    const parsed = HumanSteeringPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid steering payload",
        details: parsed.error.format(),
      });
    }

    const steering = world.updateSteering(parsed.data);
    const logEntry = decisionLogger.logSteering(steering, engine.getMode());
    return {
      ok: true,
      steering,
      effectiveConstraints: world.getEffectiveConstraints(),
      logEntry,
    };
  });

  app.post("/api/v1/preempt", async (request) => {
    const body = (request.body ?? {}) as {
      reason?: string;
      actor?: string;
      keepMode?: boolean;
    };
    const res = engine.preempt(
      body.reason ?? "Operator manual preemption",
      body.actor ?? "operator",
      { keepMode: body.keepMode }
    );
    return {
      ok: true,
      ...res,
    };
  });

  app.post("/api/v1/evaluate", async (request) => {
    const body = (request.body ?? {}) as {
      trigger?: string;
      tier?: "fast" | "reasoning";
      bypassDwell?: boolean;
      forceWhenManual?: boolean;
    };
    const result = await engine.evaluate(body.trigger ?? "manual_evaluate", {
      tier: body.tier,
      bypassDwell: body.bypassDwell,
      forceWhenManual: body.forceWhenManual,
    });
    return {
      ok: true,
      ...result,
    };
  });

  app.get("/api/v1/advisory", async () => {
    return {
      pendingAdvisory: engine.getPendingAdvisory(),
    };
  });

  app.post<{ Params: { id: string } }>("/api/v1/advisory/:id/accept", async (request, reply) => {
    const res = await engine.acceptAdvisory(request.params.id);
    if (!res.ok) {
      return reply.code(400).send(res);
    }
    return res;
  });

  app.post<{ Params: { id: string } }>("/api/v1/advisory/:id/dismiss", async (request, reply) => {
    const res = engine.dismissAdvisory(request.params.id);
    if (!res.ok) {
      return reply.code(404).send(res);
    }
    return res;
  });

  app.get("/api/v1/cameras", async () => {
    return {
      cameras: cameraMotion.getAllSnapshots(),
    };
  });

  app.post("/api/v1/ingest/event", async (request, reply) => {
    const body = (request.body ?? {}) as { type?: string; data?: Record<string, any> };
    if (!body.type || typeof body.type !== "string") {
      return reply.code(400).send({ error: "Event 'type' is required" });
    }
    await ingestor.handleEvent(body.type, body.data ?? {});
    return {
      ok: true,
      type: body.type,
    };
  });

  app.get("/api/v1/logs", async (request, reply) => {
    const query = (request.query ?? {}) as { limit?: string; format?: string };
    const limit = query.limit ? Number.parseInt(query.limit, 10) : 50;
    const safeLimit = Number.isNaN(limit) ? 50 : limit;
    const logs = decisionLogger.getEntries(safeLimit);

    if (query.format === "text") {
      return reply.type("text/plain; charset=utf-8").send(formatLogsForCli(logs));
    }

    return {
      logs,
    };
  });

  app.get("/api/v1/history", async (request) => {
    const query = (request.query ?? {}) as { limit?: string };
    const limit = query.limit ? Number.parseInt(query.limit, 10) : 30;
    return {
      history: engine.getHistory(Number.isNaN(limit) ? 30 : limit),
    };
  });
}
