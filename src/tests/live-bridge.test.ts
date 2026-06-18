import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
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

type ToolResult = {
  content: ToolContentBlock[];
  isError?: boolean;
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
    { name: 'godot-mcp-live-bridge-test', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await transport.close();
  }
}

function makeTempProject(): string {
  const tempRoot = mkdtempSync(join(tmpdir(), 'godot-mcp-live-bridge-'));
  const projectPath = join(tempRoot, 'project');
  cpSync(FIXTURE_PROJECT, projectPath, { recursive: true });
  return projectPath;
}

function parseToolJson(result: ToolResult): any {
  const textBlock = result.content.find((block) => block.type === 'text');
  assert.ok(textBlock?.text, `expected text block in result: ${JSON.stringify(result)}`);
  return JSON.parse(String(textBlock.text));
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({
    name,
    arguments: args,
  }) as ToolResult;

  assert.ok(!result.isError, `Expected ${name} success but got: ${JSON.stringify(result)}`);
  return parseToolJson(result);
}

async function waitForLiveBridgeReady(client: Client, projectPath: string, timeoutMs = 15000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await callToolJson(client, 'get_live_bridge_status', { projectPath });
    if (status.status === 'connected_ready') {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const finalStatus = await callToolJson(client, 'get_live_bridge_status', { projectPath });
  assert.fail(`live bridge did not connect in time: ${JSON.stringify(finalStatus)}`);
}

async function cleanupTempProject(projectPath: string): Promise<void> {
  const tempRoot = dirname(projectPath);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (error?.code !== 'EPERM' || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

test('live bridge lifecycle tools install, enable, disable, and uninstall cleanly', async () => {
  const projectPath = makeTempProject();

  try {
    await withClient(async (client) => {
      let status = await callToolJson(client, 'get_live_bridge_status', { projectPath });
      assert.equal(status.status, 'not_installed');
      assert.equal(status.installed, false);

      status = await callToolJson(client, 'install_live_bridge', { projectPath });
      assert.equal(status.installed, true);
      assert.equal(status.status, 'installed_disabled');
      assert.ok(existsSync(join(projectPath, 'addons', 'godot_mcp_bridge', 'plugin.cfg')));

      status = await callToolJson(client, 'enable_live_bridge', { projectPath });
      assert.equal(status.installed, true);
      assert.equal(status.pluginEnabled, true);
      assert.equal(status.autoloadEnabled, true);
      assert.equal(status.status, 'enabled_no_runtime_session');

      const projectConfig = readFileSync(join(projectPath, 'project.godot'), 'utf8');
      assert.match(projectConfig, /res:\/\/addons\/godot_mcp_bridge\/plugin\.cfg/);
      assert.match(projectConfig, /GodotMcpBridge="\*res:\/\/addons\/godot_mcp_bridge\/bridge_runtime\.gd"/);

      status = await callToolJson(client, 'disable_live_bridge', { projectPath });
      assert.equal(status.installed, true);
      assert.equal(status.pluginEnabled, false);
      assert.equal(status.autoloadEnabled, false);
      assert.equal(status.status, 'installed_disabled');

      status = await callToolJson(client, 'uninstall_live_bridge', { projectPath });
      assert.equal(status.installed, false);
      assert.equal(status.status, 'not_installed');
      assert.equal(existsSync(join(projectPath, 'addons', 'godot_mcp_bridge')), false);
    });
  } finally {
    await cleanupTempProject(projectPath);
  }
});

test('live bridge tools inspect a running addon-enabled project', async (t) => {
  const godotPath = process.env.GODOT_PATH ?? resolvePreferredGodotPath();
  if (!godotPath) {
    t.skip('Godot not available');
    return;
  }
  if (
    process.platform === 'win32' &&
    /godot\.windows\.opt\.tools\.64\.exe$/i.test(godotPath) &&
    !existsSync(godotPath.replace(/\.exe$/i, '.console.exe'))
  ) {
    t.skip('The Steam Windows editor build does not provide a console executable for stable MCP runtime tracking.');
    return;
  }

  const projectPath = makeTempProject();

  try {
    await withClient(async (client) => {
      try {
        await callToolJson(client, 'install_live_bridge', { projectPath });
        await callToolJson(client, 'enable_live_bridge', { projectPath });

        const runResult = await client.callTool({
          name: 'run_scene',
          arguments: {
            projectPath,
            scenePath: 'res://scenes/main.tscn',
            godotPath,
          },
        }) as ToolResult;
        assert.ok(!runResult.isError, `Expected run_scene success but got: ${JSON.stringify(runResult)}`);

        await new Promise((resolve) => setTimeout(resolve, 1000));
        const initialStatus = await callToolJson(client, 'get_live_bridge_status', { projectPath });
        if (initialStatus.status !== 'connected_ready') {
          const debugResult = await client.callTool({
            name: 'get_debug_output',
            arguments: {},
          }) as ToolResult;
          const debugText = debugResult.content.map((block) => String(block.text ?? '')).join('\n');
          if (debugResult.isError && /No active Godot process/i.test(debugText)) {
            t.skip('Current Godot executable exits immediately after launch, so live runtime inspection cannot be verified in this environment.');
            return;
          }
        }

        const readyStatus = await waitForLiveBridgeReady(client, projectPath);
        assert.equal(readyStatus.status, 'connected_ready');
        assert.equal(readyStatus.runtime.connected, true);

        const mainScene = await callToolJson(client, 'get_live_main_scene', { projectPath });
        assert.equal(mainScene.currentScenePath, 'res://scenes/main.tscn');
        assert.equal(mainScene.currentSceneName, 'Main');

        const tree = await callToolJson(client, 'get_live_scene_tree', {
          projectPath,
          maxNodes: 25,
        });
        assert.equal(tree.currentScene.currentScenePath, 'res://scenes/main.tscn');
        assert.equal(tree.tree.name, 'Main');
        assert.ok(
          tree.tree.children.some((child: { name: string }) => child.name === 'Player'),
          `expected Player node in tree: ${JSON.stringify(tree)}`
        );

        const nodeState = await callToolJson(client, 'get_live_node_state', {
          projectPath,
          nodePath: 'Player',
          propertyNames: ['position'],
        });
        assert.equal(nodeState.node.name, 'Player');
        assert.equal(nodeState.node.type, 'Node2D');
        assert.deepEqual(nodeState.node.properties.position, { x: 320, y: 180 });
        assert.ok(nodeState.node.groups.includes('actors'));

        const propertyList = await callToolJson(client, 'get_live_property_list', {
          projectPath,
          nodePath: '.',
          scriptOnly: true,
          includeValues: true,
        });
        assert.ok(
          propertyList.properties.some(
            (property: { name: string; value: string }) =>
              property.name === 'train_name' && property.value === 'Comet'
          ),
          `expected train_name in script property list: ${JSON.stringify(propertyList)}`
        );

        const scriptVariables = await callToolJson(client, 'get_live_script_variables', {
          projectPath,
          nodePath: '.',
          variableNames: ['train_name', 'runtime_status'],
        });
        assert.equal(scriptVariables.script.resourcePath, 'res://scripts/main.gd');
        assert.equal(scriptVariables.variables.train_name, 'Comet');
        assert.equal(scriptVariables.variables.runtime_status, 'ready');

        const groups = await callToolJson(client, 'list_live_groups', {
          projectPath,
          includeMembers: true,
        });
        assert.ok(groups.groups.actors.includes('/root/Main/Player'));
        assert.ok(groups.groups.roots.includes('/root/Main'));

        const snapshot = await callToolJson(client, 'capture_debug_state', {
          projectPath,
          rootNodePath: 'Player',
          propertyNames: ['position'],
        });
        assert.equal(snapshot.currentScene.currentScenePath, 'res://scenes/main.tscn');
        assert.equal(snapshot.nodeState.name, 'Player');
        assert.ok(Array.isArray(snapshot.recentRuntimeLogs.stdout));
        assert.ok(Array.isArray(snapshot.recentRuntimeLogs.stderr));

        const runtimeState = await callToolJson(client, 'capture_runtime_state', {
          projectPath,
          rootNodePath: '.',
          nodePaths: ['.', 'Player'],
          propertyNames: ['position'],
          variableNames: ['train_name', 'runtime_status'],
          includeScriptVariables: true,
          includePropertyList: true,
          includeValues: true,
          scriptOnly: true,
          maxNodes: 25,
          maxVariablesPerNode: 10,
        });
        assert.equal(runtimeState.currentScene.currentScenePath, 'res://scenes/main.tscn');
        assert.ok(Array.isArray(runtimeState.nodes));
        assert.equal(runtimeState.nodes.length, 2);
        assert.equal(runtimeState.nodes[0].nodeState.name, 'Main');
        assert.equal(runtimeState.nodes[0].variables.train_name, 'Comet');
        assert.equal(runtimeState.nodes[0].variables.runtime_status, 'ready');
        assert.ok(Array.isArray(runtimeState.nodes[0].propertyList));
        assert.ok(Array.isArray(runtimeState.recentRuntimeLogs.stdout));
      } finally {
        await client.callTool({
          name: 'stop_project',
          arguments: {},
        }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });
  } finally {
    await cleanupTempProject(projectPath);
  }
});

test('live bridge tools return a clear error when the addon is disabled', async () => {
  const projectPath = makeTempProject();

  try {
    await withClient(async (client) => {
      await callToolJson(client, 'install_live_bridge', { projectPath });

      const result = await client.callTool({
        name: 'get_live_main_scene',
        arguments: { projectPath },
      }) as ToolResult;

      assert.equal(result.isError, true);
      const combinedText = result.content.map((block) => String(block.text ?? '')).join('\n');
      assert.match(combinedText, /installed but not enabled/i);
    });
  } finally {
    await cleanupTempProject(projectPath);
  }
});
