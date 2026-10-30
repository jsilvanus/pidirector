import type { DirectorEventBroker } from "../events.js";
import type { CameraMotionSnapshot } from "../types.js";

export interface RawFreedPacket {
  camId: number;
  pan: number;
  tilt: number;
  zoom: number;
  roll?: number | undefined;
  focus?: number | undefined;
  receivedAt?: string | undefined;
}

export interface CameraEventInput {
  id: string;
  action: string;
  presetId?: number | undefined;
  targetPresetId?: number | undefined;
  name?: string | undefined;
  position?: { pan: number; tilt: number; zoom: number } | undefined;
}

export interface MotionDetectorOptions {
  motionThresholdPanDeg?: number | undefined;
  motionThresholdTiltDeg?: number | undefined;
  motionThresholdZoom?: number | undefined;
  minStationaryFrames?: number | undefined;
  cameraInputMap?: Record<string, number> | undefined;
}

interface InternalCameraState {
  cameraId: string;
  inputNumber: number;
  isMoving: boolean;
  lastAction: string | null;
  settledPresetId: number | null;
  settledPresetName: string | null;
  targetPresetId: number | null;
  position: { pan: number; tilt: number; zoom: number };
  lastMovedAt: string | null;
  lastSettledAt: string | null;
  history: Array<{ pan: number; tilt: number; zoom: number }>;
  stationaryCount: number;
}

export class CameraMotionTracker {
  private readonly states = new Map<string, InternalCameraState>();
  private readonly settleWaiters = new Map<string, Set<() => void>>();
  private readonly eventBroker?: DirectorEventBroker | undefined;
  private readonly motionThresholdPanDeg: number;
  private readonly motionThresholdTiltDeg: number;
  private readonly motionThresholdZoom: number;
  private readonly minStationaryFrames: number;
  private readonly cameraInputMap: Record<string, number>;

  constructor(eventBroker?: DirectorEventBroker, options: MotionDetectorOptions = {}) {
    this.eventBroker = eventBroker;
    this.motionThresholdPanDeg = options.motionThresholdPanDeg ?? 0.05;
    this.motionThresholdTiltDeg = options.motionThresholdTiltDeg ?? 0.05;
    this.motionThresholdZoom = options.motionThresholdZoom ?? 20;
    this.minStationaryFrames = options.minStationaryFrames ?? 3;
    this.cameraInputMap = options.cameraInputMap ?? {
      cam1: 1,
      cam2: 2,
      cam3: 3,
      "1": 1,
      "2": 2,
      "3": 3,
    };

    // Initialize default cameras
    this.getOrCreate("cam1");
    this.getOrCreate("cam2");
    this.getOrCreate("cam3");
  }

  normalizeCameraId(cameraOrInput: string | number): string {
    if (typeof cameraOrInput === "number") {
      if (cameraOrInput === 101 || cameraOrInput === 1) return "cam1";
      if (cameraOrInput === 102 || cameraOrInput === 2) return "cam2";
      if (cameraOrInput === 103 || cameraOrInput === 3) return "cam3";
      return `cam${cameraOrInput}`;
    }
    const trimmed = cameraOrInput.trim().toLowerCase();
    if (trimmed === "1" || trimmed === "101") return "cam1";
    if (trimmed === "2" || trimmed === "102") return "cam2";
    if (trimmed === "3" || trimmed === "103") return "cam3";
    return trimmed.startsWith("cam") ? trimmed : `cam${trimmed}`;
  }

  getInputNumberForCamera(cameraOrInput: string | number): number {
    if (typeof cameraOrInput === "number" && cameraOrInput < 100) {
      return cameraOrInput;
    }
    const camId = this.normalizeCameraId(cameraOrInput);
    return this.cameraInputMap[camId] ?? (Number.parseInt(camId.replace(/\D+/g, ""), 10) || 1);
  }

  isCameraMoving(cameraOrInput: string | number): boolean {
    const camId = this.normalizeCameraId(cameraOrInput);
    return this.states.get(camId)?.isMoving ?? false;
  }

  getSnapshot(cameraOrInput: string | number): CameraMotionSnapshot {
    const camId = this.normalizeCameraId(cameraOrInput);
    const state = this.getOrCreate(camId);
    return this.toSnapshot(state);
  }

  getAllSnapshots(): Record<string, CameraMotionSnapshot> {
    const out: Record<string, CameraMotionSnapshot> = {};
    for (const [id, state] of this.states.entries()) {
      out[id] = this.toSnapshot(state);
    }
    return out;
  }

  /**
   * Handle discrete camera events from picam or pigateway (`motion:moving`, `motion:stopped`, `preset:settled`, `preset:recall`, `pantilt:*`, `zoom:*`)
   */
  handleCameraEvent(evt: CameraEventInput): CameraMotionSnapshot {
    const camId = this.normalizeCameraId(evt.id);
    const state = this.getOrCreate(camId);
    const now = new Date().toISOString();
    const prevMoving = state.isMoving;

    if (evt.position) {
      state.position = { ...evt.position };
    }
    state.lastAction = evt.action;

    if (evt.action === "motion:moving") {
      state.isMoving = true;
      state.settledPresetId = null;
      state.settledPresetName = null;
      state.stationaryCount = 0;
      state.lastMovedAt = now;
    } else if (evt.action === "preset:recall") {
      state.targetPresetId = evt.targetPresetId ?? evt.presetId ?? null;
      state.settledPresetId = null;
      state.settledPresetName = null;
      state.stationaryCount = 0;
    } else if (evt.action === "preset:settled") {
      state.isMoving = false;
      state.settledPresetId = evt.presetId ?? state.targetPresetId ?? null;
      state.settledPresetName = evt.name ?? null;
      state.targetPresetId = null;
      state.lastSettledAt = now;
      this.notifySettled(camId);
    } else if (evt.action === "motion:stopped") {
      state.isMoving = false;
      state.targetPresetId = null;
      state.lastSettledAt = now;
      this.notifySettled(camId);
    } else if (evt.action.startsWith("pantilt:")) {
      const dir = evt.action.slice("pantilt:".length);
      if (dir === "stop") {
        state.isMoving = false;
        state.lastSettledAt = now;
        this.notifySettled(camId);
      } else {
        state.isMoving = true;
        state.settledPresetId = null;
        state.settledPresetName = null;
        state.lastMovedAt = now;
      }
    } else if (evt.action.startsWith("zoom:")) {
      const z = evt.action.slice("zoom:".length);
      if (z === "stop") {
        state.isMoving = false;
        state.lastSettledAt = now;
        this.notifySettled(camId);
      } else {
        state.isMoving = true;
        state.settledPresetId = null;
        state.settledPresetName = null;
        state.lastMovedAt = now;
      }
    }

    const snap = this.toSnapshot(state);
    if (prevMoving !== state.isMoving || evt.action === "preset:settled" || evt.action === "motion:moving" || evt.action === "motion:stopped") {
      this.eventBroker?.emit({ type: "camera-motion", data: snap });
    }
    return snap;
  }

  /**
   * Handle raw FreeD D1 telemetry packets from pigateway when picam hasn't already digested them
   */
  handleFreedTelemetry(packet: RawFreedPacket): CameraMotionSnapshot {
    const camId = this.normalizeCameraId(packet.camId);
    const state = this.getOrCreate(camId);
    const now = packet.receivedAt ?? new Date().toISOString();

    const current = { pan: packet.pan, tilt: packet.tilt, zoom: packet.zoom };
    state.position = { ...current };
    state.history.push(current);
    if (state.history.length > 10) {
      state.history.shift();
    }

    if (state.history.length < 2) {
      return this.toSnapshot(state);
    }

    const prev = state.history[state.history.length - 2]!;
    const dPan = Math.abs(current.pan - prev.pan);
    const dTilt = Math.abs(current.tilt - prev.tilt);
    const dZoom = Math.abs(current.zoom - prev.zoom);

    const isFrameMoving =
      dPan > this.motionThresholdPanDeg ||
      dTilt > this.motionThresholdTiltDeg ||
      dZoom > this.motionThresholdZoom;

    if (isFrameMoving) {
      state.stationaryCount = 0;
      if (!state.isMoving) {
        state.isMoving = true;
        state.lastAction = "motion:moving";
        state.settledPresetId = null;
        state.settledPresetName = null;
        state.lastMovedAt = now;
        const snap = this.toSnapshot(state);
        this.eventBroker?.emit({ type: "camera-motion", data: snap });
        return snap;
      }
      return this.toSnapshot(state);
    }

    state.stationaryCount++;
    if (state.stationaryCount >= this.minStationaryFrames && state.isMoving) {
      state.isMoving = false;
      if (state.targetPresetId !== null) {
        state.settledPresetId = state.targetPresetId;
        state.lastAction = "preset:settled";
        state.targetPresetId = null;
      } else {
        state.lastAction = "motion:stopped";
      }
      state.lastSettledAt = now;
      this.notifySettled(camId);
      const snap = this.toSnapshot(state);
      this.eventBroker?.emit({ type: "camera-motion", data: snap });
      return snap;
    }

    return this.toSnapshot(state);
  }

  /**
   * Mark a camera as starting a preset recall initiated by pidirector
   */
  markPresetRecallInitiated(cameraOrInput: string | number, preset: string | number): void {
    const camId = this.normalizeCameraId(cameraOrInput);
    const presetNum = typeof preset === "number" ? preset : Number.parseInt(String(preset), 10);
    this.handleCameraEvent({
      id: camId,
      action: "preset:recall",
      presetId: Number.isNaN(presetNum) ? undefined : presetNum,
      targetPresetId: Number.isNaN(presetNum) ? undefined : presetNum,
    });
  }

  /**
   * Wait until a camera settles (`preset:settled` or `motion:stopped`) before cutting to it.
   * If a preset recall was just initiated (`targetPresetId !== null`) and `isMoving` is not yet true,
   * observes a brief FreeD acquisition window (40ms) so incoming `motion:moving` frames lock the gate
   * until `preset:settled` / `motion:stopped` arrives.
   */
  async waitForCameraSettle(
    cameraOrInput: string | number,
    timeoutMs: number,
    signal?: AbortSignal,
    acquireWindowMs = 40
  ): Promise<{ settled: boolean; elapsedMs: number; reason?: string }> {
    const camId = this.normalizeCameraId(cameraOrInput);
    const state = this.getOrCreate(camId);
    const start = Date.now();

    if (signal?.aborted) {
      return { settled: false, elapsedMs: 0, reason: "aborted" };
    }

    if (!state.isMoving && state.targetPresetId !== null && acquireWindowMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, acquireWindowMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
      });
      if (signal?.aborted) {
        return { settled: false, elapsedMs: Date.now() - start, reason: "aborted" };
      }
    }

    if (!state.isMoving) {
      state.targetPresetId = null;
      return { settled: true, elapsedMs: Date.now() - start };
    }

    return new Promise((resolve) => {
      let finished = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        const set = this.settleWaiters.get(camId);
        if (set) {
          set.delete(onSettle);
        }
        signal?.removeEventListener("abort", onAbort);
      };

      const onSettle = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve({ settled: true, elapsedMs: Date.now() - start });
      };

      const onAbort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve({ settled: false, elapsedMs: Date.now() - start, reason: "aborted" });
      };

      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve({ settled: false, elapsedMs: Date.now() - start, reason: "timeout" });
      }, timeoutMs);

      let set = this.settleWaiters.get(camId);
      if (!set) {
        set = new Set();
        this.settleWaiters.set(camId, set);
      }
      set.add(onSettle);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private notifySettled(camId: string): void {
    const waiters = this.settleWaiters.get(camId);
    if (!waiters || waiters.size === 0) return;
    for (const fn of [...waiters]) {
      fn();
    }
  }

  private getOrCreate(camId: string): InternalCameraState {
    let state = this.states.get(camId);
    if (!state) {
      state = {
        cameraId: camId,
        inputNumber: this.getInputNumberForCamera(camId),
        isMoving: false,
        lastAction: null,
        settledPresetId: null,
        settledPresetName: null,
        targetPresetId: null,
        position: { pan: 0, tilt: 0, zoom: 0 },
        lastMovedAt: null,
        lastSettledAt: null,
        history: [],
        stationaryCount: 0,
      };
      this.states.set(camId, state);
    }
    return state;
  }

  private toSnapshot(state: InternalCameraState): CameraMotionSnapshot {
    return {
      cameraId: state.cameraId,
      inputNumber: state.inputNumber,
      isMoving: state.isMoving,
      lastAction: state.lastAction,
      settledPresetId: state.settledPresetId,
      settledPresetName: state.settledPresetName,
      targetPresetId: state.targetPresetId,
      position: { ...state.position },
      lastMovedAt: state.lastMovedAt,
      lastSettledAt: state.lastSettledAt,
    };
  }
}
