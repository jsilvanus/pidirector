import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DirectorEventBroker } from "../events.js";
import type { WorldTracker } from "./world-tracker.js";
import type {
  AdvisoryShot,
  BroadcastDump,
  BroadcastStats,
  DirectorDecision,
  DirectorLogCategory,
  DirectorLogEntry,
  DirectorLogRundownContext,
  DirectorMode,
  GuardrailVerdict,
  HumanSteeringState,
} from "../types.js";

export interface DecisionLoggerOptions {
  eventBroker?: DirectorEventBroker | undefined;
  logFilePath?: string | undefined;
  broadcastsDir?: string | undefined;
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

function sanitizeSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "broadcast"
  );
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

/**
 * Formats a structured JSON DirectorLogEntry into a human-readable line for the CLI (`pidirector logs`)
 * and rolling LLM context summaries.
 */
export function formatLogEntryForCli(entry: DirectorLogEntry): string {
  const timeShort = formatTimeShort(entry.timestamp);
  const cueLabel = entry.rundown?.placeInEvent ?? entry.rundown?.cueTitle;
  const cuePart = cueLabel ? ` | Cue: ${cueLabel}` : "";
  const timingPart = entry.rundown?.timingSummary ? ` (${entry.rundown.timingSummary})` : "";
  const nextPart = entry.rundown?.nextItemTitle
    ? ` | Next: ${entry.rundown.nextItemTitle}${
        entry.rundown.nextItemCueSummary ? ` [${entry.rundown.nextItemCueSummary}]` : ""
      }`
    : "";
  return `[${timeShort}] [${entry.category.toUpperCase()}] ${entry.headline}${cuePart}${timingPart}${nextPart} — ${entry.detail}`;
}

export function formatLogsForCli(entries: DirectorLogEntry[]): string {
  return entries.map(formatLogEntryForCli).join("\n");
}

export function formatBroadcastForCli(dump: BroadcastDump): string {
  const eventTitle =
    [dump.event.title, dump.event.service, dump.event.church].filter(Boolean).join(" — ") ||
    "Unnamed Broadcast";
  const lines: string[] = [
    `Broadcast: ${dump.broadcastId} (${eventTitle})`,
    `Started:   ${dump.startedAt}${dump.endedAt ? ` | Ended: ${dump.endedAt}` : " (Active)"}`,
    `Stats:     ${dump.stats.totalDecisions} decisions (${dump.stats.cutsExecuted} cuts, ${dump.stats.preparesExecuted} prepares, ${dump.stats.holds} holds, ${dump.stats.guardrailSuppressions} guardrails, ${dump.stats.humanPreemptions} preemptions)`,
  ];

  if (dump.notes.length > 0) {
    lines.push("", "Steering Notes:");
    for (const note of dump.notes) {
      const state = note.expired
        ? `EXPIRED:${note.expiredReason ?? "expired"}`
        : note.enabled
          ? "ACTIVE"
          : "OFF";
      lines.push(`  - [${note.id}] [${state}] (${note.scope}) ${note.text}`);
    }
  }

  lines.push("", "Decision Log:");
  if (dump.logs.length === 0) {
    lines.push("  (No log entries)");
  } else {
    for (const entry of dump.logs) {
      lines.push(`  ${formatLogEntryForCli(entry)}`);
    }
  }
  return lines.join("\n");
}

export class DecisionLogger {
  private readonly entries: DirectorLogEntry[] = [];
  private readonly eventBroker?: DirectorEventBroker | undefined;
  private readonly logFilePath?: string | undefined;
  private readonly broadcastsDir: string;
  private readonly maxEntries: number;
  private seq = 1;
  private broadcastSeq = 1;
  private broadcastId: string;
  private startedAt: string;
  private dirCreated = false;

  constructor(options: DecisionLoggerOptions = {}) {
    this.eventBroker = options.eventBroker;
    this.logFilePath = options.logFilePath;
    this.broadcastsDir = path.resolve(options.broadcastsDir ?? "data/broadcasts");
    this.maxEntries = options.maxEntries ?? 500;
    this.startedAt = new Date().toISOString();
    this.broadcastId = this.generateBroadcastId();
    this.loadFromDisk();
  }

  private generateBroadcastId(title?: string | null, dateStr?: string | null): string {
    const now = new Date();
    const day = dateStr || now.toISOString().slice(0, 10);
    const timePart = now.toISOString().slice(11, 19).replace(/:/g, "");
    const slug = sanitizeSlug(title || "service");
    return `${day}_${slug}_${timePart}_${this.broadcastSeq++}`;
  }

  getBroadcastId(): string {
    return this.broadcastId;
  }

  getStartedAt(): string {
    return this.startedAt;
  }

  getEntries(limit = 50): DirectorLogEntry[] {
    return this.entries.slice(-limit).map((e) => structuredClone(e));
  }

  computeStats(notesCount = 0): BroadcastStats {
    let totalDecisions = 0;
    let cutsExecuted = 0;
    let preparesExecuted = 0;
    let holds = 0;
    let advisoriesIssued = 0;
    let guardrailSuppressions = 0;
    let humanPreemptions = 0;

    for (const e of this.entries) {
      if (
        e.category === "cut" ||
        e.category === "prepare" ||
        e.category === "hold" ||
        e.category === "advisory" ||
        e.category === "suppressed" ||
        e.category === "fallback"
      ) {
        totalDecisions += 1;
      }
      if ((e.category === "cut" || e.category === "fallback") && e.executed) {
        cutsExecuted += 1;
      } else if (e.category === "prepare" && e.executed) {
        preparesExecuted += 1;
      } else if (e.category === "hold") {
        holds += 1;
      } else if (e.category === "advisory") {
        advisoriesIssued += 1;
      } else if (e.category === "suppressed") {
        guardrailSuppressions += 1;
      } else if (e.category === "preempt") {
        humanPreemptions += 1;
      }
    }

    return {
      totalLogs: this.entries.length,
      totalDecisions,
      cutsExecuted,
      preparesExecuted,
      holds,
      advisoriesIssued,
      guardrailSuppressions,
      humanPreemptions,
      steeringNotesTotal: notesCount,
    };
  }

  buildBroadcastSnapshot(
    world: WorldTracker,
    options?: { endedAt?: string | null | undefined; customId?: string | undefined }
  ): BroadcastDump {
    const rundown = world.getRundown();
    const steering = world.getSteering();
    const broadcastId =
      options?.customId ??
      (this.broadcastId.includes("_service_") && rundown.title
        ? this.generateBroadcastId(rundown.title, rundown.date)
        : this.broadcastId);
    this.broadcastId = broadcastId;

    return {
      broadcastId,
      startedAt: this.startedAt,
      endedAt: options?.endedAt ?? null,
      event: {
        title: rundown.title,
        service: rundown.service,
        church: rundown.church,
        date: rundown.date,
      },
      steering,
      notes: steering.notes.map((n) => ({ ...n })),
      logs: this.entries.map((e) => structuredClone(e)),
      stats: this.computeStats(steering.notes.length),
    };
  }

  /**
   * Dumps the current broadcast (including all steering notes and structured decision logs)
   * into a per-broadcast JSON file on disk (`<broadcastsDir>/<broadcastId>.json`).
   * If `options.reset` is true, starts a fresh broadcast session (clearing logs and steering notes).
   */
  dumpBroadcast(
    world: WorldTracker,
    options?: { reset?: boolean | undefined; broadcastId?: string | undefined }
  ): {
    broadcast: BroadcastDump;
    filePath: string;
  } {
    const endedAt = new Date().toISOString();
    const broadcast = this.buildBroadcastSnapshot(world, {
      endedAt,
      customId: options?.broadcastId,
    });

    mkdirSync(this.broadcastsDir, { recursive: true });
    const fileName = `${broadcast.broadcastId}.json`;
    const filePath = path.join(this.broadcastsDir, fileName);
    writeFileSync(filePath, JSON.stringify(broadcast, null, 2), "utf8");

    this.eventBroker?.emit({
      type: "broadcast-dumped" as any,
      data: {
        broadcastId: broadcast.broadcastId,
        filePath,
        endedAt,
        stats: broadcast.stats,
      },
    });

    if (options?.reset) {
      this.resetBroadcast(world);
    }

    return {
      broadcast,
      filePath,
    };
  }

  resetBroadcast(world?: WorldTracker): { broadcastId: string; startedAt: string } {
    this.entries.length = 0;
    this.seq = 1;
    this.startedAt = new Date().toISOString();
    const rundown = world?.getRundown();
    this.broadcastId = this.generateBroadcastId(rundown?.title, rundown?.date);
    if (world) {
      world.resetBroadcastSteering();
    }
    return {
      broadcastId: this.broadcastId,
      startedAt: this.startedAt,
    };
  }

  listBroadcastDumps(): Array<{
    broadcastId: string;
    fileName: string;
    filePath: string;
    startedAt: string;
    endedAt: string | null;
    event: BroadcastDump["event"];
    stats: BroadcastStats;
  }> {
    if (!existsSync(this.broadcastsDir)) return [];
    const files = readdirSync(this.broadcastsDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();

    const out: Array<{
      broadcastId: string;
      fileName: string;
      filePath: string;
      startedAt: string;
      endedAt: string | null;
      event: BroadcastDump["event"];
      stats: BroadcastStats;
    }> = [];

    for (const fileName of files) {
      const filePath = path.join(this.broadcastsDir, fileName);
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as BroadcastDump;
        if (parsed && typeof parsed.broadcastId === "string") {
          out.push({
            broadcastId: parsed.broadcastId,
            fileName,
            filePath,
            startedAt: parsed.startedAt,
            endedAt: parsed.endedAt,
            event: parsed.event,
            stats: parsed.stats,
          });
        }
      } catch {
        // Ignore malformed files
      }
    }
    return out;
  }

  getBroadcastDump(broadcastId: string): BroadcastDump | null {
    const cleanId = broadcastId.replace(/\.json$/i, "");
    const filePath = path.join(this.broadcastsDir, `${cleanId}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, "utf8")) as BroadcastDump;
    } catch {
      return null;
    }
  }

  logDecisionOutcome(params: {
    timestamp: string;
    trigger: string;
    rundown?: DirectorLogRundownContext | undefined;
    mode: DirectorMode;
    source: "ollama" | "deterministic-fallback" | "human-advisory-accept";
    decision: DirectorDecision;
    verdict: GuardrailVerdict;
    executed: boolean;
    advisory?: AdvisoryShot | undefined;
    latencyMs?: number | undefined;
  }): DirectorLogEntry {
    const targetDesc = formatDecisionTarget(params.decision);
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

    return this.append({
      id: `log_${this.seq++}`,
      timestamp: params.timestamp,
      level,
      category,
      mode: params.mode,
      source: params.source,
      trigger: params.trigger,
      headline,
      detail,
      thought: params.decision.thought || undefined,
      rationale: params.decision.rationale || undefined,
      executed: params.executed,
      advisoryId: params.advisory?.id,
      latencyMs: params.latencyMs,
      action: {
        recommendedAction: params.decision.recommendedAction,
        cutToInput: params.decision.cutToInput,
        prepareCamera: params.decision.prepareCamera
          ? {
              camera: params.decision.prepareCamera.camera,
              preset: params.decision.prepareCamera.preset,
            }
          : undefined,
        transition: params.decision.transition,
        graphics: params.decision.graphics
          ? {
              showLowerThird: params.decision.graphics.showLowerThird,
              title: params.decision.graphics.title,
              subtitle: params.decision.graphics.subtitle,
            }
          : undefined,
      },
      guardrail: {
        allowed: params.verdict.allowed,
        modified: params.verdict.modified,
        suppressedReason: params.verdict.suppressedReason,
        appliedRule: params.verdict.appliedRule,
      },
      rundown: params.rundown,
    });
  }

  logModeChange(
    mode: DirectorMode,
    previousMode: DirectorMode,
    reason?: string
  ): DirectorLogEntry {
    const timestamp = new Date().toISOString();
    const headline = `Mode changed: ${previousMode.toUpperCase()} → ${mode.toUpperCase()}`;
    const detail = reason ?? "Operator mode change";

    return this.append({
      id: `log_${this.seq++}`,
      timestamp,
      level: "info",
      category: "mode",
      mode,
      previousMode,
      source: "operator",
      headline,
      detail,
    });
  }

  logPreempt(
    reason: string,
    actor: string,
    previousMode: DirectorMode,
    newMode: DirectorMode
  ): DirectorLogEntry {
    const timestamp = new Date().toISOString();
    const headline = `Preempted by ${actor} (${previousMode.toUpperCase()} → ${newMode.toUpperCase()})`;
    const detail = reason;

    return this.append({
      id: `log_${this.seq++}`,
      timestamp,
      level: "override",
      category: "preempt",
      mode: newMode,
      previousMode,
      source: "operator",
      actor,
      headline,
      detail,
    });
  }

  logSteering(steering: HumanSteeringState, mode: DirectorMode): DirectorLogEntry {
    const timestamp = steering.updatedAt ?? new Date().toISOString();
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

    return this.append({
      id: `log_${this.seq++}`,
      timestamp,
      level: "override",
      category: "steer",
      mode,
      source: "operator",
      headline,
      detail,
      steering: {
        instruction: steering.instruction,
        lockCamera: steering.lockCamera,
        excludeCameras: [...steering.excludeCameras],
        pacing: steering.pacing,
        minShotDwellSec: steering.minShotDwellSec,
      },
    });
  }

  private loadFromDisk(): void {
    if (!this.logFilePath || !existsSync(this.logFilePath)) return;
    try {
      const content = readFileSync(this.logFilePath, "utf8");
      const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines.slice(-this.maxEntries)) {
        try {
          const parsed = JSON.parse(line) as DirectorLogEntry;
          if (parsed && typeof parsed.id === "string" && typeof parsed.timestamp === "string") {
            this.entries.push(parsed);
            const num = Number.parseInt(parsed.id.replace(/^log_/, ""), 10);
            if (!Number.isNaN(num) && num >= this.seq) {
              this.seq = num + 1;
            }
          }
        } catch {
          // Ignore malformed lines
        }
      }
    } catch {
      // Non-fatal if disk read fails
    }
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
        appendFileSync(this.logFilePath, `${JSON.stringify(entry)}\n`, "utf8");
      } catch {
        // Non-fatal if disk write fails in restricted environment
      }
    }

    this.eventBroker?.emit({
      type: "log",
      data: entry,
    });

    return entry;
  }
}
