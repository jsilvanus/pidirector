import type { DirectorEventBroker } from "../events.js";
import type { McpExecutor } from "../mcp/mcp-executor.js";
import type { OllamaDirectorClient } from "../ollama/client.js";
import type { CameraMotionTracker } from "../state/camera-motion-tracker.js";
import type { DecisionLogger } from "../state/decision-logger.js";
import type { WorldTracker } from "../state/world-tracker.js";
import type {
  AdvisoryShot,
  DecisionHistoryEntry,
  DirectorDecision,
  DirectorLogEntry,
  DirectorMode,
  GuardrailVerdict,
} from "../types.js";
import type { GuardrailEngine } from "./guardrails.js";

export interface DirectorEngineOptions {
  initialMode: DirectorMode;
  world: WorldTracker;
  cameraMotion: CameraMotionTracker;
  guardrails: GuardrailEngine;
  ollama: OllamaDirectorClient;
  mcpExecutor: McpExecutor;
  eventBroker: DirectorEventBroker;
  decisionLogger: DecisionLogger;
  wideFallbackCameraInput?: number | undefined;
}

const ZONE_DEFAULT_CAMERA: Record<string, { input: number; preset: string }> = {
  altar: { input: 1, preset: "altar" },
  wide: { input: 1, preset: "wide" },
  sanctuary: { input: 1, preset: "wide" },
  pulpit: { input: 2, preset: "pulpit" },
  ambo: { input: 2, preset: "lectern" },
  lectern: { input: 2, preset: "lectern" },
  organ: { input: 3, preset: "organ" },
  choir: { input: 3, preset: "choir" },
};

export class DirectorEngine {
  private mode: DirectorMode;
  private lastActiveMode: "autonomous" | "advisory";
  private readonly world: WorldTracker;
  private readonly cameraMotion: CameraMotionTracker;
  private readonly guardrails: GuardrailEngine;
  private readonly ollama: OllamaDirectorClient;
  private readonly mcpExecutor: McpExecutor;
  private readonly eventBroker: DirectorEventBroker;
  private readonly decisionLogger: DecisionLogger;
  private readonly wideFallbackCameraInput: number;

  private activeTurnAbort: AbortController | null = null;
  private pendingAdvisory: AdvisoryShot | null = null;
  private readonly history: DecisionHistoryEntry[] = [];
  private seqCounter = 1;

  constructor(options: DirectorEngineOptions) {
    this.mode = options.initialMode;
    this.lastActiveMode = options.initialMode === "autonomous" ? "autonomous" : "advisory";
    this.world = options.world;
    this.cameraMotion = options.cameraMotion;
    this.guardrails = options.guardrails;
    this.ollama = options.ollama;
    this.mcpExecutor = options.mcpExecutor;
    this.eventBroker = options.eventBroker;
    this.decisionLogger = options.decisionLogger;
    this.wideFallbackCameraInput = options.wideFallbackCameraInput ?? 1;
  }

  getMode(): DirectorMode {
    return this.mode;
  }

  getLastActiveMode(): "autonomous" | "advisory" {
    return this.lastActiveMode;
  }

  setMode(newMode: DirectorMode, reason?: string): DirectorMode {
    const previousMode = this.mode;
    if (newMode === "autonomous" || newMode === "advisory") {
      this.lastActiveMode = newMode;
    }
    if (previousMode === newMode) return this.mode;

    if (newMode === "manual" && this.activeTurnAbort) {
      this.activeTurnAbort.abort(new Error(reason ?? "Switched to manual mode"));
      this.activeTurnAbort = null;
    }

    this.mode = newMode;
    this.eventBroker.emit({
      type: "mode-changed",
      data: {
        mode: newMode,
        previousMode,
        reason,
        time: new Date().toISOString(),
      },
    });
    this.decisionLogger.logModeChange(newMode, previousMode, reason);
    return this.mode;
  }

  /**
   * Start directing in either autonomous (default) or advisory mode.
   */
  start(
    targetMode: "autonomous" | "advisory" = "autonomous",
    reason = "Operator started director"
  ): {
    previousMode: DirectorMode;
    mode: DirectorMode;
  } {
    const previousMode = this.mode;
    const mode = this.setMode(targetMode, reason);
    return { previousMode, mode };
  }

  /**
   * Stop/pause directing: immediately aborts any in-flight inference or camera settle wait (<5ms)
   * and transitions to manual (standby) mode while remembering lastActiveMode for continue().
   */
  stop(
    reason = "Operator stopped director",
    actor = "operator"
  ): {
    preemptedTurn: boolean;
    previousMode: DirectorMode;
    newMode: DirectorMode;
    resumableMode: "autonomous" | "advisory";
  } {
    if (this.mode === "autonomous" || this.mode === "advisory") {
      this.lastActiveMode = this.mode;
    }
    const res = this.preempt(reason, actor);
    return {
      ...res,
      resumableMode: this.lastActiveMode,
    };
  }

  /**
   * Continue/resume directing after a stop or human preemption, restoring the previous active mode
   * (or an explicitly requested mode) and resetting the shot dwell timer.
   */
  continue(
    targetMode?: "autonomous" | "advisory",
    reason = "Operator continued director"
  ): {
    previousMode: DirectorMode;
    mode: DirectorMode;
  } {
    const previousMode = this.mode;
    const resumeTo = targetMode ?? this.lastActiveMode;
    const mode = this.setMode(resumeTo, reason);
    return { previousMode, mode };
  }

  /**
   * Out-of-band <5ms human preemption.
   * Immediately aborts any in-flight Ollama deliberation or FreeD camera settle wait,
   * clears pending advisories, resets dwell timer, and switches to manual mode (unless keepMode=true).
   */
  preempt(
    reason = "Manual operator override",
    actor = "operator",
    options?: { keepMode?: boolean | undefined }
  ): {
    preemptedTurn: boolean;
    previousMode: DirectorMode;
    newMode: DirectorMode;
  } {
    const previousMode = this.mode;
    if (previousMode === "autonomous" || previousMode === "advisory") {
      this.lastActiveMode = previousMode;
    }
    let preemptedTurn = false;

    if (this.activeTurnAbort) {
      this.activeTurnAbort.abort(new Error(`preempted:${reason}`));
      this.activeTurnAbort = null;
      preemptedTurn = true;
    }

    if (this.pendingAdvisory && this.pendingAdvisory.status === "pending") {
      this.pendingAdvisory.status = "dismissed";
      this.pendingAdvisory = null;
    }

    this.world.resetDwellTimer();

    const newMode: DirectorMode = options?.keepMode ? this.mode : "manual";
    this.mode = newMode;

    this.eventBroker.emit({
      type: "preempted",
      data: {
        reason,
        actor,
        previousMode,
        newMode,
        time: new Date().toISOString(),
      },
    });
    this.decisionLogger.logPreempt(reason, actor, previousMode, newMode);

    if (previousMode !== newMode) {
      this.eventBroker.emit({
        type: "mode-changed",
        data: {
          mode: newMode,
          previousMode,
          reason: `Preempted by ${actor}: ${reason}`,
          time: new Date().toISOString(),
        },
      });
    }

    return {
      preemptedTurn,
      previousMode,
      newMode,
    };
  }

  getPendingAdvisory(): AdvisoryShot | null {
    return this.pendingAdvisory ? structuredClone(this.pendingAdvisory) : null;
  }

  getHistory(limit = 30): DecisionHistoryEntry[] {
    return this.history.slice(-limit);
  }

  getLogs(limit = 50): DirectorLogEntry[] {
    return this.decisionLogger.getEntries(limit);
  }

  /**
   * Deterministic fallback decision engine used when Ollama times out (>800ms) or is offline.
   * Uses Rundown v2 AI instructions, shotRules, preferredCameras, audio telemetry, and spatial zones.
   */
  computeDeterministicDecision(trigger: string): DirectorDecision {
    const switcher = this.world.getSwitcher();
    const rundown = this.world.getRundown();
    const audio = this.world.getAudio();
    const steering = this.world.getSteering();
    const itemAi = rundown.currentItemAi;

    // 1. Human Camera Lock
    if (steering.lockCamera !== null) {
      if (switcher.programInput === steering.lockCamera) {
        return {
          thought: `Camera ${steering.lockCamera} is locked by human operator and already on Program.`,
          recommendedAction: "hold",
          transition: "cut",
          rationale: "Holding locked camera.",
        };
      }
      return {
        thought: `Human operator locked Camera ${steering.lockCamera}.`,
        recommendedAction: "cut",
        cutToInput: steering.lockCamera,
        transition: "cut",
        rationale: `Switching to human-locked Camera ${steering.lockCamera}.`,
      };
    }

    // 2. Check explicit Rundown v2 item shotRules
    if (itemAi?.shotRules && itemAi.shotRules.length > 0) {
      const sortedRules = [...itemAi.shotRules].sort(
        (a, b) => (b.priority ?? 5) - (a.priority ?? 5)
      );
      for (const rule of sortedRules) {
        const cond = rule.condition.toLowerCase();
        const matches =
          (cond.includes("music") && audio.isMusic) ||
          (cond.includes("choir") && audio.isMusic) ||
          (cond.includes("speech") && audio.isSpeaking) ||
          (cond.includes("preacher") && audio.isSpeaking) ||
          cond === "always" ||
          trigger.toLowerCase().includes(cond);

        if (matches) {
          const parsed = this.parseShorthandTarget(rule.target);
          if (parsed && !steering.excludeCameras.includes(parsed.input)) {
            const prepareCamera =
              parsed.preset !== undefined && parsed.input !== switcher.programInput
                ? { camera: parsed.input, preset: parsed.preset }
                : undefined;
            return {
              thought: `Matched Rundown shotRule '${rule.condition}' -> '${rule.target}'.`,
              recommendedAction: "cut",
              prepareCamera,
              cutToInput: parsed.input,
              transition: "cut",
              rationale: `Shot rule '${rule.condition}' matched.`,
            };
          }
        }
      }
    }

    // 3. Check Rundown item preferredCameras & targetZone
    let targetInput: number | undefined;
    let targetPreset: string | number | undefined;

    if (itemAi?.preferredCameras && itemAi.preferredCameras.length > 0) {
      for (const cam of itemAi.preferredCameras) {
        const inputNum = this.cameraMotion.getInputNumberForCamera(cam);
        if (!steering.excludeCameras.includes(inputNum)) {
          targetInput = inputNum;
          break;
        }
      }
    }

    if (itemAi?.targetZone) {
      const zoneDef = ZONE_DEFAULT_CAMERA[itemAi.targetZone.toLowerCase()];
      if (zoneDef) {
        if (targetInput === undefined && !steering.excludeCameras.includes(zoneDef.input)) {
          targetInput = zoneDef.input;
        }
        targetPreset = zoneDef.preset;
      }
    }

    // 4. Inspect defaultActions on the cue item if still undecided
    if (targetInput === undefined && rundown.defaultActions.length > 0) {
      for (const act of rundown.defaultActions) {
        if (typeof act === "string") {
          const parsed = this.parseShorthandTarget(act);
          if (parsed) {
            targetInput = parsed.input;
            if (parsed.preset !== undefined) targetPreset = parsed.preset;
          }
        } else if (typeof act === "object" && act !== null) {
          const sw = (act["switch"] ?? act["atem"]) as Record<string, unknown> | undefined;
          if (sw && typeof sw["cut"] === "number") {
            targetInput = sw["cut"];
          }
          const cam = act["cam"] as Record<string, unknown> | undefined;
          if (cam && cam["id"] !== undefined && cam["preset"] !== undefined) {
            const camIn = this.cameraMotion.getInputNumberForCamera(cam["id"] as string | number);
            if (targetInput === undefined) targetInput = camIn;
            targetPreset = cam["preset"] as string | number;
          }
        }
      }
    }

    // 5. Audio-driven fallback (music -> Cam 3 or wide Cam 1; speech -> Cam 2)
    if (targetInput === undefined) {
      if (audio.isMusic) {
        targetInput = steering.excludeCameras.includes(3) ? this.wideFallbackCameraInput : 3;
        targetPreset = targetInput === 3 ? "choir" : "wide";
      } else if (audio.isSpeaking) {
        targetInput = steering.excludeCameras.includes(2) ? this.wideFallbackCameraInput : 2;
        targetPreset = targetInput === 2 ? "pulpit" : "wide";
      }
    }

    if (targetInput === undefined || targetInput === switcher.programInput) {
      return {
        thought: `Current Program input ${switcher.programInput} already matches desired framing for trigger '${trigger}'.`,
        recommendedAction: "hold",
        transition: "cut",
        rationale: "Holding current shot.",
      };
    }

    const lowerThird = itemAi?.graphicsCue?.lowerThird;
    const graphics = lowerThird
      ? {
          showLowerThird: true,
          title: lowerThird.title,
          ...(lowerThird.subtitle ? { subtitle: lowerThird.subtitle } : {}),
          ...(lowerThird.autoShowSec ? { durationMs: lowerThird.autoShowSec * 1000 } : {}),
        }
      : undefined;

    const prepareCamera =
      targetPreset !== undefined && targetInput !== switcher.programInput
        ? { camera: targetInput, preset: targetPreset }
        : undefined;

    return {
      thought: `Deterministic selection for cue '${rundown.currentCueTitle ?? trigger}': Input ${targetInput}${
        targetPreset ? ` (preset ${targetPreset})` : ""
      }.`,
      recommendedAction: "cut",
      ...(prepareCamera ? { prepareCamera } : {}),
      cutToInput: targetInput,
      transition: "cut",
      ...(graphics ? { graphics } : {}),
      rationale: `Rundown v2 cue '${rundown.currentCueTitle ?? trigger}' directs focus to Input ${targetInput}.`,
    };
  }

  /**
   * Main Two-Speed Evaluation Loop
   */
  async evaluate(
    trigger: string,
    options?: {
      tier?: "fast" | "reasoning" | undefined;
      bypassDwell?: boolean | undefined;
      forceWhenManual?: boolean | undefined;
    }
  ): Promise<{
    mode: DirectorMode;
    source: "ollama" | "deterministic-fallback";
    decision: DirectorDecision;
    verdict: GuardrailVerdict;
    executed: boolean;
    advisory?: AdvisoryShot | undefined;
    logEntry: DirectorLogEntry;
    historyEntry: DecisionHistoryEntry;
  }> {
    const startMs = Date.now();
    const turnController = new AbortController();
    this.activeTurnAbort = turnController;

    let source: "ollama" | "deterministic-fallback" = "ollama";
    let rawDecision: DirectorDecision;

    try {
      try {
        rawDecision = await this.ollama.deliberate(trigger, this.world, this.cameraMotion, {
          tier: options?.tier,
          signal: turnController.signal,
          recentDecisions: this.history,
        });
      } catch (err) {
        if (turnController.signal.aborted) {
          throw err;
        }
        // 800ms watchdog or Ollama offline -> fall back to deterministic Rundown v2 solver
        source = "deterministic-fallback";
        rawDecision = this.computeDeterministicDecision(trigger);
      }

      // Fast-Path Guardrail Verification (<10ms)
      const verdict = this.guardrails.evaluate(rawDecision, this.world, this.cameraMotion, {
        bypassDwell: options?.bypassDwell,
      });

      const timestamp = new Date().toISOString();
      const rundownSnap = this.world.getRundown();
      const cueTitle = rundownSnap.placeInEvent ?? rundownSnap.currentCueTitle;

      this.eventBroker.emit({
        type: "decision",
        data: {
          trigger,
          source,
          decision: verdict.decision,
          verdict,
          time: timestamp,
        },
      });

      const entryId = `dec_${this.seqCounter++}`;

      if (!verdict.allowed) {
        this.eventBroker.emit({
          type: "suppressed",
          data: {
            trigger,
            reason: verdict.suppressedReason ?? "guardrail_blocked",
            decision: verdict.decision,
            time: timestamp,
          },
        });

        const logEntry = this.decisionLogger.logDecisionOutcome({
          timestamp,
          trigger,
          cueTitle,
          mode: this.mode,
          source,
          decision: verdict.decision,
          verdict,
          executed: false,
        });

        const historyEntry: DecisionHistoryEntry = {
          id: entryId,
          timestamp,
          trigger,
          mode: this.mode,
          source,
          decision: verdict.decision,
          guardrailVerdict: verdict,
          executed: false,
          humanSummary: logEntry.formattedLine,
          mcpCalls: [],
          latencyMs: Date.now() - startMs,
        };
        this.recordHistory(historyEntry);

        return {
          mode: this.mode,
          source,
          decision: verdict.decision,
          verdict,
          executed: false,
          logEntry,
          historyEntry,
        };
      }

      // If decision is "hold", no action or advisory needed
      if (verdict.decision.recommendedAction === "hold") {
        const logEntry = this.decisionLogger.logDecisionOutcome({
          timestamp,
          trigger,
          cueTitle,
          mode: this.mode,
          source,
          decision: verdict.decision,
          verdict,
          executed: false,
        });

        const historyEntry: DecisionHistoryEntry = {
          id: entryId,
          timestamp,
          trigger,
          mode: this.mode,
          source,
          decision: verdict.decision,
          guardrailVerdict: verdict,
          executed: false,
          humanSummary: logEntry.formattedLine,
          mcpCalls: [],
          latencyMs: Date.now() - startMs,
        };
        this.recordHistory(historyEntry);

        return {
          mode: this.mode,
          source,
          decision: verdict.decision,
          verdict,
          executed: false,
          logEntry,
          historyEntry,
        };
      }

      // Co-Pilot / Advisory Mode -> Emit advisory shot for human operator
      if (this.mode === "advisory" || (this.mode === "manual" && options?.forceWhenManual)) {
        if (this.pendingAdvisory && this.pendingAdvisory.status === "pending") {
          this.pendingAdvisory.status = "superseded";
        }
        const advisory: AdvisoryShot = {
          id: `adv_${this.seqCounter++}`,
          createdAt: timestamp,
          trigger,
          decision: verdict.decision,
          guardrailVerdict: verdict,
          status: "pending",
        };
        this.pendingAdvisory = advisory;
        this.eventBroker.emit({ type: "advisory", data: advisory });

        const logEntry = this.decisionLogger.logDecisionOutcome({
          timestamp,
          trigger,
          cueTitle,
          mode: this.mode,
          source,
          decision: verdict.decision,
          verdict,
          executed: false,
          advisory,
        });

        const historyEntry: DecisionHistoryEntry = {
          id: entryId,
          timestamp,
          trigger,
          mode: this.mode,
          source,
          decision: verdict.decision,
          guardrailVerdict: verdict,
          executed: false,
          humanSummary: logEntry.formattedLine,
          mcpCalls: [],
          latencyMs: Date.now() - startMs,
        };
        this.recordHistory(historyEntry);

        return {
          mode: this.mode,
          source,
          decision: verdict.decision,
          verdict,
          executed: false,
          advisory,
          logEntry,
          historyEntry,
        };
      }

      // Manual Mode (without forceWhenManual) -> Do not execute
      if (this.mode === "manual") {
        const logEntry = this.decisionLogger.logDecisionOutcome({
          timestamp,
          trigger,
          cueTitle,
          mode: this.mode,
          source,
          decision: verdict.decision,
          verdict,
          executed: false,
        });

        const historyEntry: DecisionHistoryEntry = {
          id: entryId,
          timestamp,
          trigger,
          mode: this.mode,
          source,
          decision: verdict.decision,
          guardrailVerdict: verdict,
          executed: false,
          humanSummary: logEntry.formattedLine,
          mcpCalls: [],
          latencyMs: Date.now() - startMs,
        };
        this.recordHistory(historyEntry);

        return {
          mode: this.mode,
          source,
          decision: verdict.decision,
          verdict,
          executed: false,
          logEntry,
          historyEntry,
        };
      }

      // Autonomous Mode -> Execute via picontrol-mcp (includes waiting for FreeD preset:settled)
      const execRes = await this.mcpExecutor.executeDecision(
        verdict.decision,
        this.world,
        this.cameraMotion,
        turnController.signal
      );

      if (!execRes.executed && execRes.abortedReason) {
        verdict.allowed = false;
        verdict.suppressedReason = execRes.abortedReason;
        this.eventBroker.emit({
          type: "suppressed",
          data: {
            trigger,
            reason: execRes.abortedReason,
            decision: verdict.decision,
            time: new Date().toISOString(),
          },
        });
      }

      const logEntry = this.decisionLogger.logDecisionOutcome({
        timestamp: new Date().toISOString(),
        trigger,
        cueTitle,
        mode: this.mode,
        source,
        decision: verdict.decision,
        verdict,
        executed: execRes.executed,
      });

      const historyEntry: DecisionHistoryEntry = {
        id: entryId,
        timestamp: logEntry.timestamp,
        trigger,
        mode: this.mode,
        source,
        decision: verdict.decision,
        guardrailVerdict: verdict,
        executed: execRes.executed,
        humanSummary: logEntry.formattedLine,
        mcpCalls: execRes.mcpCalls,
        latencyMs: Date.now() - startMs,
      };
      this.recordHistory(historyEntry);

      if (execRes.executed) {
        this.eventBroker.emit({ type: "executed", data: historyEntry });
      }

      return {
        mode: this.mode,
        source,
        decision: verdict.decision,
        verdict,
        executed: execRes.executed,
        logEntry,
        historyEntry,
      };
    } finally {
      if (this.activeTurnAbort === turnController) {
        this.activeTurnAbort = null;
      }
    }
  }

  /**
   * Human operator accepts a pending advisory shot in Co-Pilot mode
   */
  async acceptAdvisory(advisoryId: string): Promise<{
    ok: boolean;
    error?: string | undefined;
    advisory?: AdvisoryShot | undefined;
    logEntry?: DirectorLogEntry | undefined;
    historyEntry?: DecisionHistoryEntry | undefined;
  }> {
    if (!this.pendingAdvisory || this.pendingAdvisory.id !== advisoryId) {
      return { ok: false, error: `Advisory '${advisoryId}' not found or no longer pending` };
    }
    if (this.pendingAdvisory.status !== "pending") {
      return { ok: false, error: `Advisory '${advisoryId}' is already ${this.pendingAdvisory.status}` };
    }

    const startMs = Date.now();
    const advisory = this.pendingAdvisory;

    // Re-check FreeD camera moving state before executing accepted advisory
    const verdict = this.guardrails.evaluate(
      advisory.decision,
      this.world,
      this.cameraMotion,
      { bypassDwell: true }
    );

    if (!verdict.allowed) {
      return {
        ok: false,
        error: verdict.suppressedReason ?? "Blocked by safety guardrail",
        advisory,
      };
    }

    const execRes = await this.mcpExecutor.executeDecision(
      verdict.decision,
      this.world,
      this.cameraMotion
    );

    if (!execRes.executed) {
      return {
        ok: false,
        error: execRes.abortedReason ?? "Execution failed",
        advisory,
      };
    }

    advisory.status = "accepted";
    this.pendingAdvisory = null;

    const timestamp = new Date().toISOString();
    const logEntry = this.decisionLogger.logDecisionOutcome({
      timestamp,
      trigger: `advisory_accept:${advisory.id}`,
      cueTitle: this.world.getRundown().currentCueTitle,
      mode: this.mode,
      source: "human-advisory-accept",
      decision: verdict.decision,
      verdict,
      executed: true,
    });

    const historyEntry: DecisionHistoryEntry = {
      id: `dec_${this.seqCounter++}`,
      timestamp,
      trigger: `advisory_accept:${advisory.id}`,
      mode: this.mode,
      source: "human-advisory-accept",
      decision: verdict.decision,
      guardrailVerdict: verdict,
      executed: true,
      humanSummary: logEntry.formattedLine,
      mcpCalls: execRes.mcpCalls,
      latencyMs: Date.now() - startMs,
    };
    this.recordHistory(historyEntry);
    this.eventBroker.emit({ type: "executed", data: historyEntry });

    return {
      ok: true,
      advisory,
      logEntry,
      historyEntry,
    };
  }

  dismissAdvisory(advisoryId: string): {
    ok: boolean;
    error?: string | undefined;
    advisory?: AdvisoryShot | undefined;
  } {
    if (!this.pendingAdvisory || this.pendingAdvisory.id !== advisoryId) {
      return { ok: false, error: `Advisory '${advisoryId}' not found or no longer pending` };
    }
    this.pendingAdvisory.status = "dismissed";
    const dismissed = structuredClone(this.pendingAdvisory);
    this.pendingAdvisory = null;
    return { ok: true, advisory: dismissed };
  }

  private parseShorthandTarget(
    target: string
  ): { input: number; preset?: string | number } | null {
    const parts = target.trim().split(":");
    if (parts[0] === "cam" && parts[1]) {
      const input = this.cameraMotion.getInputNumberForCamera(parts[1]);
      const preset = parts[2] === "preset" && parts[3] ? parts[3] : undefined;
      return { input, ...(preset !== undefined ? { preset } : {}) };
    }
    if ((parts[0] === "atem" || parts[0] === "switch") && parts[1] === "cut" && parts[2]) {
      const input = Number.parseInt(parts[2], 10);
      if (!Number.isNaN(input)) return { input };
    }
    return null;
  }

  private recordHistory(entry: DecisionHistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > 100) {
      this.history.shift();
    }
  }
}
