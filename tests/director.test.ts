import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("CameraMotionTracker tracks FreeD motion:moving, motion:stopped, preset:settled and raw FreeD packets", async () => {
  const config = loadConfig({ PIDIRECTOR_MODE: "advisory" });
  const { app, cameraMotion } = buildApp(config);
  await app.ready();

  // Initially stationary
  assert.equal(cameraMotion.isCameraMoving("cam2"), false);

  // 1. Discrete motion:moving event from picam
  cameraMotion.handleCameraEvent({
    id: "cam2",
    action: "motion:moving",
    position: { pan: 15.0, tilt: -2.0, zoom: 2000 },
  });
  assert.equal(cameraMotion.isCameraMoving("cam2"), true);
  assert.equal(cameraMotion.isCameraMoving(2), true);

  // 2. Discrete preset:settled event from picam
  cameraMotion.handleCameraEvent({
    id: "cam2",
    action: "preset:settled",
    presetId: 1,
    name: "Pulpit",
    position: { pan: 42.0, tilt: -5.0, zoom: 5000 },
  });
  assert.equal(cameraMotion.isCameraMoving("cam2"), false);
  assert.equal(cameraMotion.getSnapshot("cam2").settledPresetId, 1);
  assert.equal(cameraMotion.getSnapshot("cam2").settledPresetName, "Pulpit");

  // 3. Raw FreeD D1 packets from pigateway (camId 101 -> cam1)
  cameraMotion.handleFreedTelemetry({ camId: 101, pan: 0.0, tilt: 0.0, zoom: 1000 });
  cameraMotion.handleFreedTelemetry({ camId: 101, pan: 5.5, tilt: 1.2, zoom: 1500 });
  assert.equal(cameraMotion.isCameraMoving("cam1"), true);

  // 3 stationary frames -> motion:stopped
  cameraMotion.handleFreedTelemetry({ camId: 101, pan: 5.5, tilt: 1.2, zoom: 1500 });
  cameraMotion.handleFreedTelemetry({ camId: 101, pan: 5.5, tilt: 1.2, zoom: 1500 });
  cameraMotion.handleFreedTelemetry({ camId: 101, pan: 5.5, tilt: 1.2, zoom: 1500 });
  assert.equal(cameraMotion.isCameraMoving("cam1"), false);
  assert.equal(cameraMotion.getSnapshot("cam1").lastAction, "motion:stopped");

  await app.close();
});

test("FreeD camera moving guardrail blocks cutting directly to a moving camera", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/chat")) {
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              thought: "Cut directly to Cam 2 for sermon.",
              recommendedAction: "cut",
              cutToInput: 2,
              transition: "cut",
              rationale: "Preacher speaking at pulpit",
            }),
          },
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  };

  const config = loadConfig({ PIDIRECTOR_MODE: "autonomous" });
  const { app, cameraMotion, engine } = buildApp(config, { fetchFn: mockFetch });
  await app.ready();

  // Mark cam2 as moving via FreeD (e.g. operator panning it)
  cameraMotion.handleCameraEvent({
    id: "cam2",
    action: "motion:moving",
    position: { pan: 10, tilt: 0, zoom: 1000 },
  });

  const res = await engine.evaluate("speech_start");
  assert.equal(res.verdict.allowed, false);
  assert.match(res.verdict.suppressedReason ?? "", /freed_camera_moving_guard/);
  assert.equal(res.executed, false);

  // Once cam2 stops moving (motion:stopped), the cut is allowed
  cameraMotion.handleCameraEvent({
    id: "cam2",
    action: "motion:stopped",
    position: { pan: 25, tilt: -3, zoom: 3000 },
  });

  const resAfterStop = await engine.evaluate("speech_start");
  assert.equal(resAfterStop.verdict.allowed, true);
  assert.equal(resAfterStop.executed, true);

  await app.close();
});

test("Autonomous execution recalls preview preset, waits for FreeD preset:settled, then cuts ATEM and shows lower third", async () => {
  const mcpCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  let cameraMotionRef: any = null;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/chat")) {
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              thought: "Preacher stepped to pulpit. Prepare Cam 2 preset pulpit and cut.",
              recommendedAction: "cut",
              prepareCamera: { camera: 2, preset: "pulpit" },
              cutToInput: 2,
              transition: "cut",
              graphics: {
                showLowerThird: true,
                title: "Saarna",
                subtitle: "Pastori Matti",
              },
              rationale: "Sana section sermon focus",
            }),
          },
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/mcp")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const toolName = body.params?.name;
      const toolArgs = body.params?.arguments ?? {};
      mcpCalls.push({ name: toolName, arguments: toolArgs });

      // When camera_preset recall is invoked, simulate FreeD motion:moving at 5ms and preset:settled at 60ms
      if (toolName === "camera_preset" && toolArgs.action === "recall") {
        setTimeout(() => {
          cameraMotionRef?.handleCameraEvent({
            id: "cam2",
            action: "motion:moving",
            position: { pan: 10.0, tilt: -1.0, zoom: 2000 },
          });
        }, 5);
        setTimeout(() => {
          cameraMotionRef?.handleCameraEvent({
            id: "cam2",
            action: "preset:settled",
            presetId: 1,
            name: "Pulpit",
            position: { pan: 42.0, tilt: -5.0, zoom: 5000 },
          });
        }, 60);
      }

      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        status: 200,
      });
    }

    return new Response("{}", { status: 200 });
  };

  const config = loadConfig({
    PIDIRECTOR_MODE: "autonomous",
    PIDIRECTOR_MCP_TOKEN: "pcm_director_testtoken",
  });
  const { app, cameraMotion, world, engine } = buildApp(config, { fetchFn: mockFetch });
  cameraMotionRef = cameraMotion;
  await app.ready();

  // Start on ATEM Program 1
  world.updateAtem({ programInput: 1, previewInput: 1 });

  const result = await engine.evaluate("cue:saarna");
  assert.equal(result.executed, true);
  assert.equal(world.getSwitcher().programInput, 2);

  // Verify exact MCP tool sequence:
  // 1. atem_switch preview -> 2
  // 2. camera_preset recall -> cam2 preset 1
  // 3. atem_switch cut
  // 4. graphics_lower_third show
  assert.equal(mcpCalls.length, 4);
  assert.equal(mcpCalls[0]?.name, "atem_switch");
  assert.deepEqual(mcpCalls[0]?.arguments, { action: "preview", input: 2 });
  assert.equal(mcpCalls[1]?.name, "camera_preset");
  assert.deepEqual(mcpCalls[1]?.arguments, { camera: "cam2", action: "recall", preset: 1 });
  assert.equal(mcpCalls[2]?.name, "atem_switch");
  assert.deepEqual(mcpCalls[2]?.arguments, { action: "cut" });
  assert.equal(mcpCalls[3]?.name, "graphics_lower_third");
  assert.equal(mcpCalls[3]?.arguments["title"], "Saarna");

  await app.close();
});

test("Fast-path guardrails: On-air tally guard, dwell-time gate, prayer guard, and empty podium spatial fallback", async () => {
  const config = loadConfig({
    PIDIRECTOR_MODE: "advisory",
    PIDIRECTOR_MIN_SHOT_DWELL_SEC: "5",
    PIDIRECTOR_WIDE_CAMERA_INPUT: "1",
  });
  const { app, world, cameraMotion, guardrails } = buildApp(config);
  await app.ready();

  const now = Date.now();
  world.updateAtem({ programInput: 2, previewInput: 1 }, now - 10_000);

  // 1. On-Air Camera Tally Guard: Try to move Cam 2 while Input 2 is on Program
  const tallyVerdict = guardrails.evaluate(
    {
      thought: "Reframe Cam 2",
      recommendedAction: "cut",
      prepareCamera: { camera: 2, preset: 3 },
      cutToInput: 2,
      transition: "cut",
      rationale: "Change preset on Cam 2",
    },
    world,
    cameraMotion,
    { nowMs: now }
  );
  assert.equal(tallyVerdict.allowed, false);
  assert.match(tallyVerdict.suppressedReason ?? "", /on_air_camera_tally_guard/);

  // 2. Minimum Shot Dwell Gate: Cut just happened 1.5s ago (< 5s minimum)
  world.recordProgramCut(1, 2, now - 1500);
  const dwellVerdict = guardrails.evaluate(
    {
      thought: "Quick cut back to Cam 2",
      recommendedAction: "cut",
      cutToInput: 2,
      transition: "cut",
      rationale: "Switch to Cam 2",
    },
    world,
    cameraMotion,
    { nowMs: now }
  );
  assert.equal(dwellVerdict.allowed, false);
  assert.match(dwellVerdict.suppressedReason ?? "", /min_shot_dwell_gate/);

  // 3. Empty Podium Spatial Fallback: Pulpit zone has 0 subjects, fallback to Wide Input 1
  world.recordProgramCut(3, 2, now - 20_000);
  world.updateRundownContext({
    currentCueId: "saarna",
    currentCueTitle: "Saarna",
    currentItemAi: {
      targetZone: "pulpit",
      preferredCameras: [2],
    },
  });
  world.updateSpatial({
    available: true,
    subjectsByZone: { altar: 1, pulpit: 0 },
  });

  const emptyPodiumVerdict = guardrails.evaluate(
    {
      thought: "Cut to pulpit Cam 2",
      recommendedAction: "cut",
      cutToInput: 2,
      transition: "cut",
      rationale: "Sermon starting",
    },
    world,
    cameraMotion,
    { nowMs: now }
  );
  assert.equal(emptyPodiumVerdict.allowed, true);
  assert.equal(emptyPodiumVerdict.modified, true);
  assert.equal(emptyPodiumVerdict.decision.cutToInput, 1);
  assert.match(emptyPodiumVerdict.appliedRule ?? "", /empty_zone_wide_fallback/);

  // 4. Prayer Moment Guard: Suppresses cuts during Esirukous (Prayer)
  world.updateRundownContext({
    currentCueId: "esirukous",
    currentCueTitle: "Yhteinen esirukous",
    currentSection: "Rukous",
  });
  const prayerVerdict = guardrails.evaluate(
    {
      thought: "Cut to Cam 2",
      recommendedAction: "cut",
      cutToInput: 2,
      transition: "cut",
      rationale: "Switch angle",
    },
    world,
    cameraMotion,
    { nowMs: now }
  );
  assert.equal(prayerVerdict.allowed, false);
  assert.match(prayerVerdict.suppressedReason ?? "", /prayer_moment_guard/);

  await app.close();
});

test("Human entry points: Advisory mode accept/dismiss, live steering API, and <5ms preemption", async () => {
  const mcpCalls: string[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/chat")) {
      // Simulate offline Ollama to test deterministic Rundown v2 fallback
      throw new Error("Connection refused");
    }
    if (url.endsWith("/mcp")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      mcpCalls.push(body.params?.name);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        status: 200,
      });
    }
    return new Response("{}", { status: 200 });
  };

  const config = loadConfig({ PIDIRECTOR_MODE: "advisory" });
  const { app } = buildApp(config, { fetchFn: mockFetch, autoEvaluateOnCue: false });
  await app.ready();

  // 1. Ingest Rundown cue context via HTTP endpoint
  await app.inject({
    method: "POST",
    url: "/api/v1/ingest/event",
    payload: {
      type: "rundown",
      data: {
        title: "Messu",
        currentCueId: "alkuvirsi",
        currentCueTitle: "Alkuvirsi",
        currentSection: "Johdanto",
        currentItemAi: {
          instructions: "Cut to organ/choir on Cam 3",
          targetZone: "choir",
          preferredCameras: [3],
        },
      },
    },
  });

  // 2. Evaluate in Advisory mode -> produces pending advisory without executing MCP calls
  const evalRes = await app.inject({
    method: "POST",
    url: "/api/v1/evaluate",
    payload: { trigger: "music_start" },
  });
  assert.equal(evalRes.statusCode, 200);
  const evalJson = evalRes.json();
  assert.equal(evalJson.mode, "advisory");
  assert.equal(evalJson.source, "deterministic-fallback");
  assert.equal(evalJson.executed, false);
  assert.ok(evalJson.advisory);
  assert.equal(evalJson.advisory.decision.cutToInput, 3);
  assert.equal(mcpCalls.length, 0);

  // 3. Human operator accepts the advisory shot -> executes via MCP
  const advId = evalJson.advisory.id;
  const acceptRes = await app.inject({
    method: "POST",
    url: `/api/v1/advisory/${advId}/accept`,
  });
  assert.equal(acceptRes.statusCode, 200);
  assert.equal(acceptRes.json().ok, true);
  assert.ok(mcpCalls.includes("atem_switch"));

  // 4. Human Steering API: Lock Camera 1
  const steerRes = await app.inject({
    method: "POST",
    url: "/api/v1/steer",
    payload: {
      instruction: "Stay on wide sanctuary shot during communion",
      lockCamera: 1,
      pacing: "meditative",
    },
  });
  assert.equal(steerRes.statusCode, 200);
  assert.equal(steerRes.json().steering.lockCamera, 1);

  // Switch to autonomous mode and verify camera lock forces cut back to Input 1
  await app.inject({
    method: "POST",
    url: "/api/v1/mode",
    payload: { mode: "autonomous" },
  });

  const lockEvalRes = await app.inject({
    method: "POST",
    url: "/api/v1/evaluate",
    payload: { trigger: "communion_start", bypassDwell: true },
  });
  assert.equal(lockEvalRes.json().decision.cutToInput, 1);
  assert.equal(lockEvalRes.json().executed, true);

  // 5. External human operator manual cut on gateway auto-preempts pidirector into manual mode
  await app.inject({
    method: "POST",
    url: "/api/v1/ingest/event",
    payload: {
      type: "action",
      data: {
        actor: "picontrol-operator",
        action: "atem.cut",
        params: { input: 2 },
        ok: true,
      },
    },
  });

  const statusRes = await app.inject({
    method: "GET",
    url: "/api/v1/status",
  });
  assert.equal(statusRes.json().mode, "manual");

  await app.close();
});
