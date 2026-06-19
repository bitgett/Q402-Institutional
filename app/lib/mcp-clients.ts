/**
 * app/lib/mcp-clients.ts — single source of truth for the MCP-client matrix.
 *
 * Before this file the client list was hand-duplicated across five surfaces
 * (/claude install matrix + works-with strip, /agents strip, LandingBody,
 * Contact). They drifted: logos were added to the strips while the install
 * matrix stayed at four, so we advertised "works with Hermes / Copilot" with
 * no actual install instructions. Everything now derives from MCP_INSTALL.
 *
 * Config formats are NOT uniform, so each row carries what its renderer needs:
 *   - Claude / Codex:  CLI command (`claude mcp add ...`).
 *   - Cursor / Cline:  JSON, root key `mcpServers`.
 *   - Copilot (VS Code): JSON, root key `servers` (NOT mcpServers) in .vscode/mcp.json.
 *   - Hermes (Nous):   YAML, root key `mcp_servers` in ~/.hermes/config.yaml, reload with /reload-mcp.
 *
 * The API key is never embedded in any snippet — the server reads it from
 * ~/.q402/mcp.env (q402_doctor writes it), so every client install is keyless.
 */

export type InstallKind = "cli" | "json" | "yaml";

/** Shell helpers to create the config file when it does not exist yet. */
export interface CreateFileCmds {
  unix: string;
  win: string;
}

export interface ClientInstall {
  key: string;
  name: string;
  logo: string;
  /** Logo is light-coloured (white/grey); invert it to read on a white chip. */
  invert?: boolean;
  kind: InstallKind;
  /** Full, paste-ready snippet (CLI line, or JSON/YAML document). */
  snippet: string;
  /** Just the `q402` entry, to nest inside an existing config object. */
  innerSnippet?: string;
  /** Where the snippet is saved (file path or UI breadcrumb). */
  configPath?: string;
  /** Root object key the entry nests under, for "already have a config?" copy. */
  wrapperKey?: string;
  /** Create-the-file shell commands, or null when the client edits via its own UI. */
  createFile?: CreateFileCmds | null;
  hint: string;
}

// ── shared snippet bodies ────────────────────────────────────────────────────

// Cursor + Cline: standard MCP JSON, root key `mcpServers`.
const JSON_MCPSERVERS_FULL = `{
  "mcpServers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"]
    }
  }
}`;
const JSON_ENTRY = `"q402": { "command": "npx", "args": ["-y", "@quackai/q402-mcp"] }`;

// GitHub Copilot in VS Code: JSON, root key `servers` (not mcpServers).
const JSON_SERVERS_FULL = `{
  "servers": {
    "q402": {
      "command": "npx",
      "args": ["-y", "@quackai/q402-mcp"]
    }
  }
}`;

// Hermes Agent (Nous Research): YAML, root key `mcp_servers`.
const YAML_HERMES_FULL = `mcp_servers:
  q402:
    command: "npx"
    args: ["-y", "@quackai/q402-mcp"]
    enabled: true`;
const YAML_HERMES_ENTRY = `  q402:
    command: "npx"
    args: ["-y", "@quackai/q402-mcp"]
    enabled: true`;

// ── the matrix ───────────────────────────────────────────────────────────────

export const MCP_INSTALL: ClientInstall[] = [
  {
    key: "claude",
    name: "Claude",
    logo: "/logos/claude.svg",
    kind: "cli",
    snippet: "claude mcp add q402 -- npx -y @quackai/q402-mcp",
    hint: "Claude Code CLI or Claude Desktop. Reload or restart the app after running.",
  },
  {
    key: "codex",
    name: "Codex",
    logo: "/logos/codex.svg",
    kind: "cli",
    snippet: "codex mcp add q402 -- npx -y @quackai/q402-mcp",
    hint: "OpenAI Codex CLI. Restart Codex after running. On Windows, if `codex mcp add` returns \"Access is denied\", add the stanza to `~/.codex/config.toml` by hand: `[mcp_servers.q402]` / `command = \"npx\"` / `args = [\"-y\", \"@quackai/q402-mcp\"]`.",
  },
  {
    key: "cursor",
    name: "Cursor",
    logo: "/logos/cursor.svg",
    invert: true,
    kind: "json",
    snippet: JSON_MCPSERVERS_FULL,
    innerSnippet: JSON_ENTRY,
    configPath: "~/.cursor/mcp.json",
    wrapperKey: "mcpServers",
    createFile: {
      unix: "mkdir -p ~/.cursor && code ~/.cursor/mcp.json",
      win: 'New-Item -ItemType Directory -Force "$env:USERPROFILE\\.cursor" | Out-Null; code "$env:USERPROFILE\\.cursor\\mcp.json"',
    },
    hint: "Save the full snippet as ~/.cursor/mcp.json if the file is new. After saving, reload Cursor (Cmd/Ctrl+Shift+P, Developer: Reload Window).",
  },
  {
    key: "cline",
    name: "Cline",
    logo: "/logos/cline.svg",
    invert: true,
    kind: "json",
    snippet: JSON_MCPSERVERS_FULL,
    innerSnippet: JSON_ENTRY,
    configPath: "Cline, Settings, MCP Servers, Edit JSON",
    wrapperKey: "mcpServers",
    createFile: null,
    hint: "Open Cline's MCP servers JSON editor and paste. Reload VS Code (Cmd/Ctrl+Shift+P, Developer: Reload Window) when done.",
  },
  {
    key: "copilot",
    name: "Copilot",
    logo: "/logos/copilot.jpg",
    kind: "json",
    snippet: JSON_SERVERS_FULL,
    innerSnippet: JSON_ENTRY,
    configPath: ".vscode/mcp.json",
    wrapperKey: "servers",
    createFile: {
      unix: "mkdir -p .vscode && code .vscode/mcp.json",
      win: 'New-Item -ItemType Directory -Force ".vscode" | Out-Null; code ".vscode\\mcp.json"',
    },
    hint: "GitHub Copilot in VS Code. Note the root key is `servers`, not `mcpServers`. Save as .vscode/mcp.json (per-project) or add to your user mcp.json, then reload VS Code and enable q402 in the Copilot Chat tools picker.",
  },
  {
    key: "hermes",
    name: "Hermes",
    logo: "/logos/hermes.jpg",
    kind: "yaml",
    snippet: YAML_HERMES_FULL,
    innerSnippet: YAML_HERMES_ENTRY,
    configPath: "~/.hermes/config.yaml",
    wrapperKey: "mcp_servers",
    createFile: {
      unix: "mkdir -p ~/.hermes && code ~/.hermes/config.yaml",
      win: 'New-Item -ItemType Directory -Force "$env:USERPROFILE\\.hermes" | Out-Null; code "$env:USERPROFILE\\.hermes\\config.yaml"',
    },
    hint: "Nous Research Hermes Agent. Save under mcp_servers in ~/.hermes/config.yaml, then run /reload-mcp in Hermes to load the tools.",
  },
];

/**
 * Logo-strip view (name + src + invert) used by the hero "works with" strips on
 * /claude, /agents, the landing body, and the contact section. Derived so the
 * strips can never again drift from the install matrix.
 */
export const MCP_CLIENTS: { name: string; src: string; invert: boolean }[] =
  MCP_INSTALL.map((c) => ({ name: c.name, src: c.logo, invert: !!c.invert }));
