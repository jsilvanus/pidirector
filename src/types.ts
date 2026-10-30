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

/** Human Steering Input Schema */
export const HumanSteeringPatchSchema = z.object({
  instruction: z.string().nullable().optional(),
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

