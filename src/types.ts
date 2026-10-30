import { z } from "zod";

export const DirectorModeSchema = z.enum(["autonomous", "advisory", "manual"]);
export type DirectorMode = z.infer<typeof DirectorModeSchema>;

export const AiPacingSchema = z.enum(["meditative", "calm", "liturgical", "dynamic", "brisk"]);
export type AiPacing = z.infer<typeof AiPacingSchema>;

export const AiFramingSchema = z.enum([
  "wide",
  "medium",
  "close",
  "extreme-close",
  "over-shoulder",
  "ambient",
]);
export type AiFraming = z.infer<typeof AiFramingSchema>;

export const AiShotRuleSchema = z.object({
  condition: z.string(),
  target: z.string(),
  priority: z.number().min(1).max(10).default(5),
});
export type AiShotRule = z.infer<typeof AiShotRuleSchema>;

export const AiConstraintsSchema = z.object({
  disallowCongregationCloseup: z.boolean().default(true),
  minShotDwellSec: z.number().positive().default(4),
  maxShotDwellSec: z.number().positive().default(30),
  avoidCutsDuringPrayer: z.boolean().default(true),
  disallowMoveWhileOnAir: z.boolean().default(true),
});
export type AiConstraints = z.infer<typeof AiConstraintsSchema>;

export const AiGeneralInstructionsSchema = z.object({
  pacing: AiPacingSchema.optional(),
  style: z.string().optional(),
  guidelines: z.array(z.string()).default([]),
  constraints: AiConstraintsSchema.default({}),
  cameraRoles: z.record(z.string(), z.string()).optional(),
  sections: z.record(z.string(), z.string()).optional(),
});
export type AiGeneralInstructions = z.infer<typeof AiGeneralInstructionsSchema>;

export const AiItemInstructionsSchema = z.object({
  instructions: z.string().optional(),
  targetZone: z.string().optional(),
  primarySubject: z.string().optional(),
  preferredCameras: z.array(z.union([z.number(), z.string()])).optional(),
  framing: AiFramingSchema.optional(),
  pacing: AiPacingSchema.optional(),
  minDurationSec: z.number().nonnegative().optional(),
  shotRules: z.array(AiShotRuleSchema).optional(),
  graphicsCue: z
    .object({
      lowerThird: z
        .object({
          title: z.string(),
          subtitle: z.string().optional(),
          autoShowSec: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type AiItemInstructions = z.infer<typeof AiItemInstructionsSchema>;

/** Ollama Structured Decision Contract */
export const DirectorDecisionSchema = z.object({
  thought: z.string().default(""),
  recommendedAction: z.enum(["cut", "hold", "prepare_only"]).default("hold"),
  prepareCamera: z
    .object({
      camera: z.union([z.number(), z.string()]),
      preset: z.union([z.number(), z.string()]),
    })
    .optional(),
  cutToInput: z.number().int().min(1).optional(),
  transition: z.enum(["cut", "auto"]).default("cut"),
  graphics: z
    .object({
      showLowerThird: z.boolean().default(false),
      title: z.string().optional(),
      subtitle: z.string().optional(),
      durationMs: z.number().int().positive().optional(),
    })
    .optional(),
  tallyCue: z
    .object({
      id: z.string(),
      direction: z.enum(["pan-left", "pan-right", "zoom-in", "zoom-out", "operator-call"]),
      durationMs: z.number().int().positive().optional(),
    })
    .optional(),
  rationale: z.string().default(""),
});

export type DirectorDecision = z.infer<typeof DirectorDecisionSchema>;

export const SteeringScopeSchema = z.enum(["broadcast", "section", "subsection", "timer"]);
export type SteeringScope = z.infer<typeof SteeringScopeSchema>;

export const SteeringDurationValueSchema = z.union([z.number().positive(), z.string().min(1)]);
export type SteeringDurationValue = z.infer<typeof SteeringDurationValueSchema>;

export const SteeringNoteCreateSchema = z.object({
  text: z.string().min(1),
  scope: SteeringScopeSchema.default("broadcast"),
  duration: SteeringDurationValueSchema.optional(),
  enabled: z.boolean().default(true),
});
export type SteeringNoteCreate = z.infer<typeof SteeringNoteCreateSchema>;

export interface SteeringNote {
  id: string;
  text: string;
  scope: SteeringScope;
  enabled: boolean;
  expired: boolean;
  expiredReason?: string | null | undefined;
  createdAt: string;
  sectionKey?: string | null | undefined;
  subsectionKey?: string | null | undefined;
  durationSec?: number | null | undefined;
  expiresAt?: string | null | undefined;
  remainingSec?: number | null | undefined;
}

/**
 * Parses steering timer duration values: numbers are seconds (e.g. 60), strings are "M:SS" or "H:MM:SS" (e.g. "2:00").
 */
export function parseSteeringDurationSec(val?: string | number | null): number | null {
  if (typeof val === "number" && !Number.isNaN(val) && val > 0) {
    return Math.round(val);
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.includes(":")) {
      const parts = trimmed.split(":").map((p) => Number.parseInt(p.trim(), 10));
      if (parts.every((n) => !Number.isNaN(n))) {
        if (parts.length === 3) {
          return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
        }
        if (parts.length === 2) {
          return parts[0]! * 60 + parts[1]!;
        }
      }
    }
    const unitMatch = /^(\d+(?:\.\d+)?)\s*(h|m|min|s|sec)?$/i.exec(trimmed);
    if (unitMatch) {
      const num = Number.parseFloat(unitMatch[1]!);
      const unit = (unitMatch[2] ?? "s").toLowerCase();
      if (unit === "h") return Math.round(num * 3600);
      if (unit === "m" || unit === "min") return Math.round(num * 60);
      return Math.round(num);
    }
  }
  return null;
}

/** Human Steering Input Schema */
export const HumanSteeringPatchSchema = z.object({
  instruction: z.string().nullable().optional(),
  scope: SteeringScopeSchema.optional(),
  duration: SteeringDurationValueSchema.optional(),
  pacing: AiPacingSchema.nullable().optional(),
  lockCamera: z.number().int().min(1).nullable().optional(),
  excludeCameras: z.array(z.number().int().min(1)).optional(),
  minShotDwellSec: z.number().positive().nullable().optional(),
  maxShotDwellSec: z.number().positive().nullable().optional(),
  disallowCongregationCloseup: z.boolean().nullable().optional(),
  avoidCutsDuringPrayer: z.boolean().nullable().optional(),
  disallowMoveWhileOnAir: z.boolean().nullable().optional(),
});
export type HumanSteeringPatch = z.infer<typeof HumanSteeringPatchSchema>;

export interface HumanSteeringState {
  instruction: string | null;
  notes: SteeringNote[];
  activeNotes: SteeringNote[];
  pacing: AiPacing | null;
  lockCamera: number | null;
  excludeCameras: number[];
  minShotDwellSec: number | null;
  maxShotDwellSec: number | null;
  disallowCongregationCloseup: boolean | null;
  avoidCutsDuringPrayer: boolean | null;
  disallowMoveWhileOnAir: boolean | null;
  updatedAt: string | null;
}

export interface CameraMotionSnapshot {
  cameraId: string;
  inputNumber: number;
  isMoving: boolean;
  lastAction: string | null;
  settledPresetId: number | null;
  settledPresetName: string | null;
  targetPresetId: number | null;
  position: {
    pan: number;
    tilt: number;
    zoom: number;
  };
  lastMovedAt: string | null;
  lastSettledAt: string | null;
}

export interface GuardrailVerdict {
  allowed: boolean;
  modified: boolean;
  suppressedReason?: string | undefined;
  appliedRule?: string | undefined;
  decision: DirectorDecision;
}

export interface AdvisoryShot {
  id: string;
  createdAt: string;
  trigger: string;
  decision: DirectorDecision;
  guardrailVerdict: GuardrailVerdict;
  status: "pending" | "accepted" | "dismissed" | "superseded";
}

export interface DecisionHistoryEntry {
  id: string;
  timestamp: string;
  trigger: string;
  mode: DirectorMode;
  source: "ollama" | "deterministic-fallback" | "human-advisory-accept";
  decision: DirectorDecision;
  guardrailVerdict: GuardrailVerdict;
  executed: boolean;
  humanSummary: string;
  mcpCalls: Array<{
    tool: string;
    args: Record<string, unknown>;
    ok: boolean;
    error?: string | undefined;
  }>;
  latencyMs: number;
}

export type DirectorLogCategory =
  | "cut"
  | "prepare"
  | "hold"
  | "advisory"
  | "suppressed"
  | "fallback"
  | "preempt"
  | "mode"
  | "steer";

export interface DirectorLogRundownContext {
  placeInEvent?: string | null | undefined;
  cueId?: string | null | undefined;
  cueTitle?: string | null | undefined;
  section?: string | null | undefined;
  timingSummary?: string | null | undefined;
  nextItemTitle?: string | null | undefined;
  nextItemCueSummary?: string | null | undefined;
}

export interface DirectorLogActionSummary {
  recommendedAction: "cut" | "hold" | "prepare_only";
  cutToInput?: number | undefined;
  prepareCamera?: {
    camera: number | string;
    preset: number | string;
  } | undefined;
  transition?: "cut" | "auto" | undefined;
  graphics?: {
    showLowerThird: boolean;
    title?: string | undefined;
    subtitle?: string | undefined;
  } | undefined;
}

export interface DirectorLogGuardrailSummary {
  allowed: boolean;
  modified: boolean;
  suppressedReason?: string | undefined;
  appliedRule?: string | undefined;
}

export interface DirectorLogEntry {
  id: string;
  timestamp: string;
  level: "info" | "action" | "advisory" | "guardrail" | "override";
  category: DirectorLogCategory;
  mode: DirectorMode;
  previousMode?: DirectorMode | undefined;
  source: "ollama" | "deterministic-fallback" | "human-advisory-accept" | "operator";
  trigger?: string | undefined;
  actor?: string | undefined;
  headline: string;
  detail: string;
  thought?: string | undefined;
  rationale?: string | undefined;
  executed?: boolean | undefined;
  advisoryId?: string | undefined;
  latencyMs?: number | undefined;
  action?: DirectorLogActionSummary | undefined;
  guardrail?: DirectorLogGuardrailSummary | undefined;
  rundown?: DirectorLogRundownContext | undefined;
  steering?: {
    instruction?: string | null | undefined;
    lockCamera?: number | null | undefined;
    excludeCameras?: number[] | undefined;
    pacing?: string | null | undefined;
    minShotDwellSec?: number | null | undefined;
  } | undefined;
}

export type PitubeBroadcastState =
  | "idle"
  | "ready"
  | "testing"
  | "live"
  | "complete"
  | "offline"
  | "unknown";

export interface PitubeBroadcastSnapshot {
  available: boolean;
  state: PitubeBroadcastState;
  id: string | null;
  title: string | null;
  description: string | null;
  scheduledStartTime: string | null;
  actualStartTime: string | null;
  privacy: "public" | "unlisted" | "private" | null;
  streamHealth: string | null;
  updatedAt: string | null;
}

export interface BroadcastStats {
  totalLogs: number;
  totalDecisions: number;
  cutsExecuted: number;
  preparesExecuted: number;
  holds: number;
  advisoriesIssued: number;
  guardrailSuppressions: number;
  humanPreemptions: number;
  steeringNotesTotal: number;
}

export interface BroadcastDump {
  broadcastId: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  pitube: {
    id: string | null;
    title: string | null;
    state: PitubeBroadcastState;
    scheduledStartTime: string | null;
    actualStartTime: string | null;
  };
  event: {
    title: string | null;
    service: string | null;
    church: string | null;
    date: string | null;
  };
  steering: HumanSteeringState;
  notes: SteeringNote[];
  logs: DirectorLogEntry[];
  stats: BroadcastStats;
}

