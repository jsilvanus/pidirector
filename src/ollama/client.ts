import {
  DirectorDecisionSchema,
  type DecisionHistoryEntry,
  type DirectorDecision,
} from "../types.js";
import type { CameraMotionTracker } from "../state/camera-motion-tracker.js";
import type { WorldTracker } from "../state/world-tracker.js";

export interface OllamaDirectorClientOptions {
  baseUrl: string;
  fastModel: string;
  reasoningModel: string;
  timeoutMs: number;
  rollingDecisionWindow?: number | undefined;
  rollingTranscriptWindow?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}

export class OllamaDirectorClient {
  private readonly baseUrl: string;
  private readonly fastModel: string;
  private readonly reasoningModel: string;
  private readonly timeoutMs: number;
  private readonly rollingDecisionWindow: number;
  private readonly rollingTranscriptWindow: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: OllamaDirectorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fastModel = options.fastModel;
    this.reasoningModel = options.reasoningModel;
    this.timeoutMs = options.timeoutMs;
    this.rollingDecisionWindow = options.rollingDecisionWindow ?? 5;
    this.rollingTranscriptWindow = options.rollingTranscriptWindow ?? 6;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/tags`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  buildPrompt(
    trigger: string,
    world: WorldTracker,
    cameraMotion: CameraMotionTracker,
    recentDecisions: DecisionHistoryEntry[] = []
  ): {
    system: string;
    user: string;
  } {
    const nowMs = Date.now();
    const rundown = world.getRundown();
    const switcher = world.getSwitcher(nowMs);
    const audio = world.getAudio();
    const spatial = world.getSpatial();
    const steering = world.getSteering();
    const constraints = world.getEffectiveConstraints();
    const cameras = cameraMotion.getAllSnapshots();
    const transcripts = world.getRecentTranscripts();

    const pacing =
      steering.pacing ??
      rundown.currentItemAi?.pacing ??
      rundown.generalAi.pacing ??
      "liturgical";

    const rollingShots = recentDecisions.slice(-this.rollingDecisionWindow).map((d) => {
      const parsedTime = Date.parse(d.timestamp);
      const agoSec = Number.isNaN(parsedTime)
        ? null
        : Math.max(0, Math.round(((nowMs - parsedTime) / 1000) * 10) / 10);
      return {
        agoSec,
        trigger: d.trigger,
        action: d.decision.recommendedAction,
        cutToInput: d.decision.cutToInput ?? null,
        preset: d.decision.prepareCamera?.preset ?? null,
        executed: d.executed,
        summary: d.humanSummary,
      };
    });

    const system = `You are pidirector, the Local AI Broadcast Director for live worship services at ${rundown.title ?? "Riihimäen Keskuskirkko"}.
Respond ONLY with a valid JSON object matching this exact schema:
{
  "thought": "Brief analysis of live state, camera motion, rolling shot history, and rundown rules",
  "recommendedAction": "cut" | "hold" | "prepare_only",
  "prepareCamera": { "camera": 2, "preset": 1 }, // optional
  "cutToInput": 2, // optional ATEM input number (1, 2, 3)
  "transition": "cut" | "auto",
  "graphics": { "showLowerThird": true, "title": "Saarna", "subtitle": "Pastori" }, // optional
  "rationale": "Concise human-readable justification for operator log"
}

Hard Broadcast Rules:
1. NEVER move a camera currently on ATEM Program (PGM = Input ${switcher.programInput}).
2. NEVER cut directly to a camera whose isMoving=true unless you set prepareCamera to recall a preset (the execution engine will wait for FreeD preset:settled before cutting).
3. Respect minimum shot dwell (${constraints.minShotDwellSec}s). Current dwell is ${switcher.dwellSec}s.
4. Review recentDecisions to maintain visual continuity and avoid repetitive A-B-A-B ping-pong cuts.
5. Style: ${rundown.generalAi.style ?? "Dignified, calm Nordic Lutheran liturgy"} | Pacing: ${pacing}.
6. Guidelines: ${(rundown.generalAi.guidelines ?? []).join(" ")}`;

    const userPayload = {
      trigger,
      switcher: {
        programInput: switcher.programInput,
        previewInput: switcher.previewInput,
        dwellSec: switcher.dwellSec,
      },
      cameras,
      cameraRoles: rundown.generalAi.cameraRoles ?? {},
      audio,
      spatial: {
        available: spatial.available,
        activeZones: spatial.activeZones,
        subjectsByZone: spatial.subjectsByZone,
      },
      activeCue: {
        id: rundown.currentCueId,
        title: rundown.currentCueTitle,
        section: rundown.currentSection,
        speaker: rundown.assignedSpeaker,
        aiInstructions: rundown.currentItemAi,
      },
      humanSteering: steering,
      recentDecisions: rollingShots,
      recentTranscripts: transcripts
        .slice(-this.rollingTranscriptWindow)
        .map((t) => t.text),
    };

    return {
      system,
      user: JSON.stringify(userPayload),
    };
  }

  async deliberate(
    trigger: string,
    world: WorldTracker,
    cameraMotion: CameraMotionTracker,
    options?: {
      tier?: "fast" | "reasoning" | undefined;
      signal?: AbortSignal | undefined;
      recentDecisions?: DecisionHistoryEntry[] | undefined;
    }
  ): Promise<DirectorDecision> {
    const model = options?.tier === "reasoning" ? this.reasoningModel : this.fastModel;
    const { system, user } = this.buildPrompt(
      trigger,
      world,
      cameraMotion,
      options?.recentDecisions ?? []
    );

    const watchdog = new AbortController();
    const timer = setTimeout(
      () => watchdog.abort(new Error("ollama_watchdog_timeout")),
      this.timeoutMs
    );

    const onExternalAbort = () => watchdog.abort(new Error("human_preempted"));
    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new Error("human_preempted");
      }
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          stream: false,
          format: "json",
          options: { temperature: 0.1 },
        }),
        signal: watchdog.signal,
      });

      if (!res.ok) {
        throw new Error(`Ollama HTTP ${res.status}`);
      }

      const body = (await res.json()) as { message?: { content?: string } };
      const rawContent = body.message?.content ?? "";
      const parsedJson = JSON.parse(rawContent);
      return DirectorDecisionSchema.parse(parsedJson);
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
