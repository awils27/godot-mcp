import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { resolvePreferredGodotPath } from '../utils/godot-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_PROJECT = join(__dirname, '..', '..', 'tests', 'fixtures', 'capture-test-project');
const BUILD_INDEX = join(__dirname, '..', 'index.js');

type ToolContentBlock = {
  type: string;
  text?: string;
};

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUILD_INDEX],
    env: {
      ...process.env,
      ...(process.env.GODOT_PATH ? { GODOT_PATH: process.env.GODOT_PATH } : {}),
    },
  });

  const client = new Client(
    { name: 'godot-mcp-scene-tree-test', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await transport.close();
  }
}

test('get_scene_tree returns the main-scene node hierarchy for the fixture project', async (t) => {
  const godotPath = process.env.GODOT_PATH ?? resolvePreferredGodotPath();
  if (!godotPath) {
    t.skip('Godot not available');
    return;
  }

  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'get_scene_tree',
      arguments: {
        projectPath: FIXTURE_PROJECT,
        godotPath,
      },
    }) as { isError?: boolean; content: ToolContentBlock[] };

    assert.ok(!result.isError, `Expected success but got: ${JSON.stringify(result)}`);
    const textBlock = result.content.find((block: ToolContentBlock) => block.type === 'text');
    assert.ok(textBlock && typeof textBlock.text === 'string', 'expected text content');

    const parsed = JSON.parse(textBlock.text) as {
      scene_path: string;
      tree: {
        name: string;
        type: string;
        path: string;
        children: Array<{ name: string; type: string; path: string }>;
      };
    };

    assert.equal(parsed.scene_path, 'res://scenes/main.tscn');
    assert.equal(parsed.tree.name, 'Main');
    assert.equal(parsed.tree.type, 'Node2D');
    assert.equal(parsed.tree.path, '.');
    assert.ok(parsed.tree.children.some((child) => child.name === 'Background'));
  });
});

test('get_scene_tree returns an error for an invalid rootNodePath', async (t) => {
  const godotPath = process.env.GODOT_PATH ?? resolvePreferredGodotPath();
  if (!godotPath) {
    t.skip('Godot not available');
    return;
  }

  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'get_scene_tree',
      arguments: {
        projectPath: FIXTURE_PROJECT,
        scenePath: 'res://scenes/main.tscn',
        rootNodePath: 'MissingNode',
        godotPath,
      },
    }) as { isError?: boolean; content: ToolContentBlock[] };

    assert.equal(result.isError, true, 'expected invalid rootNodePath to fail');
    const textBlock = result.content.find((block: ToolContentBlock) => block.type === 'text');
    assert.match(String(textBlock?.text ?? ''), /root_node_path not found|Root node path not found/i);
  });
});
