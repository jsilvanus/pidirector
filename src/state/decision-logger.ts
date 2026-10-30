import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DirectorEventBroker } from "../events.js";
import type {
  AdvisoryShot,
  DecisionHistoryEntry,
  DirectorDecision,
  DirectorLogCategory,
  DirectorLogEntry,
  DirectorMode,
  GuardrailVerdict,
  HumanSteeringState,
} from "../types.js";

export interface DecisionLoggerOptions {
  eventBroker?: DirectorEventBroker | undefined;
  logFilePath?: string | undefined;
  maxEntries?: number | undefined;
}

function formatTimeShort(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().slice(11, 19);
  } catch {
    return iso.slice(11, 19);
  }
}

export function formatDecisionTarget(decision: DirectorDecision): string {
  const parts: string[] = [];
  if (decision.cutToInput !== undefined) {
    parts.push(`Cam ${decision.cutToInput}`);
  }
  if (decision.prepareCamera) {
    const camLabel =
      decision.cutToInput !== undefined
        ? `Preset: ${decision.prepareCamera.preset}`
        : `Cam ${decision.prepareCamera.camera} (Preset: ${decision.prepareCamera.preset})`;
    parts.push(camLabel);
  }
  if (decision.graphics?.showLowerThird && decision.graphics.title) {
    const sub = decision.graphics.subtitle ? ` — ${decision.graphics.subtitle}` : "";
    parts.push(`Lower Third "${decision.graphics.title}${sub}"`);
  }
  return parts.length > 0 ? parts.join(" + ") : "current shot";
}

export class DecisionLogger {
  private readonly entries: DirectorLogEntry[] = [];
  private readonly eventBroker?: DirectorEventBroker | undefined;
  private readonly logFilePath?: string | undefined;
  private readonly maxEntries: number;
  private seq = 1;
  private dirCreated = false;

  constructor(options: DecisionLoggerOptions = {}) {
    this.eventBroker = options.eventBroker;
    this.logFilePath = options.logFilePath;
    this.maxEntries = options.maxEntries ?? 200;
  }

  getEntries(limit = 50): DirectorLogEntry[] {
    return this.entries.slice(-limit);
  }

  getFormattedText(limit = 50): string {
    return this.getEntries(limit)
      .map((e) => e.formattedLine)
      .join("\n");
  }

  logDecisionOutcome(params: {
    timestamp: string;
    trigger: string;
    cueTitle?: string | null | undefined;
    mode: DirectorMode;
    source: "ollama" | "deterministic-fallback" | "human-advisory-accept";
    decision: DirectorDecision;
    verdict: GuardrailVerdict;
    executed: boolean;
    advisory?: AdvisoryShot | undefined;
  }): DirectorLogEntry {
    const timeShort = formatTimeShort(params.timestamp);
    const targetDesc = formatDecisionTarget(params.decision);
    const cuePart = params.cueTitle ? ` | Cue: ${params.cueTitle}` : "";
    const reasonText =
      params.decision.rationale || params.decision.thought || `Triggered by ${params.trigger}`;

    let level: DirectorLogEntry["level"] = "info";
    let category: DirectorLogCategory = "hold";
    let headline = "";
    let detail = reasonText;

    if (!params.verdict.allowed) {
      level = "guardrail";
      category = "suppressed";
      const guardReason = (params.verdict.suppressedReason ?? "Blocked by safety guardrail")
        .replace(/^[a-z0-9_]+:\s*/i, "");
      headline = `Blocked ${params.decision.recommendedAction.toUpperCase()} → ${targetDesc}`;
      detail = guardReason;
    } else if (params.advisory) {
      level = "advisory";
      category = "advisory";
      headline = `Co-Pilot Suggestion (${params.advisory.id}): ${params.decision.recommendedAction.toUpperCase()} → ${targetDesc}`;
      detail = reasonText;
    } else if (params.decision.recommendedAction === "hold") {
      level = "info";
      category = "hold";
      headline = `Hold current shot`;
      detail = reasonText;
    } else if (params.verdict.modified && params.verdict.appliedRule) {
      level = "guardrail";
      category = "fallback";
      headline = `Fallback CUT → ${targetDesc}`;
      detail = params.verdict.appliedRule.replace(/^[a-z0-9_]+:\s*/i, "");
    } else if (params.decision.recommendedAction === "prepare_only") {
      level = "action";
      category = "prepare";
      headline = `Prepared Preview → ${targetDesc}`;
      detail = reasonText;
    } else {
      level = "action";
      category = "cut";
      const via =
        params.source === "human-advisory-accept"
          ? " (Operator Accepted Advisory)"
          : params.source === "deterministic-fallback"
            ? " (Rundown Rule)"
            : "";
      headline = `CUT → ${targetDesc}${via}`;
      detail = reasonText;
    }

    const formattedLine = `[${timeShort}] [${category.toUpperCase()}] ${headline}${cuePart} — ${detail}`;

    return this.append({
      id: `log_${this.seq++}`,
      timestamp: params.timestamp,
      timeShort,
      level,
      category,
      headline,
      detail,
      formattedLine,
      trigger: params.trigger,
      cueTitle: params.cueTitle ?? null,
      mode: params.mode,
      source: params.source,
      targetInput: params.decision.cutToInput,
      preset: params.decision.prepareCamera?.preset,
    });
  }

  logModeChange(
    mode: DirectorMode,
    previousMode: DirectorMode,
    reason?: string
  ): DirectorLogEntry {
    const timestamp = new Date().toISOString();
    const timeShort = formatTimeShort(timestamp);
    const headline = `Mode changed: ${previousMode.toUpperCase()} → ${mode.toUpperCase()}`;
    const detail = reason ?? "Operator mode change";
    const formattedLine = `[${timeShort}] [MODE] ${headline} — ${detail}`;

    return this.append({
      id: `log_${this.seq++}`,
      timestamp,
      timeShort,
      level: "info",
      category: "mode",
      headline,
      detail,
      formattedLine,
      mode,
      source: "operator",
    });
  }

  logPreempt(
    reason: string,
    actor: string,
    previousMode: DirectorMode,
    newMode: DirectorMode
  ): DirectorLogEntry {
    const timestamp = new Date().toISOString();
    const timeShort = formatTimeShort(timestamp);
    const headline = `Preempted by ${actor} (${previousMode.toUpperCase()} → ${newMode.toUpperCase()})`;
    const detail = reason;
    const formattedLine = `[${timeShort}] [PREEMPT] ${headline} — ${detail}`;

    return this.append({
      id: `log_${this.seq++}`,
      timestamp,
      timeShort,
      level: "override",
      category: "preempt",
      headline,
      detail,
      formattedLine,
      mode: newMode,
      source: "operator",
    });
  }

  logSteering(steering: HumanSteeringState, mode: DirectorMode): DirectorLogEntry {
    const timestamp = steering.updatedAt ?? new Date().toISOString();
    const timeShort = formatTimeShort(timestamp);
    const parts: string[] = [];
    if (steering.instruction) parts.push(`Note: "${steering.instruction}"`);
    if (steering.lockCamera !== null) parts.push(`Locked Cam ${steering.lockCamera}`);
    if (steering.excludeCameras.length > 0) {
      parts.push(`Excluded Cam [${steering.excludeCameras.join(", ")}]`);
    }
    if (steering.pacing) parts.push(`Pacing: ${steering.pacing}`);
    if (steering.minShotDwellSec !== null) parts.push(`Min Dwell: ${steering.minShotDwellSec}s`);

    const detail = parts.length > 0 ? parts.join(" | ") : "Cleared human steering overrides";
    const headline = `Operator updated steering directives`;
    const formattedLine = `[${timeShort}] [STEER] ${headline} — ${detail}`;

    return this.append({
      id: `log_${this.seq++}`,
      timestamp,
      timeShort,
      level: "override",
      category: "steer",
      headline,
      detail,
      formattedLine,
      mode,
      source: "operator",
    });
  }

  private append(entry: DirectorLogEntry): DirectorLogEntry {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    if (this.logFilePath) {
      try {
        if (!this.dirCreated) {
          mkdirSync(path.dirname(this.logFilePath), { recursive: true });
          this.dirCreated = true;
        }
        appendFileSync(this.logFilePath, `${entry.formattedLine}\n`, "utf8");
      } catch {
        // Non-fatal if disk write fails in restricted environment
      }
    }

    this.eventBroker?.emit({ type: "log", data: entry });
    return entry;
  }
}
