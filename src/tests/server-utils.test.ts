import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PARAMETER_MAPPINGS,
  buildReverseParameterMappings,
  convertCamelToSnakeCase,
  isGodot44OrLater,
  normalizeParameters,
  validateClassName,
  validatePath,
} from '../utils/server-utils.js';

const reverseMappings = buildReverseParameterMappings(PARAMETER_MAPPINGS);

test('validateClassName accepts Godot-style identifiers', () => {
  assert.equal(validateClassName('Node2D'), true);
  assert.equal(validateClassName('CharacterBody3D'), true);
  assert.equal(validateClassName('_InternalNode'), true);
});

test('validateClassName rejects paths and malformed names', () => {
  const invalidNames = [
    '',
    '123Node',
    'res://player.gd',
    '../Player',
    'Node.Type',
    'Node/Type',
    'Node:Type',
    'Player Scene',
  ];

  for (const name of invalidNames) {
    assert.equal(validateClassName(name), false, `expected "${name}" to be rejected`);
  }
});

test('validatePath rejects traversal and empty values', () => {
  assert.equal(validatePath(''), false);
  assert.equal(validatePath('../addons/project'), false);
  assert.equal(validatePath('res://../addons/project'), false);
  assert.equal(validatePath('C:\\Projects\\Game'), true);
  assert.equal(validatePath('res://scenes/main.tscn'), true);
});

test('isGodot44OrLater handles supported and unsupported versions', () => {
  assert.equal(isGodot44OrLater('4.4.stable.official'), true);
  assert.equal(isGodot44OrLater('4.5.dev'), true);
  assert.equal(isGodot44OrLater('5.0.beta'), true);
  assert.equal(isGodot44OrLater('4.3.stable.official'), false);
  assert.equal(isGodot44OrLater('3.6.stable.official'), false);
  assert.equal(isGodot44OrLater('invalid-version'), false);
});

test('normalizeParameters converts nested snake_case keys to camelCase', () => {
  const input = {
    project_path: 'C:\\Projects\\Game',
    godot_path: 'C:\\Tools\\Godot.exe',
    scene_path: 'scenes/main.tscn',
    wait_for_log: 'READY',
    ready_timeout_ms: 15000,
    hide_debug_overlay: true,
    keep_temp_file: true,
    line_count: 25,
    property_names: ['position', 'scale'],
    max_nodes: 50,
    include_members: true,
    include_values: true,
    script_only: false,
    variable_names: ['runtime_status'],
    properties: {
      root_node_type: 'Node2D',
      child_config: {
        node_name: 'Player',
      },
    },
    mesh_item_names: ['Cube', 'Sphere'],
  };

  assert.deepEqual(normalizeParameters(input, PARAMETER_MAPPINGS), {
    projectPath: 'C:\\Projects\\Game',
    godotPath: 'C:\\Tools\\Godot.exe',
    scenePath: 'scenes/main.tscn',
    waitForLog: 'READY',
    readyTimeoutMs: 15000,
    hideDebugOverlay: true,
    keepTempFile: true,
    lineCount: 25,
    propertyNames: ['position', 'scale'],
    maxNodes: 50,
    includeMembers: true,
    includeValues: true,
    scriptOnly: false,
    variableNames: ['runtime_status'],
    properties: {
      rootNodeType: 'Node2D',
      child_config: {
        nodeName: 'Player',
      },
    },
    meshItemNames: ['Cube', 'Sphere'],
  });
});

test('convertCamelToSnakeCase converts mapped and fallback camelCase keys', () => {
  const input = {
    projectPath: 'C:\\Projects\\Game',
    godotPath: 'C:\\Tools\\Godot.exe',
    scenePath: 'scenes/main.tscn',
    rootNodeType: 'Node2D',
    waitForLog: 'READY',
    readyTimeoutMs: 15000,
    lineCount: 25,
    hideDebugOverlay: true,
    keepTempFile: true,
    propertyNames: ['position'],
    maxNodes: 50,
    includeMembers: false,
    includeValues: true,
    scriptOnly: true,
    variableNames: ['runtime_status'],
    customFlagName: true,
    properties: {
      nodeName: 'Player',
      childConfig: {
        meshItemNames: ['Cube'],
      },
    },
  };

  assert.deepEqual(convertCamelToSnakeCase(input, reverseMappings), {
    project_path: 'C:\\Projects\\Game',
    godot_path: 'C:\\Tools\\Godot.exe',
    scene_path: 'scenes/main.tscn',
    root_node_type: 'Node2D',
    wait_for_log: 'READY',
    ready_timeout_ms: 15000,
    line_count: 25,
    hide_debug_overlay: true,
    keep_temp_file: true,
    property_names: ['position'],
    max_nodes: 50,
    include_members: false,
    include_values: true,
    script_only: true,
    variable_names: ['runtime_status'],
    custom_flag_name: true,
    properties: {
      node_name: 'Player',
      child_config: {
        mesh_item_names: ['Cube'],
      },
    },
  });
});

test('normalizeParameters leaves arrays intact while normalizing nested objects', () => {
  const input = {
    mesh_item_names: ['Cube', 'Sphere'],
    crop: {
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    },
    options: [
      { keep_temp_file: true },
      'literal-value',
    ],
  };

  assert.deepEqual(normalizeParameters(input, PARAMETER_MAPPINGS), {
    meshItemNames: ['Cube', 'Sphere'],
    crop: {
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    },
    options: [
      { keep_temp_file: true },
      'literal-value',
    ],
  });
});
