import type { CameraMotionTracker } from "../state/camera-motion-tracker.js";
import type { WorldTracker } from "../state/world-tracker.js";
import type { DirectorDecision, GuardrailVerdict } from "../types.js";

export interface GuardrailOptions {
  wideFallbackCameraInput: number;
  wideFallbackPreset: string | number;
}

export class GuardrailEngine {
  private readonly options: GuardrailOptions;

  constructor(options: GuardrailOptions) {
    this.options = options;
  }

  evaluate(
    rawDecision: DirectorDecision,
    world: WorldTracker,
    cameraMotion: CameraMotionTracker,
    options?: { bypassDwell?: boolean | undefined; nowMs?: number | undefined }
  ): GuardrailVerdict {
    const decision: DirectorDecision = structuredClone(rawDecision);
    const switcher = world.getSwitcher(options?.nowMs);
    const steering = world.getSteering();
    const rundown = world.getRundown();
    const constraints = world.getEffectiveConstraints();

    // 1. Human Camera Lock Override
    if (steering.lockCamera !== null) {
      if (switcher.programInput !== steering.lockCamera) {
        return {
          allowed: true,
          modified: true,
          appliedRule: "human_camera_lock",
          decision: {
            ...decision,
            recommendedAction: "cut",
            cutToInput: steering.lockCamera,
            prepareCamera: undefined,
            rationale: `Human operator locked camera ${steering.lockCamera}.`,
          },
        };
      }
      if (decision.recommendedAction === "cut" && decision.cutToInput !== steering.lockCamera) {
        return {
          allowed: false,
          modified: false,
          suppressedReason: `human_camera_lock: Camera ${steering.lockCamera} is locked by operator`,
          decision,
        };
      }
    }

    // 2. If action is hold, no cut or move needed
    if (decision.recommendedAction === "hold") {
      return {
        allowed: true,
        modified: false,
        decision,
      };
    }

    // 3. Excluded cameras check
    if (decision.cutToInput !== undefined && steering.excludeCameras.includes(decision.cutToInput)) {
      return {
        allowed: false,
        modified: false,
        suppressedReason: `excluded_camera: Camera ${decision.cutToInput} is excluded by operator`,
        decision,
      };
    }

    if (decision.prepareCamera) {
      const prepInput = cameraMotion.getInputNumberForCamera(decision.prepareCamera.camera);
      if (steering.excludeCameras.includes(prepInput)) {
        return {
          allowed: false,
          modified: false,
          suppressedReason: `excluded_camera: Preview camera ${prepInput} is excluded by operator`,
          decision,
        };
      }

      // 4. On-Air Camera Tally Guard: Never move a camera currently on ATEM PGM
      if (constraints.disallowMoveWhileOnAir && prepInput === switcher.programInput) {
        return {
          allowed: false,
          modified: false,
          suppressedReason: `on_air_camera_tally_guard: Cannot move Camera ${prepInput} while it is live on ATEM Program`,
          decision,
        };
      }
    }

    // 5. Congregation Privacy Guard
    if (constraints.disallowCongregationCloseup) {
      const targetZone = (rundown.currentItemAi?.targetZone ?? "").toLowerCase();
      const presetStr = String(decision.prepareCamera?.preset ?? "").toLowerCase();
      const thoughtStr = `${decision.thought} ${decision.rationale}`.toLowerCase();
      const isCongregationShot =
        targetZone === "congregation" ||
        presetStr.includes("congregation") ||
        presetStr.includes("seurakunta") ||
        thoughtStr.includes("congregation closeup");

      if (isCongregationShot) {
        return {
          allowed: false,
          modified: false,
          suppressedReason: "privacy_guard: Congregation closeups are disallowed by privacy constraints",
          decision,
        };
      }
    }

    // If only preparing preview camera (no live cut), allow after passing on-air & privacy checks
    if (decision.recommendedAction === "prepare_only") {
      return {
        allowed: true,
        modified: false,
        decision,
      };
    }

    // --- Below checks apply to live ATEM cuts (recommendedAction === "cut") ---

    // 6. Redundant cut check (already on target input and no preset change)
    if (
      decision.cutToInput !== undefined &&
      decision.cutToInput === switcher.programInput &&
      !decision.prepareCamera
    ) {
      return {
        allowed: false,
        modified: false,
        suppressedReason: `already_on_air: Input ${decision.cutToInput} is already on ATEM Program`,
        decision,
      };
    }

    // 7. Prayer Moment Cut Guard
    if (constraints.avoidCutsDuringPrayer && world.isPrayerMoment()) {
      return {
        allowed: false,
        modified: false,
        suppressedReason: "prayer_moment_guard: Cuts are suppressed during prayer",
        decision,
      };
    }

    // 8. Minimum Shot Dwell-Time Gate (Prevent Rapid Cutting / Flicker)
    if (!options?.bypassDwell && switcher.dwellSec < constraints.minShotDwellSec) {
      return {
        allowed: false,
        modified: false,
        suppressedReason: `min_shot_dwell_gate: Current shot dwell (${switcher.dwellSec}s) is below minimum (${constraints.minShotDwellSec}s)`,
        decision,
      };
    }

    // 9. Empty Podium / Unoccupied Zone Fallback (Spatial Perception Cross-Validation)
    const targetZone = rundown.currentItemAi?.targetZone;
    if (
      targetZone &&
      decision.cutToInput !== undefined &&
      decision.cutToInput !== this.options.wideFallbackCameraInput
    ) {
      const occupied = world.isZoneOccupied(targetZone);
      if (occupied === false) {
        // Zone is known to be empty -> fallback to wide establishing shot
        const fallbackInput = this.options.wideFallbackCameraInput;
        if (cameraMotion.isCameraMoving(fallbackInput)) {
          return {
            allowed: false,
            modified: false,
            suppressedReason: `freed_camera_moving_guard: Target zone '${targetZone}' is empty and fallback camera ${fallbackInput} is currently moving`,
            decision,
          };
        }
        return {
          allowed: true,
          modified: true,
          appliedRule: `empty_zone_wide_fallback: Zone '${targetZone}' is unoccupied; falling back to wide shot (Input ${fallbackInput})`,
          decision: {
            ...decision,
            prepareCamera: undefined,
            cutToInput: fallbackInput,
            rationale: `Fallback to wide sanctuary shot because target zone '${targetZone}' has 0 detected people.`,
          },
        };
      }
    }

    // 10. FreeD Camera Moving Gate:
    // If cutting directly to a camera (without an explicit prepareCamera step that will wait for preset:settled),
    // block the cut if FreeD telemetry reports the target camera is currently moving!
    if (decision.cutToInput !== undefined) {
      const targetInput = decision.cutToInput;
      const prepInput = decision.prepareCamera
        ? cameraMotion.getInputNumberForCamera(decision.prepareCamera.camera)
        : null;

      if (cameraMotion.isCameraMoving(targetInput) && prepInput !== targetInput) {
        return {
          allowed: false,
          modified: false,
          suppressedReason: `freed_camera_moving_guard: Camera on input ${targetInput} is currently moving (FreeD motion:moving) — refusing to cut mid-slew`,
          decision,
        };
      }
    }

    return {
      allowed: true,
      modified: false,
      decision,
    };
  }
}
