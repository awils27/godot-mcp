import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { createErrorResponse } from '../utils/mcp-response.js';
import {
  cleanupTemp,
  type CaptureConfig,
  formatCaptureSuccessText,
  makeTempPath,
  parseCaptureOptions,
  readCaptureResult,
} from './capture-utils.js';

const execFileAsync = promisify(execFile);
interface CaptureExecutionConfig {
  failureMessage: string;
  missingOutputMessage: string;
  operation: 'capture_screenshot' | 'capture_scene_screenshot';
  outputPath: string;
  params: Record<string, unknown>;
  possibleSolutions: string[];
  timeoutMessage: string;
  timeoutMs: number;
}

async function runCaptureOperation(
  config: CaptureConfig,
  execution: CaptureExecutionConfig
): Promise<{ ok: true } | { ok: false; response: object }> {
  const godotArgs = [
    '--path',
    execution.params.project_path as string,
    '--script',
    config.operationsScriptPath,
    execution.operation,
    JSON.stringify(execution.params),
  ];

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, execution.timeoutMs);

  try {
    await execFileAsync(config.godotPath, godotArgs, {
      signal: controller.signal as AbortSignal,
    });
  } catch (err: unknown) {
    cleanupTemp(execution.outputPath);
    if (timedOut) {
      return {
        ok: false,
        response: {
          content: [
            {
              type: 'text',
              text: execution.timeoutMessage,
            },
          ],
          isError: true,
        },
      };
    }
    if (!existsSync(execution.outputPath)) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        response: createErrorResponse(`${execution.failureMessage}: ${msg}`, execution.possibleSolutions),
      };
    }
  } finally {
    clearTimeout(timer);
  }

  if (!existsSync(execution.outputPath)) {
    return {
      ok: false,
      response: createErrorResponse(execution.missingOutputMessage, execution.possibleSolutions),
    };
  }

  return { ok: true };
}

/**
 * Run a scene (or the project main scene) and capture one rendered frame as a PNG.
 * Godot is launched WITHOUT --headless so a real rendering context is used.
 */
export async function handleCaptureScreenshot(
  args: Record<string, unknown>,
  config: CaptureConfig
): Promise<object> {
  const projectPath = args.projectPath as string;
  const scenePath = (args.scenePath ?? '') as string;
  const waitFrames = (args.waitFrames ?? 10) as number;
  const parsedOptions = parseCaptureOptions(args);
  if (!parsedOptions.ok) {
    return parsedOptions.error;
  }
  const options = parsedOptions.value;

  const outputPath = makeTempPath();
  const params: Record<string, unknown> = {
    project_path: projectPath,
    output_path: outputPath,
    scene_path: scenePath,
    wait_frames: waitFrames,
    hide_debug_overlay: options.hideDebugOverlay,
  };
  if (options.crop) params.crop = options.crop;
  if (options.scale !== null) params.scale = options.scale;

  const execution = await runCaptureOperation(config, {
    failureMessage: 'Capture failed',
    missingOutputMessage:
      'Godot exited without writing a screenshot. The scene may have failed to load or no display is available.',
    operation: 'capture_screenshot',
    outputPath,
    params,
    possibleSolutions: [
      'Ensure Godot is installed and GODOT_PATH is set correctly',
      'On headless Linux, wrap Godot in xvfb-run for a virtual display',
      'Verify projectPath contains a project.godot file',
      'Check that scenePath (if provided) exists as a res:// path in the project',
    ],
    timeoutMessage: `Capture timed out after ${options.timeoutMs}ms. The scene may be loading slowly or Godot may have crashed.`,
    timeoutMs: options.timeoutMs,
  });
  if (!execution.ok) {
    return execution.response;
  }

  const { dimensions, imageData } = readCaptureResult(outputPath, options.keepTempFile);

  const sceneLabel = scenePath ? scenePath : 'main scene';
  return {
    content: [
      {
        type: 'text',
        text: formatCaptureSuccessText(
          `Screenshot captured from ${sceneLabel} after ${waitFrames} frames`,
          dimensions,
          options.keepTempFile ? outputPath : undefined
        ),
      },
      { type: 'image', data: imageData, mimeType: 'image/png' },
    ],
  };
}

/**
 * Load a specific .tscn file, instance it in the viewport, and capture one frame.
 * Godot is launched WITHOUT --headless so a real rendering context is used.
 */
export async function handleCaptureSceneScreenshot(
  args: Record<string, unknown>,
  config: CaptureConfig
): Promise<object> {
  const projectPath = args.projectPath as string;
  const scenePath = args.scenePath as string;
  const parsedOptions = parseCaptureOptions(args);
  if (!parsedOptions.ok) {
    return parsedOptions.error;
  }
  const options = parsedOptions.value;

  const outputPath = makeTempPath();
  const params: Record<string, unknown> = {
    project_path: projectPath,
    output_path: outputPath,
    scene_path: scenePath,
    hide_debug_overlay: options.hideDebugOverlay,
  };
  if (options.crop) params.crop = options.crop;
  if (options.scale !== null) params.scale = options.scale;

  const execution = await runCaptureOperation(config, {
    failureMessage: 'Scene capture failed',
    missingOutputMessage:
      'Godot exited without writing a scene screenshot. The scene may have failed to load or no display is available.',
    operation: 'capture_scene_screenshot',
    outputPath,
    params,
    possibleSolutions: [
      'Verify scenePath is a valid res:// path (e.g. res://scenes/main.tscn)',
      'Ensure a display is available (use xvfb-run on headless Linux)',
      'Confirm projectPath contains a project.godot file',
    ],
    timeoutMessage: `Scene screenshot timed out after ${options.timeoutMs}ms.`,
    timeoutMs: options.timeoutMs,
  });
  if (!execution.ok) {
    return execution.response;
  }

  const { dimensions, imageData } = readCaptureResult(outputPath, options.keepTempFile);

  return {
    content: [
      {
        type: 'text',
        text: formatCaptureSuccessText(
          `Scene screenshot captured: ${scenePath}`,
          dimensions,
          options.keepTempFile ? outputPath : undefined
        ),
      },
      { type: 'image', data: imageData, mimeType: 'image/png' },
    ],
  };
}
