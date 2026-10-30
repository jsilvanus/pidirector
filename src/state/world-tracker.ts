import type { DirectorEventBroker } from "../events.js";
import type {
  AiConstraints,
  AiGeneralInstructions,
  AiItemInstructions,
  HumanSteeringPatch,
  HumanSteeringState,
} from "../types.js";

export interface SwitcherSnapshot {
  connected: boolean;
  programInput: number;
  previewInput: number;
  lastCutAtMs: number;
  dwellSec: number;
}

export interface AudioSnapshot {
  isSpeaking: boolean;
  isMusic: boolean;
  classification: "speech" | "music" | "silence";
  rmsDbfs: number | null;
  activeSpeakerName: string | null;
  activeSpeakerZone: string | null;
}

export interface SpatialSnapshot {
  available: boolean;
  activeZones: string[];
  subjectsByZone: Record<string, number>;
  subjectsCount: number;
  updatedAt: string | null;
}

export interface RundownLevelTiming {
  index?: number | undefined;
  total?: number | undefined;
  place?: string | undefined;
  id?: string | undefined;
  title?: string | undefined;
  elapsedSec: number;
  expectedDurationSec: number | null;
  timerSec?: number | null | undefined;
  timing: string;
  overtime?: boolean | undefined;
}

export interface RundownProgressInfo {
  placeInEvent: string;
  service: {
    elapsedSec: number;
    expectedDurationSec: number | null;
    timing: string;
    overtime?: boolean | undefined;
  };
  section: {
    index: number;
    total: number;
    place: string;
    id: string;
    title: string;
    elapsedSec: number;
    expectedDurationSec: number | null;
    timerSec?: number | null | undefined;
    timing: string;
    overtime?: boolean | undefined;
  } | null;
  subsection: {
    index: number;
    total: number;
    place: string;
    id: string;
    title: string;
    elapsedSec: number;
    expectedDurationSec: number | null;
    timerSec?: number | null | undefined;
    timing: string;
    overtime?: boolean | undefined;
  } | null;
  summary: string;
}

export interface RundownNextItemInfo {
  id: string;
  line?: number | undefined;
  index?: number | undefined;
  title: string;
  section?: string | null | undefined;
  cueSummary?: string | null | undefined;
  cue?: unknown | undefined;
  expectedDurationSec?: number | null | undefined;
  timerSec?: number | null | undefined;
  ai?: AiItemInstructions | string | null | undefined;
}

export interface RundownContextSnapshot {
  title: string | null;
  service: string | null;
  church: string | null;
  date: string | null;
  currentIndex: number;
  totalItems: number;
  placeInEvent: string | null;
  currentCueId: string | null;
  currentCueTitle: string | null;
  currentSection: string | null;
  assignedSpeaker: string | null;
  expectedDurationSec: number | null;
  timerSec: number | null;
  progress: RundownProgressInfo | null;
  nextItem: RundownNextItemInfo | null;
  generalAi: AiGeneralInstructions;
  currentItemAi: AiItemInstructions | null;
  defaultActions: Array<Record<string, unknown> | string>;
}

export class WorldTracker {
  private readonly eventBroker?: DirectorEventBroker | undefined;

  private switcher = {
    connected: true,
    programInput: 1,
    previewInput: 2,
    lastCutAtMs: 0,
  };

  private audio: AudioSnapshot = {
    isSpeaking: false,
    isMusic: false,
    classification: "silence",
    rmsDbfs: null,
    activeSpeakerName: null,
    activeSpeakerZone: null,
  };

  private spatial: SpatialSnapshot = {
    available: false,
    activeZones: [],
    subjectsByZone: {},
    subjectsCount: 0,
    updatedAt: null,
  };

  private rundown: RundownContextSnapshot = {
    title: null,
    service: null,
    church: null,
    date: null,
    currentIndex: -1,
    totalItems: 0,
    placeInEvent: null,
    currentCueId: null,
    currentCueTitle: null,
    currentSection: null,
    assignedSpeaker: null,
    expectedDurationSec: null,
    timerSec: null,
    progress: null,
    nextItem: null,
    generalAi: {
      pacing: "liturgical",
      style: "Dignified, calm, contemplative Nordic Lutheran liturgy.",
      guidelines: [
        "Never cut to an empty podium or unlit zone.",
        "When hymns or organ play, cut to choir/organ or wide sanctuary.",
        "Maintain wide establishing shot during communion distribution to protect attendee privacy.",
      ],
      constraints: {
        disallowCongregationCloseup: true,
        minShotDwellSec: 4,
        maxShotDwellSec: 30,
        avoidCutsDuringPrayer: true,
        disallowMoveWhileOnAir: true,
      },
      cameraRoles: {
        "1": "Wide altar and sanctuary view",
        "2": "Pulpit (saarnatuoli) and ambo medium/close",
        "3": "Organ loft and choir",
      },
    },
    currentItemAi: null,
    defaultActions: [],
  };

  private steering: HumanSteeringState = {
    instruction: null,
    pacing: null,
    lockCamera: null,
    excludeCameras: [],
    minShotDwellSec: null,
    maxShotDwellSec: null,
    disallowCongregationCloseup: null,
    avoidCutsDuringPrayer: null,
    disallowMoveWhileOnAir: null,
    updatedAt: null,
  };

  private readonly transcripts: Array<{ text: string; timestamp: string }> = [];

  constructor(eventBroker?: DirectorEventBroker, initialMinDwellSec = 4, initialMaxDwellSec = 30) {
    this.eventBroker = eventBroker;
    this.rundown.generalAi.constraints.minShotDwellSec = initialMinDwellSec;
    this.rundown.generalAi.constraints.maxShotDwellSec = initialMaxDwellSec;
  }

  getSwitcher(nowMs = Date.now()): SwitcherSnapshot {
    const dwellSec =
      this.switcher.lastCutAtMs > 0
        ? Math.max(0, Math.round(((nowMs - this.switcher.lastCutAtMs) / 1000) * 10) / 10)
        : 999;
    return {
      ...this.switcher,
      dwellSec,
    };
  }

  updateAtem(data: {
    connected?: boolean | undefined;
    programInput?: number | null | undefined;
    previewInput?: number | null | undefined;
  }, nowMs = Date.now()): void {
    if (data.connected !== undefined) {
      this.switcher.connected = data.connected;
    }
    if (typeof data.programInput === "number" && data.programInput !== this.switcher.programInput) {
      this.switcher.programInput = data.programInput;
      this.switcher.lastCutAtMs = nowMs;
    }
    if (typeof data.previewInput === "number") {
      this.switcher.previewInput = data.previewInput;
    }
  }

  recordProgramCut(programInput: number, previewInput?: number, nowMs = Date.now()): void {
    if (previewInput !== undefined) {
      this.switcher.previewInput = previewInput;
    } else if (this.switcher.programInput !== programInput) {
      this.switcher.previewInput = this.switcher.programInput;
    }
    this.switcher.programInput = programInput;
    this.switcher.lastCutAtMs = nowMs;
  }

  recordPreviewChange(previewInput: number): void {
    this.switcher.previewInput = previewInput;
  }

  resetDwellTimer(nowMs = Date.now()): void {
    this.switcher.lastCutAtMs = nowMs;
  }

  getAudio(): AudioSnapshot {
    return { ...this.audio };
  }

  updateAudio(data: {
    isSpeaking?: boolean | undefined;
    isMusic?: boolean | undefined;
    classification?: string | undefined;
    rmsDbfs?: number | null | undefined;
    activeSpeakerName?: string | null | undefined;
    activeSpeakerZone?: string | null | undefined;
  }): void {
    const isMusic = data.isMusic ?? data.classification === "music";
    const isSpeaking = data.isSpeaking ?? data.classification === "speech";
    this.audio = {
      isSpeaking: Boolean(isSpeaking),
      isMusic: Boolean(isMusic),
      classification: isMusic ? "music" : isSpeaking ? "speech" : "silence",
      rmsDbfs: data.rmsDbfs !== undefined ? data.rmsDbfs : this.audio.rmsDbfs,
      activeSpeakerName:
        data.activeSpeakerName !== undefined ? data.activeSpeakerName : this.audio.activeSpeakerName,
      activeSpeakerZone:
        data.activeSpeakerZone !== undefined ? data.activeSpeakerZone : this.audio.activeSpeakerZone,
    };
  }

  getSpatial(): SpatialSnapshot {
    return {
      ...this.spatial,
      activeZones: [...this.spatial.activeZones],
      subjectsByZone: { ...this.spatial.subjectsByZone },
    };
  }

  updateSpatial(data: {
    available?: boolean | undefined;
    activeZones?: string[] | undefined;
    subjects?: Array<{ zoneId?: string | null; zoneName?: string | null }> | undefined;
    subjectsByZone?: Record<string, number> | undefined;
  }): void {
    const byZone: Record<string, number> = { ...(data.subjectsByZone ?? {}) };
    if (Array.isArray(data.subjects)) {
      for (const s of data.subjects) {
        const z = (s.zoneId ?? s.zoneName ?? "").toLowerCase().trim();
        if (z) {
          byZone[z] = (byZone[z] ?? 0) + 1;
        }
      }
    }
    if (Array.isArray(data.activeZones)) {
      for (const z of data.activeZones) {
        const key = z.toLowerCase().trim();
        if (key && !byZone[key]) {
          byZone[key] = 1;
        }
      }
    }
    const activeZones = Object.keys(byZone).filter((k) => (byZone[k] ?? 0) > 0);
    const total = Object.values(byZone).reduce((a, b) => a + b, 0);

    this.spatial = {
      available: data.available ?? true,
      activeZones,
      subjectsByZone: byZone,
      subjectsCount: total,
      updatedAt: new Date().toISOString(),
    };
  }

  isZoneOccupied(zoneName: string): boolean | null {
    if (!this.spatial.available) {
      return null; // Unknown when spatial perception subsystem is offline
    }
    const normalized = zoneName.toLowerCase().trim();
    if (normalized === "wide" || normalized === "sanctuary") {
      return true;
    }
    const count = this.spatial.subjectsByZone[normalized] ?? 0;
    return count > 0 || this.spatial.activeZones.some((z) => z.toLowerCase() === normalized);
  }

  addTranscript(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.transcripts.push({
      text: trimmed,
      timestamp: new Date().toISOString(),
    });
    if (this.transcripts.length > 20) {
      this.transcripts.shift();
    }
  }

  getRecentTranscripts(): Array<{ text: string; timestamp: string }> {
    return [...this.transcripts];
  }

  getRundown(): RundownContextSnapshot {
    return {
      ...this.rundown,
      progress: this.rundown.progress
        ? {
            ...this.rundown.progress,
            service: { ...this.rundown.progress.service },
            section: this.rundown.progress.section ? { ...this.rundown.progress.section } : null,
            subsection: this.rundown.progress.subsection
              ? { ...this.rundown.progress.subsection }
              : null,
          }
        : null,
      nextItem: this.rundown.nextItem ? { ...this.rundown.nextItem } : null,
      generalAi: {
        ...this.rundown.generalAi,
        guidelines: [...this.rundown.generalAi.guidelines],
        constraints: { ...this.rundown.generalAi.constraints },
      },
      currentItemAi: this.rundown.currentItemAi ? { ...this.rundown.currentItemAi } : null,
      defaultActions: [...this.rundown.defaultActions],
    };
  }

  updateRundownContext(data: {
    title?: string | null | undefined;
    service?: string | null | undefined;
    church?: string | null | undefined;
    date?: string | null | undefined;
    currentIndex?: number | undefined;
    totalItems?: number | undefined;
    placeInEvent?: string | null | undefined;
    currentCueId?: string | null | undefined;
    currentCueTitle?: string | null | undefined;
    currentSection?: string | null | undefined;
    assignedSpeaker?: string | null | undefined;
    expectedDurationSec?: number | null | undefined;
    timerSec?: number | null | undefined;
    progress?: RundownProgressInfo | null | undefined;
    nextItem?: RundownNextItemInfo | null | undefined;
    generalAi?: Partial<AiGeneralInstructions> | undefined;
    currentItemAi?: AiItemInstructions | null | undefined;
    defaultActions?: Array<Record<string, unknown> | string> | undefined;
  }): void {
    if (data.title !== undefined) this.rundown.title = data.title;
    if (data.service !== undefined) this.rundown.service = data.service;
    if (data.church !== undefined) this.rundown.church = data.church;
    if (data.date !== undefined) this.rundown.date = data.date;
    if (data.currentIndex !== undefined) this.rundown.currentIndex = data.currentIndex;
    if (data.totalItems !== undefined) this.rundown.totalItems = data.totalItems;
    if (data.currentCueId !== undefined) this.rundown.currentCueId = data.currentCueId;
    if (data.currentCueTitle !== undefined) this.rundown.currentCueTitle = data.currentCueTitle;
    if (data.currentSection !== undefined) this.rundown.currentSection = data.currentSection;
    if (data.assignedSpeaker !== undefined) this.rundown.assignedSpeaker = data.assignedSpeaker;
    if (data.expectedDurationSec !== undefined) {
      this.rundown.expectedDurationSec = data.expectedDurationSec;
    }
    if (data.timerSec !== undefined) {
      this.rundown.timerSec = data.timerSec;
    }
    if (data.progress !== undefined) {
      this.rundown.progress = data.progress;
    }
    if (data.nextItem !== undefined) {
      this.rundown.nextItem = data.nextItem;
    }
    if (data.placeInEvent !== undefined) {
      this.rundown.placeInEvent = data.placeInEvent;
    } else if (this.rundown.progress?.placeInEvent) {
      this.rundown.placeInEvent = this.rundown.progress.placeInEvent;
    } else if (this.rundown.currentIndex >= 0 && this.rundown.totalItems > 0) {
      const label = this.rundown.currentCueTitle ? ` ${this.rundown.currentCueTitle}` : "";
      this.rundown.placeInEvent = `${this.rundown.currentIndex + 1}/${this.rundown.totalItems}${label}`;
    }
    if (data.generalAi) {
      this.rundown.generalAi = {
        ...this.rundown.generalAi,
        ...data.generalAi,
        guidelines: data.generalAi.guidelines ?? this.rundown.generalAi.guidelines,
        constraints: {
          ...this.rundown.generalAi.constraints,
          ...(data.generalAi.constraints ?? {}),
        },
      };
    }
    if (data.currentItemAi !== undefined) {
      this.rundown.currentItemAi = data.currentItemAi;
    }
    if (data.defaultActions !== undefined) {
      this.rundown.defaultActions = data.defaultActions;
    }
  }

  getSteering(): HumanSteeringState {
    return {
      ...this.steering,
      excludeCameras: [...this.steering.excludeCameras],
    };
  }

  updateSteering(patch: HumanSteeringPatch): HumanSteeringState {
    if (patch.instruction !== undefined) this.steering.instruction = patch.instruction;
    if (patch.pacing !== undefined) this.steering.pacing = patch.pacing;
    if (patch.lockCamera !== undefined) this.steering.lockCamera = patch.lockCamera;
    if (patch.excludeCameras !== undefined) this.steering.excludeCameras = [...patch.excludeCameras];
    if (patch.minShotDwellSec !== undefined) this.steering.minShotDwellSec = patch.minShotDwellSec;
    if (patch.maxShotDwellSec !== undefined) this.steering.maxShotDwellSec = patch.maxShotDwellSec;
    if (patch.disallowCongregationCloseup !== undefined) {
      this.steering.disallowCongregationCloseup = patch.disallowCongregationCloseup;
    }
    if (patch.avoidCutsDuringPrayer !== undefined) {
      this.steering.avoidCutsDuringPrayer = patch.avoidCutsDuringPrayer;
    }
    if (patch.disallowMoveWhileOnAir !== undefined) {
      this.steering.disallowMoveWhileOnAir = patch.disallowMoveWhileOnAir;
    }
    this.steering.updatedAt = new Date().toISOString();

    const snap = this.getSteering();
    this.eventBroker?.emit({ type: "steering-updated", data: snap });
    return snap;
  }

  /**
   * Computes effective constraints combining Rundown v2 AI constraints and Human Steering overrides
   */
  getEffectiveConstraints(): AiConstraints {
    const base = this.rundown.generalAi.constraints;
    const itemMinDuration = this.rundown.currentItemAi?.minDurationSec;
    return {
      disallowCongregationCloseup:
        this.steering.disallowCongregationCloseup ?? base.disallowCongregationCloseup,
      minShotDwellSec:
        this.steering.minShotDwellSec ?? itemMinDuration ?? base.minShotDwellSec,
      maxShotDwellSec: this.steering.maxShotDwellSec ?? base.maxShotDwellSec,
      avoidCutsDuringPrayer:
        this.steering.avoidCutsDuringPrayer ?? base.avoidCutsDuringPrayer,
      disallowMoveWhileOnAir:
        this.steering.disallowMoveWhileOnAir ?? base.disallowMoveWhileOnAir,
    };
  }

  isPrayerMoment(): boolean {
    const title = (this.rundown.currentCueTitle ?? "").toLowerCase();
    const section = (this.rundown.currentSection ?? "").toLowerCase();
    const cueId = (this.rundown.currentCueId ?? "").toLowerCase();
    return (
      title.includes("rukous") ||
      title.includes("prayer") ||
      title.includes("esirukous") ||
      section.includes("rukous") ||
      cueId.includes("rukous") ||
      cueId.includes("prayer")
    );
  }
}
