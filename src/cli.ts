import { formatBroadcastForCli, formatLogsForCli } from "./state/decision-logger.js";

const baseUrl = (process.env["PIDIRECTOR_URL"] ?? "http://127.0.0.1:3401").replace(/\/+$/, "");

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
      if (sub === "list") {
        const data = await request("/api/v1/steer");
        console.log(JSON.stringify(data.steering, null, 2));
      } else if (sub === "note") {
        const scopeArg = args[1]?.toLowerCase();
        const validScopes = ["broadcast", "section", "subsection", "timer"];
        const scope = validScopes.includes(scopeArg ?? "") ? scopeArg! : "broadcast";
        let duration: string | number | undefined;
        let textStartIdx = validScopes.includes(scopeArg ?? "") ? 2 : 1;
        if (scope === "timer" && args[textStartIdx]) {
          duration = args[textStartIdx];
          textStartIdx += 1;
        }
        const text = args.slice(textStartIdx).join(" ").trim();
        if (!text) {
          console.error(
            'Usage: pidirector steer note <broadcast|section|subsection|timer> [duration] "<text>"'
          );
          process.exit(1);
        }
        const data = await request("/api/v1/steer/notes", "POST", {
          text,
          scope,
          ...(duration !== undefined ? { duration } : {}),
        });
        console.log(JSON.stringify(data, null, 2));
      } else if (sub === "toggle") {
        const noteId = args[1];
        if (!noteId) {
          console.error("Usage: pidirector steer toggle <noteId> [on|off]");
          process.exit(1);
        }
        const stateArg = args[2]?.toLowerCase();
        const enabled =
          stateArg === "on" || stateArg === "true"
            ? true
            : stateArg === "off" || stateArg === "false"
              ? false
              : undefined;
        const data = await request(
          `/api/v1/steer/notes/${encodeURIComponent(noteId)}/toggle`,
          "POST",
          enabled !== undefined ? { enabled } : {}
        );
        console.log(JSON.stringify(data, null, 2));
      } else if (sub === "remove" || sub === "delete") {
        const noteId = args[1];
        if (!noteId) {
          console.error("Usage: pidirector steer remove <noteId>");
          process.exit(1);
        }
        const data = await request(`/api/v1/steer/notes/${encodeURIComponent(noteId)}`, "DELETE");
        console.log(JSON.stringify(data, null, 2));
      } else if (sub === "lock") {
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

    case "dump": {
      const reset = args.includes("--reset");
      const toStdoutOnly =
        args.includes("--stdout") || args.includes("-s") || args.includes("--no-save");
      const saveToFile = toStdoutOnly ? args.includes("--save") : true;
      const data = await request("/api/v1/broadcast/dump", "POST", {
        reset,
        saveToFile,
      });
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(toStdoutOnly ? data.broadcast : data, null, 2)}\n`);
      } else {
        if (data.filePath && !toStdoutOnly) {
          process.stdout.write(`Saved broadcast log to: ${data.filePath}\n\n`);
        }
        process.stdout.write(`${formatBroadcastForCli(data.broadcast)}\n`);
      }
      break;
    }

    case "end": {
      const toStdoutOnly =
        args.includes("--stdout") || args.includes("-s") || args.includes("--no-save");
      const saveToFile = toStdoutOnly ? args.includes("--save") : true;
      const reason =
        args.filter((a) => !a.startsWith("-")).join(" ").trim() || "CLI broadcast ended";
      const data = await request("/api/v1/broadcast/end", "POST", {
        reason,
        actor: "cli-operator",
        saveToFile,
      });
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(toStdoutOnly ? data.broadcast : data, null, 2)}\n`);
      } else {
        if (data.filePath && !toStdoutOnly) {
          process.stdout.write(`Broadcast ended and saved to: ${data.filePath}\n\n`);
        }
        process.stdout.write(`${formatBroadcastForCli(data.broadcast)}\n`);
      }
      break;
    }

    case "broadcasts": {
      const data = await request("/api/v1/broadcasts");
      if (args.includes("--json")) {
        console.log(JSON.stringify(data, null, 2));
      } else if (!Array.isArray(data.broadcasts) || data.broadcasts.length === 0) {
        console.log("(No saved broadcasts yet)");
      } else {
        for (const b of data.broadcasts) {
          const title = [b.event?.title, b.event?.service].filter(Boolean).join(" — ") || "Service";
          console.log(
            `${b.broadcastId} | ${title} | ${b.startedAt} -> ${b.endedAt ?? "active"} | ${b.stats?.totalDecisions ?? 0} decisions, ${b.stats?.steeringNotesTotal ?? 0} notes`
          );
        }
      }
      break;
    }

    case "broadcast": {
      const idArg = args.find((a) => !a.startsWith("--"));
      const data = idArg
        ? await request(`/api/v1/broadcasts/${encodeURIComponent(idArg)}`)
        : await request("/api/v1/broadcast");
      if (args.includes("--json")) {
        console.log(JSON.stringify(data.broadcast, null, 2));
      } else {
        console.log(formatBroadcastForCli(data.broadcast));
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
  pidirector steer "<instruction>"                                     Set broadcast steering directive
  pidirector steer note <broadcast|section|subsection|timer> [dur] ..  Add scoped steering note (e.g. timer 2:00)
  pidirector steer toggle <noteId> [on|off]                            Toggle a steering note on or off
  pidirector steer remove <noteId>                                     Remove a steering note
  pidirector steer list                                                List all steering notes & overrides
  pidirector steer lock <1|2|3|off>                                    Lock or unlock a specific camera input
  pidirector steer exclude <1,2|off>                                   Exclude specific cameras from AI selection
  pidirector steer pacing <calm|liturgical|dynamic>                    Override broadcast pacing
  pidirector steer dwell <seconds|reset>                               Override minimum shot dwell time

Co-Pilot & Inspection Commands:
  pidirector status                                  Show live director, camera motion, switcher & steering state
  pidirector evaluate [trigger]                      Trigger an immediate shot evaluation
  pidirector accept <advisoryId>                     Accept & execute a pending advisory shot
  pidirector dismiss <advisoryId>                    Dismiss a pending advisory shot
  pidirector cameras                                 Inspect FreeD camera motion & settled states
  pidirector logs [--json]                           View human-readable director decision log
  pidirector dump [--stdout] [--reset] [--json]      Dump broadcast (notes + logs) to file or stdout
  pidirector end [reason] [--stdout] [--json]        End broadcast, dump per-broadcast log, and reset
  pidirector broadcast [broadcastId] [--json]        View current or saved broadcast with notes & logs
  pidirector broadcasts [--json]                     List saved per-broadcast archives
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
