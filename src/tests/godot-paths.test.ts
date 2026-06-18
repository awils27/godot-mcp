import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from 'path';

import {
  getEnvGodotPath,
  getFallbackGodotPath,
  getGodotPathCandidates,
} from '../utils/godot-paths.js';

test('getEnvGodotPath returns a normalized GODOT_PATH when present', () => {
  assert.equal(
    getEnvGodotPath({ GODOT_PATH: 'C:\\Tools\\Godot\\..\\Godot\\Godot.exe' }),
    'C:\\Tools\\Godot\\Godot.exe'
  );
});

test('getGodotPathCandidates includes platform-specific defaults', () => {
  const windowsCandidates = getGodotPathCandidates('win32', { USERPROFILE: 'C:\\Users\\Aiden' });
  assert.ok(windowsCandidates.includes('godot'));
  assert.ok(
    windowsCandidates.includes(
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine\\godot.windows.opt.tools.64.exe'
    )
  );

  const linuxCandidates = getGodotPathCandidates('linux', { HOME: '/home/aiden' });
  assert.ok(linuxCandidates.includes('godot'));
  assert.ok(linuxCandidates.includes('godot4'));
  assert.ok(linuxCandidates.includes(normalize('/home/aiden/.local/bin/godot')));
});

test('getFallbackGodotPath returns the expected per-platform default', () => {
  assert.equal(getFallbackGodotPath('win32'), 'C:\\Program Files\\Godot\\Godot.exe');
  assert.equal(getFallbackGodotPath('darwin'), normalize('/Applications/Godot.app/Contents/MacOS/Godot'));
  assert.equal(getFallbackGodotPath('linux'), normalize('/usr/bin/godot'));
});
