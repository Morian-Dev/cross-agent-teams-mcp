#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";

function usage() {
  console.error(
    "Usage: node scripts/register-codex-self.mjs --name <name> [--team <team>] [--role <role>] [--model <model>] [--daemon-url <url>] [--auth-token-env <env>]"
  );
}

function parseArgs(argv) {
  const out = {
    team: "default",
    role: "default",
    model: "gpt-5",
    daemonUrl: "http://127.0.0.1:9100/mcp",
    authTokenEnv: undefined,
    name: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--name") {
      out.name = value;
      i += 1;
      continue;
    }
    if (key === "--team") {
      out.team = value;
      i += 1;
      continue;
    }
    if (key === "--role") {
      out.role = value;
      i += 1;
      continue;
    }
    if (key === "--model") {
      out.model = value;
      i += 1;
      continue;
    }
    if (key === "--daemon-url") {
      out.daemonUrl = value;
      i += 1;
      continue;
    }
    if (key === "--auth-token-env") {
      out.authTokenEnv = value;
      i += 1;
      continue;
    }
    if (key === "--help" || key === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${key}`);
  }

  if (!out.name || out.name.trim().length === 0) {
    throw new Error("Missing required --name");
  }
  return out;
}

function normalizeTty(raw) {
  const value = raw.trim().replace(/^\/dev\//, "");
  if (!value) throw new Error("Current tmux pane tty is empty");
  return value;
}

function currentPaneTty() {
  const stdout = execFileSync(
    "tmux",
    ["display-message", "-p", "#{pane_tty}"],
    { encoding: "utf8" }
  );
  return normalizeTty(stdout);
}

function codexUiPidForTty(tty) {
  const stdout = execFileSync(
    "ps",
    ["-t", tty, "-o", "pid=,ppid=,stat=,command="],
    { encoding: "utf8" }
  );
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/codex app-server/i.test(line)) continue;
    if (!/(^|[\s/])(codex|codex-aarch64-a)([\s]|$)/i.test(line)) continue;
    const match = line.match(/^(\d+)\s+/);
    if (!match) continue;
    return Number(match[1]);
  }

  throw new Error(`No Codex UI process found on tty ${tty}`);
}

function parseJsonOrSse(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"));
  const last = lines.at(-1);
  if (!last) throw new Error(`Unexpected MCP response: ${text}`);
  return JSON.parse(last.slice(5).trim());
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tty = currentPaneTty();
  const uiPid = codexUiPidForTty(tty);

  const authToken =
    args.authTokenEnv && process.env[args.authTokenEnv]
      ? process.env[args.authTokenEnv]
      : undefined;
  const headers = authToken
    ? { authorization: `Bearer ${authToken}` }
    : {};

  const init = await postJson(args.daemonUrl, headers, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "codex-cli-register-self",
        version: "0.0.0",
      },
    },
  });

  if (!init.response.ok) {
    throw new Error(`initialize failed: ${init.response.status} ${init.text}`);
  }

  const sessionId = init.response.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error("initialize did not return Mcp-Session-Id");
  }

  await postJson(
    args.daemonUrl,
    {
      ...headers,
      "mcp-session-id": sessionId,
    },
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }
  );

  const register = await postJson(
    args.daemonUrl,
    {
      ...headers,
      "mcp-session-id": sessionId,
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "register_agent",
        arguments: {
          client: "codex",
          name: args.name,
          team: args.team,
          role: args.role,
          model: args.model,
          ui_pid: uiPid,
        },
      },
    }
  );

  if (!register.response.ok) {
    throw new Error(
      `register_agent failed: ${register.response.status} ${register.text}`
    );
  }

  const payload = parseJsonOrSse(register.text);
  const toolText = payload?.result?.content?.[0]?.text;
  if (typeof toolText !== "string") {
    throw new Error(`Unexpected tool payload: ${register.text}`);
  }
  const result = JSON.parse(toolText);

  process.stdout.write(
    `${JSON.stringify({ tty, ui_pid: uiPid, session_id: sessionId, result }, null, 2)}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
