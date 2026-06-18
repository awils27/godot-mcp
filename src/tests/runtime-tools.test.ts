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
const BROKEN_SCRIPT_PROJECT = join(__dirname, '..', '..', 'tests', 'fixtures', 'broken-script-project');
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
    { name: 'godot-mcp-runtime-tools-test', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await transport.close();
  }
}

test('get_main_scene returns the configured main scene from project.godot', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'get_main_scene',
      arguments: {
        projectPath: FIXTURE_PROJECT,
      },
    }) as { isError?: boolean; content: ToolContentBlock[] };

    assert.ok(!result.isError, `Expected success but got: ${JSON.stringify(result)}`);
    assert.equal(result.content[0]?.text, 'res://scenes/main.tscn');
  });
});

test('list_scenes returns res:// scene paths in the project', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'list_scenes',
      arguments: {
        projectPath: FIXTURE_PROJECT,
      },
    }) as { isError?: boolean; content: ToolContentBlock[] };

    assert.ok(!result.isError, `Expected success but got: ${JSON.stringify(result)}`);
    const scenes = JSON.parse(String(result.content[0]?.text ?? '[]')) as string[];
    assert.ok(scenes.includes('res://scenes/main.tscn'));
  });
});

test('run_scene can launch a specific scene path', async (t) => {
  const godotPath = process.env.GODOT_PATH ?? resolvePreferredGodotPath();
  if (!godotPath) {
    t.skip('Godot not available');
    return;
  }

  await withClient(async (client) => {
    const runResult = await client.callTool({
      name: 'run_scene',
      arguments: {
        projectPath: FIXTURE_PROJECT,
        scenePath: 'res://scenes/main.tscn',
        godotPath,
      },
    }) as { isError?: boolean; content: ToolContentBlock[] };

    assert.ok(!runResult.isError, `Expected success but got: ${JSON.stringify(runResult)}`);
    assert.match(String(runResult.content[0]?.text ?? ''), /started in debug mode/i);

    const stopResult = await client.callTool({
      name: 'stop_project',
      arguments: {},
    }) as { isError?: boolean; content: ToolContentBlock[] };

    assert.ok(!stopResult.isError, `Expected stop_project success but got: ${JSON.stringify(stopResult)}`);
  });
});

test('reload_project returns an error when nothing is running', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'reload_project',
      arguments: {},
    }) as { isError?: boolean; content: ToolContentBlock[] };

    assert.equal(result.isError, true);
    assert.match(String(result.content[0]?.text ?? ''), /No active Godot project to reload/i);
  });
});

test('get_editor_log returns a clean empty-state response before the editor is launched', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'get_editor_log',
      arguments: {},
    }) as { isError?: boolean; content: ToolContentBlock[] };

    assert.ok(!result.isError, `Expected success but got: ${JSON.stringify(result)}`);
    assert.equal(String(result.content[0]?.text ?? ''), '(no output captured yet)');
  });
});

test('check_scripts validates project scripts successfully', async (t) => {
  const godotPath = process.env.GODOT_PATH ?? resolvePreferredGodotPath();
  if (!godotPath) {
    t.skip('Godot not available');
    return;
  }

  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'check_scripts',
      arguments: {
        projectPath: FIXTURE_PROJECT,
        godotPath,
      },
    }) as { isError?: boolean; content: ToolContentBlock[] };

    assert.ok(!result.isError, `Expected success but got: ${JSON.stringify(result)}`);
    const parsed = JSON.parse(String(result.content[0]?.text ?? '{}')) as {
      checkedScripts: string[];
      checkedScenes: string[];
    };
    assert.ok(parsed.checkedScripts.includes('res://scripts/main.gd'));
    assert.deepEqual(parsed.checkedScenes, []);
  });
});

test('check_scripts can validate a specific script path', async (t) => {
  const godotPath = process.env.GODOT_PATH ?? resolvePreferredGodotPath();
  if (!godotPath) {
    t.skip('Godot not available');
    return;
  }

  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'check_scripts',
      arguments: {
        projectPath: FIXTURE_PROJECT,
        scriptPath: 'res://scripts/main.gd',
        godotPath,
      },
    }) as { isError?: boolean; content: ToolContentBlock[] };

    assert.ok(!result.isError, `Expected success but got: ${JSON.stringify(result)}`);
    const parsed = JSON.parse(String(result.content[0]?.text ?? '{}')) as {
      checkedScripts: string[];
    };
    assert.deepEqual(parsed.checkedScripts, ['res://scripts/main.gd']);
  });
});

test('check_scripts reports broken GDScript files as errors', async (t) => {
  const godotPath = process.env.GODOT_PATH ?? resolvePreferredGodotPath();
  if (!godotPath) {
    t.skip('Godot not available');
    return;
  }

  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'check_scripts',
      arguments: {
        projectPath: BROKEN_SCRIPT_PROJECT,
        includeScenes: true,
        godotPath,
      },
    }) as { isError?: boolean; content: ToolContentBlock[] };

    assert.equal(result.isError, true, `Expected failure but got: ${JSON.stringify(result)}`);
    const combinedText = result.content.map((block) => String(block.text ?? '')).join('\n');
    assert.match(combinedText, /broken\.gd/i);
  });
});
