# TODO

## High Priority

- [x] Improve `capture_screenshot` with optional `crop`, `scale`, and `hideDebugOverlay` parameters so visual verification is cleaner.
- [x] Improve `capture_screenshot` and `capture_scene_screenshot` to return image dimensions and, when helpful, the temporary output path in the text response.
- [x] Add a reusable display-availability preflight for screenshot tools so failures are clearer before Godot launches.
- [x] Add a ring buffer limit for `view_log` so long sessions do not grow memory usage without bound.
- [x] Improve error reporting so launch failure, scene load failure, script failure, and timeout are easier to distinguish.

## Reliability

- [x] Allow per-tool `godotPath` overrides for `launch_editor`, `run_project`, and screenshot tools.
- [x] Expand Windows auto-detection for Godot installs beyond the current default and Steam locations.
- [x] Let `run_project` optionally wait for a ready signal in logs before returning.

## Testing

- Add a reusable smoke-test script that exercises the MCP over stdio against a real Godot project.
- Extend screenshot tests to verify:
  - image payload exists
  - image orientation is upright
  - invalid `scenePath` returns the expected error
  - missing display returns the expected error
- Add more regression tests around tool argument normalization and validation.

## Documentation

- Document Steam Godot auto-detection in the README.
- Document screenshot requirements and common failure modes more explicitly.
- Add troubleshooting guidance for display/rendering issues during capture.

## Possible New Tools

- Add `get_main_scene`.
- Add `list_scenes`.
- Add `reload_project`.
- Add `run_scene`.
- Add `capture_debug_state` to combine logs, scene/runtime state, and a screenshot.
- Add `get_scene_tree` to inspect live nodes in a running project.
