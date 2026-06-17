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
    scene_path: 'scenes/main.tscn',
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
    scenePath: 'scenes/main.tscn',
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
    scenePath: 'scenes/main.tscn',
    rootNodeType: 'Node2D',
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
    scene_path: 'scenes/main.tscn',
    root_node_type: 'Node2D',
    custom_flag_name: true,
    properties: {
      node_name: 'Player',
      child_config: {
        mesh_item_names: ['Cube'],
      },
    },
  });
});
