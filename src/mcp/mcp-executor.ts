import type { CameraMotionTracker } from "../state/camera-motion-tracker.js";
import type { WorldTracker } from "../state/world-tracker.js";
import type { DirectorDecision } from "../types.js";

export interface McpCallRecord {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string | undefined;
}

export interface ExecutionResult {
  executed: boolean;
  abortedReason?: string | undefined;
  mcpCalls: McpCallRecord[];
}

export interface McpExecutorOptions {
  mcpUrl: string;
  mcpToken?: string | undefined;
  settleTimeoutMs: number;
  fetchFn?: typeof fetch | undefined;
}

const PRESET_NAME_MAP: Record<string, number> = {
  pulpit: 1,
  pulpit_medium: 1,
  saarnatuoli: 1,
  altar: 2,
  alttari: 2,
  wide: 6,
  organ: 3,
  urut: 3,
  choir: 4,
  kuoro: 4,
  lectern: 5,
  ambo: 5,
  lukupulpetti: 5,
};

export function resolvePresetNumber(preset: string | number): number {
  if (typeof preset === "number") return preset;
  const num = Number.parseInt(preset.trim(), 10);
  if (!Number.isNaN(num)) return num;
  const key = preset.trim().toLowerCase();
  return PRESET_NAME_MAP[key] ?? 1;
}

export class McpExecutor {
  private readonly mcpUrl: string;
  private readonly mcpToken?: string | undefined;
  private readonly settleTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: McpExecutorOptions) {
    this.mcpUrl = options.mcpUrl;
    this.mcpToken = options.mcpToken;
    this.settleTimeoutMs = options.settleTimeoutMs;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallRecord> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.mcpToken) {
      headers["Authorization"] = `Bearer ${this.mcpToken}`;
    }

    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    };

    try {
      const res = await this.fetchFn(this.mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          tool: name,
          args,
          ok: false,
          error: `HTTP ${res.status}: ${text}`,
        };
      }

      const json = (await res.json().catch(() => ({}))) as {
        error?: { code?: number; message?: string };
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };

      if (json.error) {
        return {
          tool: name,
          args,
          ok: false,
          error: json.error.message ?? "MCP JSON-RPC error",
        };
      }

      if (json.result?.isError) {
        return {
          tool: name,
          args,
          ok: false,
          error: json.result.content?.[0]?.text ?? "MCP tool execution error",
        };
      }

      return {
        tool: name,
        args,
        ok: true,
      };
    } catch (err) {
      return {
        tool: name,
        args,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async readResource(
    uri: string,
    signal?: AbortSignal
  ): Promise<{ contents: Array<{ uri: string; text?: string; mimeType?: string }> } | null> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.mcpToken) {
      headers["Authorization"] = `Bearer ${this.mcpToken}`;
    }

    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "resources/read",
      params: { uri },
    };

    try {
      const res = await this.fetchFn(this.mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as {
        result?: { contents?: Array<{ uri: string; text?: string; mimeType?: string }> };
      } | null;

      return json?.result?.contents ? { contents: json.result.contents } : null;
    } catch {
      return null;
    }
  }

  async executeDecision(
    decision: DirectorDecision,
    world: WorldTracker,
    cameraMotion: CameraMotionTracker,
    signal?: AbortSignal
  ): Promise<ExecutionResult> {
    const mcpCalls: McpCallRecord[] = [];

    if (decision.recommendedAction === "hold") {
      return { executed: false, mcpCalls };
    }

    if (signal?.aborted) {
      return { executed: false, abortedReason: "preempted", mcpCalls };
    }

    // Step 1: Move Preview Camera to Preset (if requested)
    if (decision.prepareCamera) {
      const camId = cameraMotion.normalizeCameraId(decision.prepareCamera.camera);
      const camInput = cameraMotion.getInputNumberForCamera(camId);
      const presetNum = resolvePresetNumber(decision.prepareCamera.preset);

      // Put camera on ATEM Preview first
      const prvCall = await this.callTool(
        "atem_switch",
        { action: "preview", input: camInput },
        signal
      );
      mcpCalls.push(prvCall);
      if (prvCall.ok) {
        world.recordPreviewChange(camInput);
      }

      // Mark camera as moving while preset recalls
      cameraMotion.markPresetRecallInitiated(camId, presetNum);

      const presetCall = await this.callTool(
        "camera_preset",
        { camera: camId, action: "recall", preset: presetNum },
        signal
      );
      mcpCalls.push(presetCall);
      if (!presetCall.ok) {
        return {
          executed: false,
          abortedReason: `camera_preset_failed: ${presetCall.error}`,
          mcpCalls,
        };
      }

      // If only preparing preview camera, we are done
      if (decision.recommendedAction === "prepare_only") {
        return { executed: true, mcpCalls };
      }

      // Step 2: Wait for PTZ Settle via FreeD telemetry (`preset:settled` or `motion:stopped`)
      const settleRes = await cameraMotion.waitForCameraSettle(
        camId,
        this.settleTimeoutMs,
        signal
      );

      if (!settleRes.settled) {
        return {
          executed: false,
          abortedReason:
            settleRes.reason === "aborted"
              ? "preempted_during_camera_settle"
              : `camera_settle_timeout: ${camId} still moving after ${this.settleTimeoutMs}ms`,
          mcpCalls,
        };
      }
    }

    if (decision.recommendedAction !== "cut" || decision.cutToInput === undefined) {
      return { executed: mcpCalls.length > 0, mcpCalls };
    }

    const targetInput = decision.cutToInput;

    // Final FreeD safety check right before cutting ATEM:
    // Ensure the target camera did not start moving during deliberation/preparation
    if (cameraMotion.isCameraMoving(targetInput)) {
      return {
        executed: false,
        abortedReason: `freed_camera_moving_abort: Camera on input ${targetInput} is moving at cut time`,
        mcpCalls,
      };
    }

    if (signal?.aborted) {
      return { executed: false, abortedReason: "preempted", mcpCalls };
    }

    // Step 3: Set ATEM Preview (if not already set) and Cut ATEM to Preview Input
    const switcher = world.getSwitcher();
    if (switcher.previewInput !== targetInput) {
      const prvCall = await this.callTool(
        "atem_switch",
        { action: "preview", input: targetInput },
        signal
      );
      mcpCalls.push(prvCall);
      if (prvCall.ok) {
        world.recordPreviewChange(targetInput);
      }
    }

    const cutCall = await this.callTool("atem_switch", { action: "cut" }, signal);
    mcpCalls.push(cutCall);
    if (!cutCall.ok) {
      return {
        executed: false,
        abortedReason: `atem_cut_failed: ${cutCall.error}`,
        mcpCalls,
      };
    }

    world.recordProgramCut(targetInput);

    // Step 4: Show Timed Lower Third (if requested)
    if (decision.graphics?.showLowerThird && (decision.graphics.title || decision.graphics.templateId)) {
      const gfxArgs: Record<string, unknown> = {
        action: "show",
        durationMs: decision.graphics.durationMs ?? 8000,
      };
      if (decision.graphics.templateId) {
        gfxArgs["templateId"] = decision.graphics.templateId;
      }
      if (decision.graphics.title) {
        gfxArgs["title"] = decision.graphics.title;
      }
      if (decision.graphics.subtitle) {
        gfxArgs["subtitle"] = decision.graphics.subtitle;
      }
      const gfxCall = await this.callTool("graphics_lower_third", gfxArgs, signal);
      mcpCalls.push(gfxCall);
    }

    // Optional: Tally cue
    if (decision.tallyCue) {
      const tallyCall = await this.callTool(
        "tally_cue",
        {
          id: decision.tallyCue.id,
          direction: decision.tallyCue.direction,
          ...(decision.tallyCue.durationMs ? { durationMs: decision.tallyCue.durationMs } : {}),
        },
        signal
      );
      mcpCalls.push(tallyCall);
    }

    return {
      executed: true,
      mcpCalls,
    };
  }
}
