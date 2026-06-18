import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

import {
  getEnvGodotPath,
  getFallbackGodotPath,
  getGodotPathCandidates,
  resolvePreferredGodotPath,
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
  assert.ok(
    windowsCandidates.includes(
      'C:\\Program Files\\Godot Engine\\Godot.exe'
    )
  );
  assert.ok(
    windowsCandidates.includes(
      'C:\\Program Files\\Godot_v4\\Godot.exe'
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

test('resolvePreferredGodotPath prefers a discovered absolute Windows executable over command fallbacks', () => {
  const root = mkdtempSync(normalize(`${tmpdir()}\\godot-mcp-paths-`));
  const localPrograms = normalize(`${root}\\LocalAppData\\Programs`);
  const godotDir = normalize(`${localPrograms}\\Godot Engine`);
  const exePath = normalize(`${godotDir}\\Godot.exe`);

  mkdirSync(godotDir, { recursive: true });
  writeFileSync(exePath, '');

  try {
    const resolved = resolvePreferredGodotPath('win32', {
      LOCALAPPDATA: normalize(`${root}\\LocalAppData`),
      USERPROFILE: normalize(`${root}\\User`),
      ProgramFiles: normalize(`${root}\\Program Files`),
      'ProgramFiles(x86)': normalize(`${root}\\Program Files (x86)`),
    });

    assert.ok(resolved);
    assert.notEqual(resolved, 'godot');
    assert.match(resolved ?? '', /godot.*\.exe$/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
