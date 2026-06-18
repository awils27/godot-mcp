#!/usr/bin/env node

import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function parseArgs(argv) {
  const args = {
    capture: false,
    help: false,
    projectPath: '',
    readyTimeoutMs: 10000,
    runProject: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--project':
        args.projectPath = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--godot-path':
        args.godotPath = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--scene':
        args.scene = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--run-project':
        args.runProject = true;
        break;
      case '--wait-for-log':
        args.waitForLog = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--ready-timeout-ms':
        args.readyTimeoutMs = Number(argv[index + 1] ?? '10000');
        index += 1;
        break;
      case '--capture':
        args.capture = true;
        break;
      case '--capture-timeout-ms':
        args.captureTimeoutMs = Number(argv[index + 1] ?? '20000');
        index += 1;
        break;
      case '--wait-frames':
        args.waitFrames = Number(argv[index + 1] ?? '10');
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/smoke-test.js --project <path> [options]

Options:
  --godot-path <path>        Override GODOT_PATH for this smoke test run
  --scene <res://path>       Scene to use with run_project or capture_screenshot
  --run-project              Exercise run_project and stop_project
  --wait-for-log <text>      Wait for this log substring before run_project returns
  --ready-timeout-ms <ms>    Timeout for --wait-for-log (default 10000)
  --capture                  Exercise capture_screenshot as part of the smoke test
  --capture-timeout-ms <ms>  Timeout for capture_screenshot (default 20000)
  --wait-frames <n>          Frames to wait before capture (default 10)
  --help                     Show this message
`);
}

function summarizeTextContent(result) {
  const textBlock = result.content?.find((block) => block.type === 'text');
  return textBlock?.text ?? '(no text response)';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.projectPath) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const projectPath = resolve(args.projectPath);
  const buildIndexPath = resolve('build/index.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [buildIndexPath],
    env: {
      ...process.env,
      ...(args.godotPath ? { GODOT_PATH: args.godotPath } : {}),
    },
  });

  const client = new Client(
    {
      name: 'godot-mcp-smoke-test',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  let runProjectStarted = false;

  try {
    await client.connect(transport);
    console.log(`Connected to godot-mcp via stdio using ${buildIndexPath}`);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('get_godot_version'));
    assert.ok(toolNames.includes('get_project_info'));
    assert.ok(toolNames.includes('run_project'));
    console.log(`Listed ${toolNames.length} tools`);

    const versionResult = await client.callTool({
      name: 'get_godot_version',
      arguments: {},
    });
    console.log(`get_godot_version: ${summarizeTextContent(versionResult)}`);

    const projectInfoResult = await client.callTool({
      name: 'get_project_info',
      arguments: { projectPath },
    });
    console.log(`get_project_info: ${summarizeTextContent(projectInfoResult)}`);

    if (args.runProject) {
      const runArgs = {
        projectPath,
        ...(args.scene ? { scene: args.scene } : {}),
        ...(args.godotPath ? { godotPath: args.godotPath } : {}),
        ...(args.waitForLog ? { waitForLog: args.waitForLog } : {}),
        ...(args.waitForLog ? { readyTimeoutMs: args.readyTimeoutMs } : {}),
      };
      const runResult = await client.callTool({
        name: 'run_project',
        arguments: runArgs,
      });
      runProjectStarted = !runResult.isError;
      console.log(`run_project: ${summarizeTextContent(runResult)}`);

      const debugResult = await client.callTool({
        name: 'get_debug_output',
        arguments: {},
      });
      console.log(`get_debug_output: ${summarizeTextContent(debugResult)}`);
    }

    if (args.capture) {
      const captureResult = await client.callTool({
        name: 'capture_screenshot',
        arguments: {
          projectPath,
          timeoutMs: args.captureTimeoutMs ?? 20000,
          waitFrames: args.waitFrames ?? 10,
          ...(args.scene ? { scenePath: args.scene } : {}),
          ...(args.godotPath ? { godotPath: args.godotPath } : {}),
        },
      });
      console.log(`capture_screenshot: ${summarizeTextContent(captureResult)}`);
      assert.ok(
        captureResult.content?.some((block) => block.type === 'image'),
        'capture_screenshot should return an image block'
      );
    }

    console.log('Smoke test completed successfully.');
  } finally {
    if (runProjectStarted) {
      try {
        const stopResult = await client.callTool({
          name: 'stop_project',
          arguments: {},
        });
        console.log(`stop_project: ${summarizeTextContent(stopResult)}`);
      } catch (error) {
        console.error(`stop_project cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      await transport.close();
    } catch {
      // Ignore transport shutdown noise during cleanup.
    }
  }
}

main().catch((error) => {
  console.error(`Smoke test failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
