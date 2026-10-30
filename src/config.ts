export type DirectorMode = "autonomous" | "advisory" | "manual";

export interface AppConfig {
  host: string;
  port: number;
  mode: DirectorMode;
  ollamaUrl: string;
  fastModel: string;
  reasoningModel: string;
  ollamaTimeoutMs: number;
  mcpUrl: string;
  mcpToken?: string | undefined;
  pigatewayUrl: string;
  pirundownUrl: string;
  picamUrl: string;
  minShotDwellSec: number;
  maxShotDwellSec: number;
  cameraSettleTimeoutMs: number;
  wideFallbackCameraInput: number;
  wideFallbackPreset: string | number;
  cameraInputMap: Record<string, number>;
  inputCameraMap: Record<number, string>;
  autoConnectSse: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number.parseInt(env["PIDIRECTOR_PORT"] ?? "3450", 10);
  const host = env["PIDIRECTOR_HOST"] ?? "0.0.0.0";
  const rawMode = env["PIDIRECTOR_MODE"]?.toLowerCase();
  const mode: DirectorMode =
    rawMode === "autonomous" || rawMode === "advisory" || rawMode === "manual"
      ? rawMode
      : "advisory";

  const ollamaUrl = (env["OLLAMA_URL"] ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const fastModel = env["PIDIRECTOR_FAST_MODEL"] ?? "llama3.2:3b";
  const reasoningModel = env["PIDIRECTOR_REASONING_MODEL"] ?? "qwen2.5:7b-instruct";
  const ollamaTimeoutMs = Number.parseInt(env["PIDIRECTOR_OLLAMA_TIMEOUT_MS"] ?? "800", 10);

  const mcpUrl = env["PICONTROL_MCP_URL"] ?? "http://127.0.0.1:3200/mcp";
  const mcpToken = env["PIDIRECTOR_MCP_TOKEN"]?.trim() || undefined;

  const pigatewayUrl = (env["PIGATEWAY_URL"] ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
  const pirundownUrl = (env["PIRUNDOWN_URL"] ?? "http://127.0.0.1:3400").replace(/\/+$/, "");
  const picamUrl = (env["PICAM_URL"] ?? "http://127.0.0.1:3300").replace(/\/+$/, "");

  const minShotDwellSec = Number.parseFloat(env["PIDIRECTOR_MIN_SHOT_DWELL_SEC"] ?? "4");
  const maxShotDwellSec = Number.parseFloat(env["PIDIRECTOR_MAX_SHOT_DWELL_SEC"] ?? "30");
  const cameraSettleTimeoutMs = Number.parseInt(env["PIDIRECTOR_SETTLE_TIMEOUT_MS"] ?? "3500", 10);

  const wideFallbackCameraInput = Number.parseInt(env["PIDIRECTOR_WIDE_CAMERA_INPUT"] ?? "1", 10);
  const wideFallbackPreset = env["PIDIRECTOR_WIDE_PRESET"] ?? "1";

  const cameraInputMap: Record<string, number> = {
    cam1: 1,
    cam2: 2,
    cam3: 3,
    "1": 1,
    "2": 2,
    "3": 3,
  };

  const inputCameraMap: Record<number, string> = {
    1: "cam1",
    2: "cam2",
    3: "cam3",
  };

  const autoConnectSse = env["PIDIRECTOR_AUTO_SSE"] === "true";

  return {
    host,
    port: Number.isNaN(port) ? 3450 : port,
    mode,
    ollamaUrl,
    fastModel,
    reasoningModel,
    ollamaTimeoutMs: Number.isNaN(ollamaTimeoutMs) ? 800 : ollamaTimeoutMs,
    mcpUrl,
    mcpToken,
    pigatewayUrl,
    pirundownUrl,
    picamUrl,
    minShotDwellSec: Number.isNaN(minShotDwellSec) ? 4 : minShotDwellSec,
    maxShotDwellSec: Number.isNaN(maxShotDwellSec) ? 30 : maxShotDwellSec,
    cameraSettleTimeoutMs: Number.isNaN(cameraSettleTimeoutMs) ? 3500 : cameraSettleTimeoutMs,
    wideFallbackCameraInput: Number.isNaN(wideFallbackCameraInput) ? 1 : wideFallbackCameraInput,
    wideFallbackPreset,
    cameraInputMap,
    inputCameraMap,
    autoConnectSse,
  };
}
