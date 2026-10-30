import { formatLogsForCli } from "./state/decision-logger.js";

const baseUrl = (process.env["PIDIRECTOR_URL"] ?? "http://127.0.0.1:3450").replace(/\/+$/, "");

async function request(path: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return json;
}

async function run(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "status": {
      const data = await request("/api/v1/status");
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "openapi": {
      const data = await request("/openapi.json");
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "start": {
      const modeArg = args[0]?.toLowerCase();
      const mode =
        modeArg === "advisory" || modeArg === "autonomous" ? modeArg : "autonomous";
      const reason =
        modeArg === "advisory" || modeArg === "autonomous"
          ? args.slice(1).join(" ") || "CLI operator start"
          : args.join(" ") || "CLI operator start";
      const data = await request("/api/v1/start", "POST", { mode, reason });
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "stop": {
      const reason = args.join(" ").trim() || "CLI operator stop";
      const data = await request("/api/v1/stop", "POST", { reason, actor: "cli-operator" });
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "continue":
    case "resume": {
      const modeArg = args[0]?.toLowerCase();
      const mode =
        modeArg === "advisory" || modeArg === "autonomous" ? modeArg : undefined;
      const reason =
        mode !== undefined
          ? args.slice(1).join(" ") || "CLI operator continue"
          : args.join(" ") || "CLI operator continue";
      const data = await request("/api/v1/continue", "POST", {
        ...(mode ? { mode } : {}),
        reason,
      });
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "mode": {
      const targetMode = args[0];
      if (!targetMode || !["autonomous", "advisory", "manual"].includes(targetMode)) {
        console.error("Usage: pidirector mode <autonomous|advisory|manual> [reason]");
        process.exit(1);
      }
      const reason = args.slice(1).join(" ") || undefined;
      const data = await request("/api/v1/mode", "POST", { mode: targetMode, reason });
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "steer": {
      const sub = args[0];
      if (sub === "lock") {
        const cam =
          args[1] === "off" || args[1] === "none" ? null : Number.parseInt(args[1] ?? "", 10);
        const data = await request("/api/v1/steer", "POST", { lockCamera: cam });
        console.log(JSON.stringify(data, null, 2));
      } else if (sub === "exclude") {
        const cams =
          args[1] === "off" || args[1] === "none" || !args[1]
            ? []
            : args[1]
                .split(",")
                .map((s) => Number.parseInt(s.trim(), 10))
                .filter((n) => !Number.isNaN(n));
        const data = await request("/api/v1/steer", "POST", { excludeCameras: cams });
        console.log(JSON.stringify(data, null, 2));
      } else if (sub === "pacing") {
        const pacing = args[1] === "reset" ? null : args[1];
        const data = await request("/api/v1/steer", "POST", { pacing });
        console.log(JSON.stringify(data, null, 2));
      } else if (sub === "dwell") {
        const sec =
          args[1] === "reset" ? null : Number.parseFloat(args[1] ?? "");
        const data = await request("/api/v1/steer", "POST", {
          minShotDwellSec: Number.isNaN(sec as number) ? null : sec,
        });
        console.log(JSON.stringify(data, null, 2));
      } else {
        const instruction = args.join(" ").trim() || null;
        const data = await request("/api/v1/steer", "POST", { instruction });
        console.log(JSON.stringify(data, null, 2));
      }
      break;
    }

    case "preempt": {
      const reason = args.join(" ").trim() || "CLI operator emergency preempt";
      const data = await request("/api/v1/preempt", "POST", { reason, actor: "cli-operator" });
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "evaluate": {
      const trigger = args[0] ?? "cli_evaluate";
      const data = await request("/api/v1/evaluate", "POST", { trigger, forceWhenManual: true });
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "accept": {
      const advId = args[0];
      if (!advId) {
        console.error("Usage: pidirector accept <advisoryId>");
        process.exit(1);
      }
      const data = await request(`/api/v1/advisory/${encodeURIComponent(advId)}/accept`, "POST");
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "dismiss": {
      const advId = args[0];
      if (!advId) {
        console.error("Usage: pidirector dismiss <advisoryId>");
        process.exit(1);
      }
      const data = await request(`/api/v1/advisory/${encodeURIComponent(advId)}/dismiss`, "POST");
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "cameras": {
      const data = await request("/api/v1/cameras");
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case "log":
    case "logs": {
      const data = await request("/api/v1/logs");
      if (args.includes("--json")) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const rendered = formatLogsForCli(Array.isArray(data.logs) ? data.logs : []);
        console.log(rendered || "(No log entries yet)");
      }
      break;
    }

    case "history": {
      const data = await request("/api/v1/history");
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    default: {
      console.log(`pidirector CLI — Local AI Stream Director (${baseUrl})

Lifecycle Commands:
  pidirector start [autonomous|advisory] [reason]    Start AI directing (defaults to autonomous)
  pidirector stop [reason]                           Stop/pause AI directing (<5ms abort -> manual mode)
  pidirector continue [autonomous|advisory]          Resume AI directing into previous active mode
  pidirector preempt [reason]                        Immediate <5ms human takeover & abort
  pidirector mode <autonomous|advisory|manual>       Explicitly set director operating mode

Steering Commands:
  pidirector steer "<instruction>"                   Set live natural-language directive
  pidirector steer lock <1|2|3|off>                  Lock or unlock a specific camera input
  pidirector steer exclude <1,2|off>                 Exclude specific cameras from AI selection
  pidirector steer pacing <calm|liturgical|dynamic>  Override broadcast pacing
  pidirector steer dwell <seconds|reset>             Override minimum shot dwell time

Co-Pilot & Inspection Commands:
  pidirector status                                  Show live director, camera motion, switcher & steering state
  pidirector evaluate [trigger]                      Trigger an immediate shot evaluation
  pidirector accept <advisoryId>                     Accept & execute a pending advisory shot
  pidirector dismiss <advisoryId>                    Dismiss a pending advisory shot
  pidirector cameras                                 Inspect FreeD camera motion & settled states
  pidirector logs [--json]                           View human-readable director decision log
  pidirector history                                 View recent directorial decisions & MCP calls
  pidirector openapi                                 Print the OpenAPI 3.1.0 specification`);
      break;
    }
  }
}

run().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
