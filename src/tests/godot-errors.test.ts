import test from 'node:test';
import assert from 'node:assert/strict';

import { extractGodotErrorDetails, getGodotErrorSolutions } from '../utils/godot-errors.js';

test('extractGodotErrorDetails classifies scene load failures', () => {
  const details = extractGodotErrorDetails(
    '',
    '[ERROR] Failed to load scene: res://scenes/missing.tscn\nScene file does not exist at: res://scenes/missing.tscn'
  );

  assert.ok(details);
  assert.equal(details?.kind, 'scene_load_failure');
  assert.match(details?.summary ?? '', /Failed to load scene/);
});

test('extractGodotErrorDetails classifies script failures', () => {
  const details = extractGodotErrorDetails(
    '',
    '[ERROR] Failed to parse JSON parameters: {bad json}\nJSON Error: Expected value'
  );

  assert.ok(details);
  assert.equal(details?.kind, 'script_failure');
});

test('getGodotErrorSolutions returns targeted advice for launch failures', () => {
  assert.deepEqual(getGodotErrorSolutions('launch_failure'), [
    'Ensure Godot is installed and GODOT_PATH points to a launchable executable',
    'Check that the executable is accessible from this process and not blocked by permissions',
  ]);
});
