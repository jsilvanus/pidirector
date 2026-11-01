# `pidirector` — Local AI Broadcast Director

Autonomous and semi-autonomous **Local AI Stream Director** (`:3401`) for live worship broadcasts at Riihimäen Keskuskirkko in the Pi Ecosystem (`piecosystem`).

## Key Capabilities

1. **100% Local Inference via Ollama**:
   - Structured JSON decision loop (`llama3.2:3b` / `qwen2.5:7b-instruct`) with an **800ms watchdog timer** that automatically falls back to deterministic Rundown v2 rules if inference stalls or Ollama is unreachable.
2. **FreeD Camera Motion & Settling Gate (`motion:moving` / `motion:stopped` / `preset:settled`)**:
   - Tracks real-time FreeD motion events from `picam` and `pigateway`.
   - **Never cuts to a moving camera (`isMoving === true`)**.
   - When recalling a preview preset, `pidirector` issues the preset recall on Preview, waits for the FreeD `preset:settled` / `motion:stopped` event, verifies the camera is stationary and not preempted, and only then cuts ATEM Program.
3. **Fast-Path Deterministic Guardrails (<10ms)**:
   - **On-Air Tally Guard**: Never moves a camera currently live on ATEM Program.
   - **Minimum Shot Dwell Gate**: Prevents rapid cutting / shot flicker (`minShotDwellSec`).
   - **Privacy & Liturgical Constraints**: Blocks congregation closeups and cuts during prayer.
   - **Empty Podium Fallback**: Cross-validates target zones (`pulpit`, `ambo`, `choir`) with `piperception` / `pispace` occupancy and falls back to the wide sanctuary shot if `0` people are detected.
4. **Least-Privilege Execution via `picontrol-mcp`**:
   - Authenticates with the `director` role token (`pcm_director_...`) to execute `atem_switch`, `camera_preset`, `graphics_lower_third`, and `tally_cue`.
5. **Human Steering Entry Points & Dual Modes**:
   - **Modes**: `autonomous` (direct execution), `advisory` (co-pilot shot recommendations for human approval), `manual` (observer/standby).
   - **Live Steering (`/api/v1/steer`)**: Natural-language directives, camera locks, camera exclusions, and pacing overrides.
   - **Sub-5ms Preemption (`/api/v1/preempt` & gateway auto-override)**: Immediately aborts in-flight Ollama inferences and pending camera-settle waits when a human operator intervenes.
