import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { formatLogsForCli } from "../src/state/decision-logger.js";

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
  assert.equal(statusRes.json().lastActiveMode, "autonomous");

  // 6. Continue / resume after preemption restores previous active mode ("autonomous")
  const continueRes = await app.inject({
    method: "POST",
    url: "/api/v1/continue",
    payload: { reason: "Resuming after manual cut" },
  });
  assert.equal(continueRes.statusCode, 200);
  assert.equal(continueRes.json().previousMode, "manual");
  assert.equal(continueRes.json().mode, "autonomous");

  // 7. Stop pauses into manual mode while remembering lastActiveMode
  const stopRes = await app.inject({
    method: "POST",
    url: "/api/v1/stop",
    payload: { reason: "Pausing for announcements" },
  });
  assert.equal(stopRes.statusCode, 200);
  assert.equal(stopRes.json().newMode, "manual");
  assert.equal(stopRes.json().resumableMode, "autonomous");

  // 8. Start explicitly in advisory mode
  const startRes = await app.inject({
    method: "POST",
    url: "/api/v1/start",
    payload: { mode: "advisory", reason: "Start co-pilot mode" },
  });
  assert.equal(startRes.statusCode, 200);
  assert.equal(startRes.json().mode, "advisory");

  // 9. OpenAPI spec endpoint serves valid 3.1.0 specification
  const openApiRes = await app.inject({
    method: "GET",
    url: "/openapi.json",
  });
  assert.equal(openApiRes.statusCode, 200);
  const spec = openApiRes.json();
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths["/api/v1/start"]);
  assert.ok(spec.paths["/api/v1/stop"]);
  assert.ok(spec.paths["/api/v1/continue"]);
  assert.ok(spec.paths["/api/v1/steer"]);
  assert.ok(spec.paths["/api/v1/logs"]);

  await app.close();
});

test("Rolling context (recentDecisions & transcripts) is passed to Ollama and human-readable log is saved to file and API", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pidirector-log-test-"));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  const logFile = path.join(tmpDir, "decisions.log");

  const capturedPrompts: any[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/chat")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const userMsg = JSON.parse(body.messages?.[1]?.content ?? "{}");
      capturedPrompts.push(userMsg);

      const nextInput = capturedPrompts.length === 1 ? 2 : 3;
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              thought: `Switch to Cam ${nextInput}`,
              recommendedAction: "cut",
              cutToInput: nextInput,
              transition: "cut",
              rationale: `Shot ${capturedPrompts.length} focus on Cam ${nextInput}`,
            }),
          },
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
    });
  };

  const config = loadConfig({
    PIDIRECTOR_MODE: "autonomous",
    PIDIRECTOR_LOG_FILE: logFile,
  });
  const { app, world } = buildApp(config, { fetchFn: mockFetch, autoEvaluateOnCue: false });
  await app.ready();

  world.addTranscript("Herran rauha olkoon teidän kanssanne.");
  world.addTranscript("Ja sinun henkesi kanssa.");

  // 1st evaluation (cuts to Cam 2)
  await app.inject({
    method: "POST",
    url: "/api/v1/evaluate",
    payload: { trigger: "liturgy_greeting", bypassDwell: true },
  });

  // 2nd evaluation (cuts to Cam 3) -> should receive 1st decision in recentDecisions!
  await app.inject({
    method: "POST",
    url: "/api/v1/evaluate",
    payload: { trigger: "hymn_start", bypassDwell: true },
  });

  assert.equal(capturedPrompts.length, 2);
  assert.equal(capturedPrompts[1].recentDecisions.length, 1);
  assert.equal(capturedPrompts[1].recentDecisions[0].cutToInput, 2);
  assert.equal(capturedPrompts[1].recentDecisions[0].executed, true);
  assert.match(capturedPrompts[1].recentDecisions[0].summary, /CUT → Cam 2/);
  assert.equal(capturedPrompts[1].recentTranscripts.length, 2);

  // Verify structured JSON logs via API
  const logsRes = await app.inject({
    method: "GET",
    url: "/api/v1/logs",
  });
  assert.equal(logsRes.statusCode, 200);
  const logsJson = logsRes.json();
  assert.equal(logsJson.logs.length, 2);
  assert.equal(logsJson.logs[0].category, "cut");
  assert.equal(logsJson.logs[0].action.cutToInput, 2);
  assert.equal(logsJson.logs[0].guardrail.allowed, true);
  assert.match(logsJson.logs[0].headline, /CUT → Cam 2/);

  // Verify CLI human-readable formatter renders structured JSON logs
  const cliRendered = formatLogsForCli(logsJson.logs);
  assert.match(cliRendered, /\[CUT\] CUT → Cam 2/);
  assert.match(cliRendered, /\[CUT\] CUT → Cam 3/);

  // Verify log file was persisted on disk as structured JSON Lines (.jsonl)
  const diskContent = await fs.readFile(logFile, "utf8");
  const jsonLines = diskContent
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(jsonLines.length, 2);
  assert.equal(jsonLines[0].category, "cut");
  assert.equal(jsonLines[0].action.cutToInput, 2);
  assert.equal(jsonLines[1].action.cutToInput, 3);

  await app.close();
});

test("Rundown situational awareness: placeInEvent, hierarchical timing, nextItem + cue, and timer/duration in Ollama prompt and logs", async () => {
  let lastSystemPrompt = "";
  let lastUserPayload: any = null;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/chat")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      lastSystemPrompt = String(body.messages?.[0]?.content ?? "");
      lastUserPayload = JSON.parse(body.messages?.[1]?.content ?? "{}");

      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              thought: "Pre-position Cam 1 for upcoming Lord's Prayer while holding Cam 3 during prayer for dead.",
              recommendedAction: "prepare_only",
              prepareCamera: { camera: 1, preset: "altar" },
              transition: "cut",
              rationale: "Preparing wide altar shot on Cam 1 for next item (Lord's Prayer).",
            }),
          },
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
    });
  };

  const config = loadConfig({ PIDIRECTOR_MODE: "autonomous" });
  const { app } = buildApp(config, { fetchFn: mockFetch, autoEvaluateOnCue: false });
  await app.ready();

  // Ingest full pirundown status snapshot with hierarchical progress and nextItem
  await app.inject({
    method: "POST",
    url: "/api/v1/ingest/event",
    payload: {
      type: "rundown_state",
      data: {
        title: "Sunday High Mass",
        service: "Messu",
        church: "Keskuskirkko",
        date: "2026-11-01",
        currentIndex: 3,
        totalItems: 18,
        currentItem: {
          id: "sub3_dead",
          title: "prayer for dead",
          section: "intercession",
          expectedDurationSec: 183,
          timerSec: null,
        },
        progress: {
          placeInEvent: "4/18 prayer for dead",
          service: {
            elapsedSec: 1563,
            expectedDurationSec: 4500,
            timing: "26:03/1:15:00",
            overtime: false,
          },
          section: {
            index: 3,
            total: 15,
            place: "3/15",
            id: "sec3_intercession",
            title: "intercession",
            elapsedSec: 300,
            expectedDurationSec: 900,
            timerSec: null,
            timing: "5:00/15:00",
            overtime: false,
          },
          subsection: {
            index: 3,
            total: 5,
            place: "3/5",
            id: "sub3_dead",
            title: "prayer for dead",
            elapsedSec: 120,
            expectedDurationSec: 183,
            timerSec: null,
            timing: "2:00/3:03",
            overtime: false,
          },
          summary:
            "Whole service 26:03/1:15:00, currently section 3/15 intercession 5:00/15:00, subsection 3/5 prayer for dead 2:00/3:03",
        },
        nextItem: {
          id: "sub4_lords_prayer",
          line: 8,
          index: 4,
          title: "Lord's Prayer",
          section: "intercession",
          cueSummary: 'Exact: "Our Father in heaven"',
          cue: { type: "phrase", phrase: "Our Father in heaven" },
          expectedDurationSec: 5,
          timerSec: 10,
          ai: "Hold wide shot during Lord's Prayer",
        },
      },
    },
  });

  // Evaluate
  const evalRes = await app.inject({
    method: "POST",
    url: "/api/v1/evaluate",
    payload: { trigger: "pacing_check", bypassDwell: true },
  });
  assert.equal(evalRes.statusCode, 200);

  // Verify system prompt and user payload passed to Ollama
  assert.match(lastSystemPrompt, /4\/18 prayer for dead/);
  assert.match(
    lastSystemPrompt,
    /Whole service 26:03\/1:15:00, currently section 3\/15 intercession 5:00\/15:00, subsection 3\/5 prayer for dead 2:00\/3:03/
  );
  assert.match(lastSystemPrompt, /Lord's Prayer \(Cue: Exact: "Our Father in heaven"\)/);

  assert.equal(lastUserPayload.event.title, "Sunday High Mass");
  assert.equal(lastUserPayload.event.service, "Messu");
  assert.equal(lastUserPayload.rundownProgress.placeInEvent, "4/18 prayer for dead");
  assert.equal(
    lastUserPayload.rundownProgress.summary,
    "Whole service 26:03/1:15:00, currently section 3/15 intercession 5:00/15:00, subsection 3/5 prayer for dead 2:00/3:03"
  );
  assert.equal(lastUserPayload.nextItem.id, "sub4_lords_prayer");
  assert.equal(lastUserPayload.nextItem.cueSummary, 'Exact: "Our Father in heaven"');
  assert.equal(lastUserPayload.nextItem.expectedDurationSec, 5);
  assert.equal(lastUserPayload.nextItem.timerSec, 10);

  // Verify structured JSON log includes rundown context and CLI formatter renders it human-readably
  const logsRes = await app.inject({
    method: "GET",
    url: "/api/v1/logs",
  });
  const logsData = logsRes.json();
  assert.equal(logsData.logs[0].rundown.placeInEvent, "4/18 prayer for dead");
  assert.equal(
    logsData.logs[0].rundown.timingSummary,
    "Whole service 26:03/1:15:00, currently section 3/15 intercession 5:00/15:00, subsection 3/5 prayer for dead 2:00/3:03"
  );
  assert.equal(logsData.logs[0].rundown.nextItemTitle, "Lord's Prayer");
  assert.equal(logsData.logs[0].rundown.nextItemCueSummary, 'Exact: "Our Father in heaven"');

  const cliText = formatLogsForCli(logsData.logs);
  assert.match(cliText, /Cue: 4\/18 prayer for dead/);
  assert.match(cliText, /Next: Lord's Prayer \[Exact: "Our Father in heaven"\]/);

  await app.close();
});

test("Steering notes durability: broadcast, section, subsection, timer expiration, and toggle on/off", async () => {
  let lastUserPayload: any = null;
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/chat")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      lastUserPayload = JSON.parse(body.messages?.[1]?.content ?? "{}");
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              thought: "Hold shot",
              recommendedAction: "hold",
              transition: "cut",
              rationale: "Holding current shot",
            }),
          },
        }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 });
  };

  const config = loadConfig({ PIDIRECTOR_MODE: "autonomous" });
  const { app, world } = buildApp(config, { fetchFn: mockFetch, autoEvaluateOnCue: false });
  await app.ready();

  // Set initial rundown position: section "sec3_intercession", subsection "sub3_dead"
  world.updateRundownContext({
    title: "Sunday High Mass",
    currentSection: "sec3_intercession",
    currentCueId: "sub3_dead",
    currentCueTitle: "prayer for dead",
  });

  // 1. Add broadcast, section, subsection, and 1s timer notes
  const bRes = await app.inject({
    method: "POST",
    url: "/api/v1/steer/notes",
    payload: { text: "Keep warm lighting framing all service", scope: "broadcast" },
  });
  const broadcastId = bRes.json().note.id;

  const secRes = await app.inject({
    method: "POST",
    url: "/api/v1/steer/notes",
    payload: { text: "Cantor leads intercession from left lectern", scope: "section" },
  });
  const sectionId = secRes.json().note.id;

  const subRes = await app.inject({
    method: "POST",
    url: "/api/v1/steer/notes",
    payload: { text: "Hold wide shot while candles are lit", scope: "subsection" },
  });
  const subsectionId = subRes.json().note.id;

  await app.inject({
    method: "POST",
    url: "/api/v1/steer/notes",
    payload: { text: "Avoid Cam 2 for 1 second while tripod adjusts", scope: "timer", duration: 1 },
  });

  // All 4 notes are initially active in prompt
  await app.inject({
    method: "POST",
    url: "/api/v1/evaluate",
    payload: { trigger: "check_1" },
  });
  assert.equal(lastUserPayload.humanSteering.activeNotes.length, 4);

  // 2. Toggle off broadcast note -> only 3 active notes in prompt
  await app.inject({
    method: "POST",
    url: `/api/v1/steer/notes/${broadcastId}/toggle`,
    payload: { enabled: false },
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/evaluate",
    payload: { trigger: "check_2" },
  });
  assert.equal(lastUserPayload.humanSteering.activeNotes.length, 3);
  assert.ok(!lastUserPayload.humanSteering.activeNotes.some((n: any) => n.id === broadcastId));

  // 3. Advance rundown to next subsection ("sub4_lords_prayer") in the SAME section ("sec3_intercession")
  // -> subsection note automatically expires!
  world.updateRundownContext({
    currentSection: "sec3_intercession",
    currentCueId: "sub4_lords_prayer",
    currentCueTitle: "Lord's Prayer",
  });
  const afterSubChange = world.getSteering();
  const subNote = afterSubChange.notes.find((n) => n.id === subsectionId);
  assert.equal(subNote?.expired, true);
  assert.equal(subNote?.expiredReason, "subsection_changed");
  assert.equal(afterSubChange.notes.find((n) => n.id === sectionId)?.expired, false);

  // 4. Advance rundown to a NEW section ("sec4_communion")
  // -> section note automatically expires!
  world.updateRundownContext({
    currentSection: "sec4_communion",
    currentCueId: "communion_prep",
    currentCueTitle: "Communion Preparation",
  });
  const afterSecChange = world.getSteering();
  const secNote = afterSecChange.notes.find((n) => n.id === sectionId);
  assert.equal(secNote?.expired, true);
  assert.equal(secNote?.expiredReason, "section_changed");

  // 5. Wait for 1s timer note to expire -> 0 active notes left!
  const futureMs = Date.now() + 1500;
  const afterTimer = world.getSteering(futureMs);
  assert.equal(afterTimer.activeNotes.length, 0);
  assert.equal(afterTimer.instruction, null);

  // 6. Toggle broadcast note back ON -> 1 active note in prompt again
  await app.inject({
    method: "POST",
    url: `/api/v1/steer/notes/${broadcastId}/toggle`,
    payload: { enabled: true },
  });
  assert.equal(world.getSteering().activeNotes.length, 1);
  assert.equal(world.getSteering().activeNotes[0]?.id, broadcastId);

  await app.close();
});
