import type { DirectorEngine } from "../engine/director-engine.js";
import type { CameraMotionTracker } from "../state/camera-motion-tracker.js";
import type { WorldTracker } from "../state/world-tracker.js";

export interface EventIngestorOptions {
  gatewayUrl: string;
  picamUrl?: string | undefined;
  world: WorldTracker;
  cameraMotion: CameraMotionTracker;
  engine: DirectorEngine;
  autoEvaluateOnCue?: boolean | undefined;
  fetchFn?: typeof fetch | undefined;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  } | undefined;
}

export class EventIngestor {
  private readonly gatewayUrl: string;
  private readonly picamUrl?: string | undefined;
  private readonly world: WorldTracker;
  private readonly cameraMotion: CameraMotionTracker;
  private readonly engine: DirectorEngine;
  private readonly autoEvaluateOnCue: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly logger: EventIngestorOptions["logger"];

  private abortController: AbortController | null = null;
  private connected = false;

  constructor(options: EventIngestorOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/+$/, "");
    this.picamUrl = options.picamUrl?.replace(/\/+$/, "");
    this.world = options.world;
    this.cameraMotion = options.cameraMotion;
    this.engine = options.engine;
    this.autoEvaluateOnCue = options.autoEvaluateOnCue ?? true;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.logger = options.logger;
  }

  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    if (this.abortController) return;
    this.abortController = new AbortController();
    void this.connectSseLoop(`${this.gatewayUrl}/api/v1/events`, this.abortController.signal);
    if (this.picamUrl) {
      void this.connectSseLoop(`${this.picamUrl}/api/v1/events`, this.abortController.signal);
    }
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.connected = false;
  }

  /**
   * Process a single ecosystem event (from SSE or HTTP webhook/test endpoint)
   */
  async handleEvent(type: string, data: Record<string, any>): Promise<void> {
    switch (type) {
      case "camera": {
        if (data && typeof data["id"] === "string" && typeof data["action"] === "string") {
          this.cameraMotion.handleCameraEvent({
            id: data["id"],
            action: data["action"],
            presetId: typeof data["presetId"] === "number" ? data["presetId"] : undefined,
            targetPresetId:
              typeof data["targetPresetId"] === "number" ? data["targetPresetId"] : undefined,
            name: typeof data["name"] === "string" ? data["name"] : undefined,
            position: data["position"],
          });
        }
        break;
      }

      case "freed": {
        if (
          data &&
          typeof data["camId"] === "number" &&
          typeof data["pan"] === "number" &&
          typeof data["tilt"] === "number" &&
          typeof data["zoom"] === "number"
        ) {
          this.cameraMotion.handleFreedTelemetry({
            camId: data["camId"],
            pan: data["pan"],
            tilt: data["tilt"],
            zoom: data["zoom"],
            roll: data["roll"],
            focus: data["focus"],
            receivedAt: data["receivedAt"],
          });
        }
        break;
      }

      case "atem": {
        this.world.updateAtem({
          connected: data?.["connected"],
          programInput: data?.["programInput"],
          previewInput: data?.["previewInput"],
        });
        break;
      }

      case "pivoice":
      case "pisound": {
        this.world.updateAudio({
          isSpeaking: data?.["isSpeaking"] ?? data?.["isSpeech"],
          isMusic: data?.["isMusic"],
          classification: data?.["classification"],
          rmsDbfs: data?.["rmsDbfs"],
          activeSpeakerName: data?.["activeSpeakerName"],
          activeSpeakerZone: data?.["activeSpeakerZone"],
        });
        break;
      }

      case "spatial": {
        this.world.updateSpatial({
          available: true,
          activeZones: data?.["activeZones"],
          subjects: data?.["subjects"],
          subjectsByZone: data?.["subjectsByZone"],
        });
        break;
      }

      case "transcript": {
        if (typeof data?.["text"] === "string") {
          this.world.addTranscript(data["text"]);
        }
        break;
      }

      case "world-state": {
        if (data?.["switcher"]) {
          this.world.updateAtem(data["switcher"]);
        }
        if (data?.["audio"]) {
          this.world.updateAudio(data["audio"]);
        }
        if (data?.["spatial"]) {
          this.world.updateSpatial(data["spatial"]);
        }
        if (data?.["ceremony"]) {
          this.world.updateRundownContext({
            title: data["ceremony"]["title"],
            currentCueId: data["ceremony"]["currentCueId"],
            currentCueTitle: data["ceremony"]["currentCueTitle"],
            assignedSpeaker: data["ceremony"]["assignedSpeaker"],
          });
        }
        break;
      }

      case "rundown":
      case "cue:triggered": {
        this.world.updateRundownContext({
          title: data?.["title"],
          currentCueId: data?.["currentCueId"] ?? data?.["cueId"] ?? data?.["id"],
          currentCueTitle: data?.["currentCueTitle"] ?? data?.["cueTitle"] ?? data?.["itemTitle"],
          currentSection: data?.["currentSection"] ?? data?.["section"],
          assignedSpeaker: data?.["assignedSpeaker"] ?? data?.["speaker"],
          generalAi: data?.["generalAi"] ?? data?.["aiGeneral"],
          currentItemAi: data?.["currentItemAi"] ?? data?.["ai"],
          defaultActions: data?.["defaultActions"] ?? data?.["actions"],
        });

        if (this.autoEvaluateOnCue && this.engine.getMode() !== "manual") {
          const cueLabel = data?.["currentCueId"] ?? data?.["cueId"] ?? "cue_change";
          await this.engine.evaluate(`rundown_cue:${cueLabel}`, { tier: "reasoning" });
        }
        break;
      }

      case "stream.manual_override": {
        const actor = typeof data?.["actor"] === "string" ? data["actor"] : "operator";
        const reason = typeof data?.["reason"] === "string" ? data["reason"] : "Manual stream override";
        this.engine.preempt(reason, actor);
        break;
      }

      case "action": {
        const actor = String(data?.["actor"] ?? "");
        const actionName = String(data?.["action"] ?? "");
        // If a human operator manually switches ATEM or moves a camera, immediately preempt AI
        if (
          actor &&
          actor !== "pidirector" &&
          actor !== "pirundown" &&
          (actionName.startsWith("atem.") || actionName.startsWith("camera."))
        ) {
          this.engine.preempt(`Manual operator action: ${actionName}`, actor);
        }
        break;
      }
    }
  }

  private async connectSseLoop(url: string, signal: AbortSignal): Promise<void> {
    let backoffMs = 1000;

    while (!signal.aborted) {
      try {
        const res = await this.fetchFn(url, {
          headers: { Accept: "text/event-stream" },
          signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        this.connected = true;
        backoffMs = 1000;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";

          for (const block of blocks) {
            await this.parseAndHandleBlock(block);
          }
        }
      } catch (err) {
        this.connected = false;
        if (signal.aborted) return;
        this.logger?.warn?.(
          `SSE connection to ${url} dropped (${err instanceof Error ? err.message : String(err)}). Retrying in ${backoffMs}ms`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 10000);
      }
    }
  }

  private async parseAndHandleBlock(block: string): Promise<void> {
    const lines = block.split("\n");
    let eventType = "message";
    let dataStr = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataStr += line.slice(5).trim();
      }
    }

    if (!dataStr) return;

    try {
      const parsed = JSON.parse(dataStr);
      const type = parsed.type ?? eventType;
      const data = parsed.data ?? parsed;
      await this.handleEvent(type, data);
    } catch {
      // Ignore malformed SSE blocks
    }
  }
}
