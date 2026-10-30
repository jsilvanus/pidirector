import { EventEmitter } from "node:events";
import type {
  AdvisoryShot,
  BroadcastStats,
  CameraMotionSnapshot,
  DecisionHistoryEntry,
  DirectorDecision,
  DirectorLogEntry,
  DirectorMode,
  GuardrailVerdict,
  HumanSteeringState,
} from "./types.js";

export type DirectorEvent =
  | { type: "ready"; data: { status: string; mode: DirectorMode; time: string } }
  | { type: "mode-changed"; data: { mode: DirectorMode; previousMode: DirectorMode; reason?: string | undefined; time: string } }
  | { type: "steering-updated"; data: HumanSteeringState }
  | { type: "camera-motion"; data: CameraMotionSnapshot }
  | { type: "decision"; data: { trigger: string; source: string; decision: DirectorDecision; verdict: GuardrailVerdict; time: string } }
  | { type: "advisory"; data: AdvisoryShot }
  | { type: "executed"; data: DecisionHistoryEntry }
  | { type: "suppressed"; data: { trigger: string; reason: string; decision: DirectorDecision; time: string } }
  | { type: "preempted"; data: { reason: string; actor: string; previousMode: DirectorMode; newMode: DirectorMode; time: string } }
  | { type: "log"; data: DirectorLogEntry }
  | { type: "broadcast-dumped"; data: { broadcastId: string; filePath: string; endedAt: string; stats: BroadcastStats } };

export class DirectorEventBroker {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: DirectorEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: DirectorEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount("event");
  }
}
