# Godot MCP
```text
                           (((((((             (((((((
                        (((((((((((           (((((((((((
                        (((((((((((((       (((((((((((((
                        (((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((
         (((((      (((((((((((((((((((((((((((((((((((((((((      (((((
       (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
     ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
    ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
      (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
        (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((@@@@@@@(((((((((((((((((((((((((((@@@@@@@(((((((((((
         (((((((((@@@@,,,,,@@@(((((((((((((((((((((@@@,,,,,@@@@(((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         (((((((((@@@,,,,,,,@@((((((((@@@@@((((((((@@,,,,,,,@@@(((((((((
         ((((((((((((@@@@@@(((((((((((@@@@@(((((((((((@@@@@@((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         @@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@
         ((((((((( @@@(((((((((((@@(((((((((((@@(((((((((((@@@ (((((((((
         (((((((((( @@((((((((((@@@(((((((((((@@@((((((((((@@ ((((((((((
          (((((((((((@@@@@@@@@@@@@@(((((((((((@@@@@@@@@@@@@@(((((((((((
           (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
              (((((((((((((((((((((((((((((((((((((((((((((((((((((
                 (((((((((((((((((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((


                          /$$      /$$  /$$$$$$  /$$$$$$$
                         | $$$    /$$$ /$$__  $$| $$__  $$
                         | $$$$  /$$$$| $$  \__/| $$  \ $$
                         | $$ $$/$$ $$| $$      | $$$$$$$/
                         | $$  $$$| $$| $$      | $$____/
                         | $$\  $ | $$| $$    $$| $$
                         | $$ \/  | $$|  $$$$$$/| $$
                         |__/     |__/ \______/ |__/
```

A Model Context Protocol (MCP) server for interacting with the Godot game engine.

## Introduction

Godot MCP enables AI agents to launch the Godot editor, run projects, capture debug output, and control project execution. This direct feedback loop helps agents understand what works and what doesn't in real Godot projects, leading to better code generation and debugging assistance.

## Features

- **Editor Control**:
  - Launch the Godot editor for a specific project
  - Capture editor-side logs separately with `get_editor_log`
- **Runtime Control**:
  - Run projects or specific scenes in debug mode
  - Restart the currently tracked run with `reload_project`
  - Stop active runs programmatically
- **Logs and Diagnostics**:
  - Retrieve runtime stdout/stderr with `get_debug_output`
  - View bounded recent editor logs with `get_editor_log` or `view_log`
  - Headlessly validate GDScript files and scene loads with `check_scripts`
- **Optional Live Inspection Addon**:
  - Install and manage an in-project live bridge addon with MCP tools
  - Inspect the live scene tree, node state, groups, and combined debug snapshots from a running project
- **Project Discovery and Analysis**:
  - Get the installed Godot version
  - List Godot projects in a specified directory
  - Get detailed information about project structure
  - Read the configured main scene
  - List available scenes in a project
- **Scene Management**:
  - Create new scenes with specified root node types
  - Add nodes to existing scenes with customizable properties
  - Load sprites and textures into Sprite2D nodes
  - Export 3D scenes as MeshLibrary resources for GridMap
  - Save scenes with options for creating variants
- **Scene Inspection and Visual Verification**:
  - Inspect scene hierarchies offline with `get_scene_tree`
  - Capture screenshots from the main scene or a specific scene
  - Crop, scale, hide UI overlays, and keep captured PNGs for inspection
- **UID Management** (for Godot 4.4+):
  - Get UID for specific files
  - Update UID references by resaving resources

## Requirements

- [Godot Engine](https://godotengine.org/download) installed on your system
- Node.js (>=18.0.0) and npm
- An AI agent that supports MCP

## Quick Start

### Claude Code

```bash
claude mcp add godot -- npx @coding-solo/godot-mcp
```

That's it. Restart Claude Code and your Godot MCP tools are available.

With environment variables:

```bash
claude mcp add godot -e GODOT_PATH=/path/to/godot -e DEBUG=true -- npx @coding-solo/godot-mcp
```

<details>
<summary><strong>Cline</strong></summary>

Add to your Cline MCP settings file (`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "DEBUG": "true"
      },
      "disabled": false,
      "autoApprove": [
        "launch_editor",
        "run_project",
        "run_scene",
        "reload_project",
        "get_debug_output",
        "get_editor_log",
        "stop_project",
        "get_godot_version",
        "list_projects",
        "get_project_info",
        "get_main_scene",
        "list_scenes",
        "create_scene",
        "add_node",
        "load_sprite",
        "export_mesh_library",
        "save_scene",
        "get_uid",
        "update_project_uids",
        "install_live_bridge",
        "enable_live_bridge",
        "disable_live_bridge",
        "uninstall_live_bridge",
        "get_live_bridge_status",
        "get_scene_tree",
        "get_live_main_scene",
        "get_live_scene_tree",
        "get_live_node_state",
        "list_live_groups",
        "capture_debug_state",
        "check_scripts",
        "capture_screenshot",
        "capture_scene_screenshot"
      ]
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

**Using the Cursor UI:**

1. Go to **Cursor Settings** > **Features** > **MCP**
2. Click on the **+ Add New MCP Server** button
3. Fill out the form:
   - Name: `godot`
   - Type: `command`
   - Command: `npx @coding-solo/godot-mcp`
4. Click "Add"
5. You may need to press the refresh button in the top right corner of the MCP server card to populate the tool list

**Using Project-Specific Configuration:**

Create a file at `.cursor/mcp.json` in your project directory:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Other MCP Clients</strong></summary>

For any MCP-compatible client, use this configuration:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "GODOT_PATH": "/path/to/godot",
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GODOT_PATH` | Path to the Godot executable (overrides automatic detection) |
| `DEBUG` | Set to `"true"` to enable detailed server-side debug logging |

<details>
<summary><strong>Building from Source</strong></summary>

```bash
git clone https://github.com/Coding-Solo/godot-mcp.git
cd godot-mcp
npm install
npm run build
npm test
```

Then point your MCP client to `build/index.js` instead of using `npx`.

The test suite uses Node's built-in test runner and currently focuses on the server's validation and parameter-conversion helpers, which are high-value regression points for path safety and tool argument handling.

For a real-project MCP smoke test over stdio:

```bash
npm run smoke-test -- --project /path/to/project
```

Optional flags let you exercise more of the live flow:

```bash
npm run smoke-test -- --project /path/to/project --run-project --wait-for-log READY
npm run smoke-test -- --project /path/to/project --capture
```

</details>

## Reliability Notes

- Windows auto-detection now checks common standalone installs, Steam installs, and additional `Program Files` / `LocalAppData\\Programs` locations before falling back to `godot` on `PATH`.
- `launch_editor`, `run_project`, `capture_screenshot`, and `capture_scene_screenshot` accept an optional `godotPath` argument when you need to force a specific executable for a single call.
- `run_project` also accepts `waitForLog` and `readyTimeoutMs` so callers can wait for a known startup log line before treating the project as ready.
- The optional live bridge uses a localhost TCP connection with a per-session token generated by the MCP server.
- On Windows, GUI-only Godot installs can be harder to track reliably for long-running runtime sessions. If your install provides a console-capable executable, prefer that for `run_project` and live inspection workflows.

## Tool Catalog

Current MCP tools in this server:

- `launch_editor`
- `run_project`
- `run_scene`
- `reload_project`
- `get_debug_output`
- `get_editor_log`
- `view_log`
- `stop_project`
- `quit_godot`
- `get_godot_version`
- `list_projects`
- `get_project_info`
- `get_main_scene`
- `list_scenes`
- `create_scene`
- `add_node`
- `load_sprite`
- `export_mesh_library`
- `save_scene`
- `get_uid`
- `update_project_uids`
- `install_live_bridge`
- `enable_live_bridge`
- `disable_live_bridge`
- `uninstall_live_bridge`
- `get_live_bridge_status`
- `get_scene_tree`
- `get_live_main_scene`
- `get_live_scene_tree`
- `get_live_node_state`
- `list_live_groups`
- `capture_debug_state`
- `check_scripts`
- `capture_screenshot`
- `capture_scene_screenshot`

## Runtime Tools

### `launch_editor`

Launch the Godot editor for a project.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |
| `godotPath` | string | | Optional per-call override for the Godot executable. |

### `run_project`

Run a Godot project in debug mode and capture stdout/stderr for `get_debug_output` and `view_log`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |
| `scene` | string | | Optional scene to run instead of the configured main scene. |
| `godotPath` | string | | Optional per-call override for the Godot executable. |
| `waitForLog` | string | | Optional log substring to wait for before returning success. |
| `readyTimeoutMs` | number | `10000` | Maximum time to wait for `waitForLog` before returning an error. |

**Example uses:**
- Start the project and return immediately:
  `run_project({ projectPath: "C:\\Projects\\MyGame" })`
- Wait until your game prints a ready line:
  `run_project({ projectPath: "C:\\Projects\\MyGame", waitForLog: "READY", readyTimeoutMs: 15000 })`
- Force a specific executable for one run:
  `run_project({ projectPath: "C:\\Projects\\MyGame", godotPath: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine\\godot.windows.opt.tools.64.exe" })`

### `get_debug_output`, `get_editor_log`, and `view_log`

- `get_debug_output` returns structured JSON-like output for the currently running project.
- `get_editor_log` returns the most recent captured lines from the editor process started with `launch_editor`.
- `view_log` remains available as a compatibility alias for editor log output.
- Both are bounded internally, so long sessions do not grow memory without limit.

### `get_main_scene`

Read the configured `application/run/main_scene` value from `project.godot`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |

### `list_scenes`

List `.tscn` files in the project as `res://` paths.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |

### `get_scene_tree`

Inspect a scene file's node hierarchy without running the full project window.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |
| `scenePath` | string | main scene | Optional `res://` scene path. If omitted, the project main scene is used. |
| `rootNodePath` | string | | Optional node path inside the instantiated scene to inspect as a subtree. |
| `includeOwner` | boolean | `false` | Include owner paths in the returned tree when available. |
| `godotPath` | string | | Optional per-call override for the Godot executable. |

The response is a JSON tree with node `name`, `type`, `path`, and `children`.

## Live Bridge Addon

The live bridge is an optional addon managed by this MCP server. It keeps the existing offline tools unchanged and adds a second set of live-inspection tools when installed into a target project.

- Transport: localhost TCP bound to `127.0.0.1`
- Auth: per-session token generated by the MCP server
- Scope in v1: live scene discovery, scene tree inspection, node state inspection, group listing, and combined debug snapshots

### `install_live_bridge`, `enable_live_bridge`, `disable_live_bridge`, `uninstall_live_bridge`

Use these tools to manage the addon lifecycle inside a Godot project.

| Tool | Purpose |
|------|---------|
| `install_live_bridge` | Copies the addon into `addons/godot_mcp_bridge`. |
| `enable_live_bridge` | Enables the editor plugin metadata and adds the runtime autoload entry. |
| `disable_live_bridge` | Removes the runtime autoload entry and disables the plugin metadata. |
| `uninstall_live_bridge` | Disables the addon and removes `addons/godot_mcp_bridge`. |

All four tools take:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |

### `get_live_bridge_status`

Return the current addon state for a project.

Possible `status` values:

- `not_installed`
- `installed_disabled`
- `enabled_no_runtime_session`
- `connected_ready`

The response also reports whether the addon files are present, whether the plugin metadata is enabled, whether the autoload entry is active, and runtime connection details when a live session is attached.

### `get_live_main_scene`

Return the current live scene name and path from a running addon-enabled project.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |

### `get_live_scene_tree`

Inspect the live node hierarchy from a running addon-enabled project.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |
| `rootNodePath` | string | | Optional subtree root to inspect. |
| `includeOwner` | boolean | `false` | Include owner paths when available. |
| `maxNodes` | number | `500` | Maximum node count returned before truncation. |

### `get_live_node_state`

Inspect one live node by path.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |
| `nodePath` | string | required | Node path relative to the current scene, such as `Player` or `Player/Camera2D`. |
| `propertyNames` | string[] | built-in defaults | Optional property whitelist to serialize. |

Returned node payloads include `name`, `type`, `path`, `groups`, and a conservative JSON-safe `properties` object.

### `list_live_groups`

List active groups from the running scene.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |
| `includeMembers` | boolean | `true` | Include member node paths for each group. |

### `capture_debug_state`

Capture a combined live snapshot from a running addon-enabled project.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |
| `rootNodePath` | string | | Optional subtree root to inspect. |
| `propertyNames` | string[] | built-in defaults | Optional property whitelist for the selected node. |
| `includeOwner` | boolean | `false` | Include owner paths when available. |
| `maxNodes` | number | `500` | Maximum node count returned before truncation. |

The snapshot includes current scene info, the live scene tree, selected node state when applicable, active groups, and recent runtime logs when the MCP process is still tracking the run.

### `check_scripts`

Load GDScript files headlessly to catch parse and static typing errors.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |
| `scriptPath` | string | | Optional `res://` path to a specific script file to validate. |
| `includeScenes` | boolean | `false` | Also load `.tscn` scenes to catch script attachment and scene load errors. |
| `godotPath` | string | | Optional per-call override for the Godot executable. |

On success, the tool returns the checked script list. On failure, it reports the scripts or scenes that could not be loaded cleanly.

### `run_scene`

Run a specific `res://` scene path in debug mode.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot`. |
| `scenePath` | string | required | `res://` path to the scene file to run. |
| `godotPath` | string | | Optional per-call override for the Godot executable. |
| `waitForLog` | string | | Optional log substring to wait for before returning success. |
| `readyTimeoutMs` | number | `10000` | Maximum time to wait for `waitForLog` before returning an error. |

### `reload_project`

Restart the currently tracked project using the last `run_project` or `run_scene` configuration.

- Returns an error if no project is currently running under MCP control.
- Reuses the last scene override, executable override, and ready-signal options when available.

## Smoke Testing

Use the smoke-test script to exercise the MCP server over stdio against a real Godot project.

Basic check:

```bash
npm run smoke-test -- --project /path/to/project
```

Exercise project startup and wait for a known ready line:

```bash
npm run smoke-test -- --project /path/to/project --run-project --wait-for-log READY --ready-timeout-ms 15000
```

Exercise screenshot capture too:

```bash
npm run smoke-test -- --project /path/to/project --capture --wait-frames 20
```

Force a specific Godot executable for the smoke test:

```bash
npm run smoke-test -- --project /path/to/project --godot-path "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine\\godot.windows.opt.tools.64.exe"
```

## Visual Debugging

`capture_screenshot` and `capture_scene_screenshot` return a rendered image directly
into the agent's context window, closing the visual feedback loop that console logs alone
cannot provide. The response text also includes image dimensions, and `keepTempFile`
can preserve the underlying PNG on disk for manual inspection.

**Example prompts:**
- "Capture a screenshot of my player scene at res://scenes/player.tscn so I can check the sprite position."
- "Run the main scene and show me what it looks like."
- "The enemy isn't showing up. Capture the combat scene and tell me what you see."

### `capture_screenshot`

Run a scene (or the project main scene) and capture one rendered frame.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot` |
| `scenePath` | string | | `res://` path to a `.tscn` to run. Omit to use the project main scene. |
| `waitFrames` | number | `10` | Frames to render before capture. Lets shaders, physics, and layout settle. |
| `timeoutMs` | number | `15000` | Hard timeout in ms. Godot is killed if capture takes longer. |
| `crop` | object | | Optional crop rectangle with `x`, `y`, `width`, and `height` applied after capture. |
| `scale` | number | | Optional post-capture scale factor such as `0.5` or `2`. |
| `hideDebugOverlay` | boolean | `false` | Temporarily hides Control-based UI before capture to reduce HUD/debug overlay noise. |
| `keepTempFile` | boolean | `false` | Keeps the temporary PNG on disk and includes its path in the response text. |
| `godotPath` | string | | Optional per-call override for the Godot executable. |

### `capture_scene_screenshot`

Load a specific `.tscn` file and capture one frame without running the full project.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `projectPath` | string | required | Directory containing `project.godot` |
| `scenePath` | string | required | `res://` path to the `.tscn` file |
| `timeoutMs` | number | `15000` | Hard timeout in ms. |
| `crop` | object | | Optional crop rectangle with `x`, `y`, `width`, and `height` applied after capture. |
| `scale` | number | | Optional post-capture scale factor such as `0.5` or `2`. |
| `hideDebugOverlay` | boolean | `false` | Temporarily hides Control-based UI before capture to reduce HUD/debug overlay noise. |
| `keepTempFile` | boolean | `false` | Keeps the temporary PNG on disk and includes its path in the response text. |
| `godotPath` | string | | Optional per-call override for the Godot executable. |

### Rendering context requirement

These tools require a **real display**. They run Godot without `--headless` so the
renderer produces actual pixels.

- **Local dev machine (macOS, Windows, Linux with desktop):** works out of the box.
- **Headless Linux (CI, SSH):** wrap Godot in `xvfb-run` before the binary path:

  ```bash
  # Install: sudo apt-get install xvfb
  xvfb-run -a godot --path /path/to/project ...
  ```

  Point `GODOT_PATH` to a wrapper script that calls `xvfb-run -a godot`:

  ```bash
  #!/bin/sh
  exec xvfb-run -a /usr/bin/godot "$@"
  ```

  ```bash
  chmod +x /usr/local/bin/godot-xvfb
  export GODOT_PATH=/usr/local/bin/godot-xvfb
  ```

### Troubleshooting capture errors

| Error message | Likely cause | Fix |
|---------------|--------------|-----|
| `No graphical display detected` | Linux session has no DISPLAY/WAYLAND display | Run under `xvfb-run` or on a desktop session |
| `Viewport returned an empty image` | Headless Linux, no virtual display | Use `xvfb-run` (see above) |
| `Failed to load scene` | Wrong `scenePath` | Confirm `res://` prefix and that the file exists |
| `timed out after 15000ms` | Scene loading slowly or crash | Increase `timeoutMs` or run `run_project` first to see errors |

## Architecture

The Godot MCP server uses a bundled GDScript approach for complex operations:

1. **Direct Commands**: Simple operations like launching the editor or getting project info use Godot's built-in CLI commands directly.
2. **Bundled Operations Script**: Complex operations like creating scenes or adding nodes use a single, comprehensive GDScript file (`godot_operations.gd`) that handles all operations.

The bundled script accepts operation type and parameters as JSON, allowing for flexible and dynamic operation execution without generating temporary files for each operation.

## Troubleshooting

- **Godot Not Found**: Set the `GODOT_PATH` environment variable to your Godot executable path
- **Connection Issues**: Ensure the server is running and restart your AI assistant
- **Invalid Project Path**: Ensure the path points to a directory containing a `project.godot` file
- **Build Issues**: Make sure all dependencies are installed by running `npm install`

<details>
<summary><strong>Cursor-Specific Issues</strong></summary>

- Ensure the MCP server shows up and is enabled in Cursor settings (Settings > MCP)
- MCP tools can only be run using the Agent chat profile (Cursor Pro or Business subscription)
- Use "Yolo Mode" to automatically run MCP tool requests

</details>

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
