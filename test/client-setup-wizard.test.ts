// scripts/wizard/client-setup.sh, run end to end against fakes of the
// commands it drives: `gh`, `claude`, `curl` and `npx` on the PATH, and a
// temporary HOME that is Claude Desktop's config location. Every fake records
// its calls; the tests read the wizard's output, its exit code, the recorded
// calls and the Desktop config it wrote. The real `node` runs the JSON upsert.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "wizard", "client-setup.sh");
const GATEWAY = "https://connextparb09d6769-hyde-mcp-gateway.functions.fnc.fr-par.scw.cloud/mcp";

/** How the fakes behave in one run. Every value lands in the fakes' environment. */
interface World {
  /** `gh auth status` succeeds. `gh auth login` flips it to true. */
  loggedIn?: boolean;
  /** The HTTP status `curl` answers for `/mcp`. */
  http?: number;
  /** The apps `ping` reports as in scope, among the registered `shop` and `crm`. */
  scope?: string[];
  /** Claude Desktop is installed (its config directory exists). */
  desktop?: boolean;
  /** Which of the fakes exist on the PATH. */
  tools?: ("gh" | "claude" | "npx")[];
}

function sse(result: object): string {
  return `event: message\ndata: ${JSON.stringify({ result, jsonrpc: "2.0", id: 1 })}\n\n`;
}

/** `ping BODY ID`: the gateway's answer to the `ping` in BODY as `$json`, as the fakes of `curl` and `npx` compute it. */
const PING = `
ping() {
BODY="$1"; ID="$2"
app=$(printf '%s' "$BODY" | sed -n 's/.*"app":"\\([^"]*\\)".*/\\1/p')
case "$app" in
  shop|crm)
    case ",$FAKE_SCOPE," in
      *",$app,"*) text="{\\"app\\":\\"$app\\",\\"client\\":\\"gh:alice\\",\\"apps\\":[\\"shop\\",\\"crm\\"],\\"scope\\":[$(printf '%s' "$FAKE_SCOPE" | sed 's/[^,][^,]*/"&"/g')]}"; err=false ;;
      *) text="client gh:alice is not authorized for app $app"; err=true ;;
    esac ;;
  *) text="unknown app $app; registered: shop, crm"; err=true ;;
esac
json="{\\"result\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"$(printf '%s' "$text" | sed 's/"/\\\\"/g')\\"}],\\"isError\\":$err},\\"jsonrpc\\":\\"2.0\\",\\"id\\":$ID}"
}
`;

const FAKES: Record<string, string> = {
  gh: `#!/usr/bin/env bash
printf '%s\\n' "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "auth status") [[ "$FAKE_LOGGED_IN" == 1 || -e "$FAKE_DIR/logged-in" ]] ;;
  "auth login") : > "$FAKE_DIR/logged-in" ;;
  "auth token") echo gho_fakeFAKEfakeFAKEfakeFAKEfake ;;
  *) echo "fake gh: unexpected $*" >&2; exit 99 ;;
esac
`,
  claude: `#!/usr/bin/env bash
printf '%s\\n' "claude $*" >> "$FAKE_LOG"
case "$1 $2" in
  "mcp remove") [[ -e "$FAKE_DIR/registered" ]] && { rm -f "$FAKE_DIR/registered"; exit 0; }; echo "No MCP server found with name: $3" >&2; exit 1 ;;
  "mcp add") [[ -e "$FAKE_DIR/registered" ]] && { echo "MCP server already exists in user config" >&2; exit 1; }; printf '%s\\n' "$@" > "$FAKE_DIR/registered" ;;
  "mcp get") [[ -e "$FAKE_DIR/registered" ]] || exit 1; printf 'hyde-mcp-gateway:\\n  Scope: User config\\n  Status: ✔ Connected\\n  Type: stdio\\n' ;;
  "--version") echo "9.9.9 (Claude Code)" ;;
  *) echo "fake claude: unexpected $*" >&2; exit 99 ;;
esac
`,
  curl: `#!/usr/bin/env bash
printf '%s\\n' "curl $*" >> "$FAKE_LOG"
OUT=/dev/stdout; BODY=""
while (($#)); do case "$1" in -o) OUT="$2"; shift ;; -d) BODY="$2"; shift ;; esac; shift; done
if [[ "$FAKE_HTTP" != 200 ]]; then printf '{"error":"fake"}' > "$OUT"; printf '%s' "$FAKE_HTTP"; exit 0; fi
${PING}
ping "$BODY" 1
printf 'event: message\\ndata: %s\\n\\n' "$json" > "$OUT"
printf '200'
`,
  // The bridge: \`npx -y mcp-remote <url> ...\` answers JSON-RPC on stdin like the gateway.
  npx: `#!/usr/bin/env bash
printf '%s\\n' "npx $* AUTH=\${AUTH_HEADER-}" >> "$FAKE_LOG"
${PING}
while IFS= read -r line; do
  ID=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
  case "$line" in
    *'"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"hyde-mcp-gateway","version":"0"}}}\\n' "$ID" ;;
    *'"tools/call"'*) ping "$line" "$ID"; printf '%s\\n' "$json" ;;
  esac
done
`,
};

let dir: string;
let home: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "client-setup-"));
  home = join(dir, "home");
  mkdirSync(home);
  log = join(dir, "calls.log");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(world: World = {}, args: string[] = []) {
  const { loggedIn = true, http = 200, scope = ["shop"], desktop = false, tools = ["gh", "claude", "npx"] } = world;
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of [...tools, "curl"]) {
    writeFileSync(join(bin, name), FAKES[name]!);
    chmodSync(join(bin, name), 0o755);
  }
  if (desktop) mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
  // The wizard looks the tools up on the PATH and puts their directories on the bridge's PATH:
  // node stays real but lives next to the fakes, so the bridge finds the fake npx, not the real one.
  if (!existsSync(join(bin, "node"))) symlinkSync(process.execPath, join(bin, "node"));
  const proc = spawnSync("bash", [SCRIPT, ...args], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      FAKE_DIR: dir, FAKE_LOG: log,
      FAKE_LOGGED_IN: loggedIn ? "1" : "0", FAKE_HTTP: String(http), FAKE_SCOPE: scope.join(","),
    },
    input: "\n".repeat(20),
    encoding: "utf8",
  });
  return { status: proc.status, out: `${proc.stdout}${proc.stderr}`, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

function desktopConfig(): { mcpServers: Record<string, { command: string; args: string[] }> } {
  return JSON.parse(readFileSync(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), "utf8"));
}

describe("client-setup.sh verifies the GitHub token against the gateway", () => {
  it("a rejected token (401) is reported as such and stops the wizard", () => {
    const { status, out, calls } = run({ http: 401 });
    expect(status).toBe(1);
    expect(out).toMatch(/not accepted/i);
    expect(out).not.toMatch(/unreachable/i);
    expect(calls).not.toMatch(/claude mcp add/);
  });

  it("a gateway that cannot reach GitHub (503) is told apart from a rejected token", () => {
    const { status, out } = run({ http: 503 });
    expect(status).toBe(1);
    expect(out).toMatch(/could not reach GitHub/i);
    expect(out).not.toMatch(/not accepted/i);
  });
});

describe("client-setup.sh with gh, Claude Code and no Claude Desktop", () => {
  it("logs gh in when it is not, then continues", () => {
    const { status, out, calls } = run({ loggedIn: false });
    expect(status).toBe(0);
    expect(calls).toMatch(/gh auth login -h github.com -w/);
    expect(calls).toMatch(/claude mcp add/);
    expect(out).toContain("Setup complete");
  });

  it("registers the bridge at user scope with the token read from gh at start, never written", () => {
    const { status, calls, out } = run();
    expect(status).toBe(0);
    const add = calls.split("\n").find((line) => line.startsWith("claude mcp add"))!;
    expect(add).toMatch(/^claude mcp add -s user hyde-mcp-gateway -- \/bin\/bash -c /);
    expect(add).toContain(`mcp-remote "${GATEWAY}"`);
    expect(add).toContain('AUTH_HEADER="Bearer $(gh auth token)"');
    expect(add).toContain(`--header "Authorization:\\$"'{AUTH_HEADER}'`);
    expect(add).toContain("--transport http-only");
    expect(add).not.toContain("gho_");
    expect(out).not.toContain("gho_");
    expect(out).toMatch(/Claude Desktop is not installed/);
  });

  it("reports the apps in scope, and an empty scope asks for repository access", () => {
    expect(run({ scope: ["shop"] }).out).toMatch(/apps in scope: shop\b/);
    const empty = run({ scope: [] });
    expect(empty.status).toBe(0);
    expect(empty.out).toMatch(/scope is empty/);
    expect(empty.out).toMatch(/read access to the app repositories/);
    expect(empty.out).not.toMatch(/gateway change/i);
  });

  it("pings through the configured bridge and prints the scope it answers", () => {
    const { out, calls } = run({ scope: ["shop", "crm"] });
    // The bridge hands mcp-remote the literal ${AUTH_HEADER} to read from its environment, where the token is.
    expect(calls).toMatch(/^npx -y mcp-remote .* --header Authorization:\$\{AUTH_HEADER\} AUTH=Bearer gho_/m);
    expect(out).toMatch(/ping answered; scope: shop crm/);
  });

  it("a second run leaves one entry in Claude Code", () => {
    run();
    rmSync(log);
    const { status, calls } = run();
    expect(status).toBe(0);
    expect(calls.match(/claude mcp remove -s user hyde-mcp-gateway/g)).toHaveLength(1);
    expect(calls.match(/claude mcp add/g)).toHaveLength(1);
  });

  it("stops with an install hint when a tool is missing", () => {
    const { status, out, calls } = run({ tools: ["gh"] });
    expect(status).toBe(1);
    expect(out).toMatch(/claude is not installed/);
    expect(calls).not.toMatch(/gh auth/);
  });
});

describe("client-setup.sh with Claude Desktop installed", () => {
  it("writes the bridge to claude_desktop_config.json and says to restart Desktop", () => {
    const { status, out } = run({ desktop: true });
    expect(status).toBe(0);
    const entry = desktopConfig().mcpServers["hyde-mcp-gateway"]!;
    expect(entry.command).toBe("/bin/bash");
    expect(entry.args[0]).toBe("-c");
    expect(entry.args[1]).toContain(`mcp-remote "${GATEWAY}"`);
    expect(entry.args[1]).toContain('AUTH_HEADER="Bearer $(gh auth token)"');
    expect(entry.args[1]).not.toContain("gho_");
    expect(out).toMatch(/Quit Claude Desktop and open it again/);
  });

  it("keeps other servers and holds one entry after two runs", () => {
    const file = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, theme: "dark" }));
    run({ desktop: true });
    run({ desktop: true });
    const config = desktopConfig() as { mcpServers: Record<string, unknown>; theme?: string };
    expect(Object.keys(config.mcpServers)).toEqual(["other", "hyde-mcp-gateway"]);
    expect(config.theme).toBe("dark");
    expect(readFileSync(file, "utf8").match(/"hyde-mcp-gateway":/g)).toHaveLength(1);
  });
});
