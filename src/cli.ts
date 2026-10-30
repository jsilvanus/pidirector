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
        const cam = args[1] === "off" || args[1] === "none" ? null : Number.parseInt(args[1] ?? "", 10);
        const data = await request("/api/v1/steer", "POST", { lockCamera: cam });
        console.log(JSON.stringify(data, null, 2));
      } else if (sub === "pacing") {
        const pacing = args[1] === "reset" ? null : args[1];
        const data = await request("/api/v1/steer", "POST", { pacing });
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

    case "history": {
      const data = await request("/api/v1/history");
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    default: {
      console.log(`pidirector CLI — Local AI Stream Director (${baseUrl})

Commands:
  pidirector status                                  Show live director, camera motion, switcher & steering state
  pidirector mode <autonomous|advisory|manual>       Switch director operating mode
  pidirector steer "<instruction>"                   Set live human steering directive
  pidirector steer lock <1|2|3|off>                  Lock or unlock a specific camera input
  pidirector steer pacing <calm|liturgical|dynamic>  Override broadcast pacing
  pidirector preempt [reason]                        Immediate <5ms human takeover & abort
  pidirector evaluate [trigger]                      Trigger an immediate shot evaluation
  pidirector accept <advisoryId>                     Accept & execute a pending advisory shot
  pidirector dismiss <advisoryId>                    Dismiss a pending advisory shot
  pidirector cameras                                 Inspect FreeD camera motion & settled states
  pidirector history                                 View recent directorial decisions & MCP calls`);
      break;
    }
  }
}

run().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
