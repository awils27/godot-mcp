import { readFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CaptureConfig {
  godotPath: string;
  operationsScriptPath: string;
}

interface CaptureCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

function makeTempPath(): string {
  return join(tmpdir(), `godot-mcp-capture-${Date.now()}.png`);
}

function cleanupTemp(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Ignore cleanup errors.
  }
}

function captureErrorResponse(message: string, solutions: string[]): object {
  return {
    content: [
      { type: 'text', text: message },
      { type: 'text', text: 'Possible solutions:\n- ' + solutions.join('\n- ') },
    ],
    isError: true,
  };
}

function parsePngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    return null;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function validateCrop(crop: unknown): CaptureCrop | null {
  if (!crop || typeof crop !== 'object') return null;

  const { x, y, width, height } = crop as Record<string, unknown>;
  const numericValues = [x, y, width, height];
  if (numericValues.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return null;
  }

  const normalized = {
    x: Math.floor(x as number),
    y: Math.floor(y as number),
    width: Math.floor(width as number),
    height: Math.floor(height as number),
  };

  if (normalized.x < 0 || normalized.y < 0 || normalized.width <= 0 || normalized.height <= 0) {
    return null;
  }

  return normalized;
}

function validateScale(scale: unknown): number | null {
  if (scale === undefined) return null;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return null;
  return scale;
}

function getDisplayPreflightError(): string | null {
  if (process.platform !== 'linux') return null;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return null;
  return 'No graphical display detected. Screenshot capture needs a real display or a virtual display such as xvfb-run.';
}

function formatCaptureSuccessText(
  prefix: string,
  dimensions: { width: number; height: number } | null,
  tempPath?: string
): string {
  const details: string[] = [];

  if (dimensions) {
    details.push(`${dimensions.width}x${dimensions.height}`);
  }
  if (tempPath) {
    details.push(`temporary file kept at ${tempPath}`);
  }

  return details.length > 0 ? `${prefix} (${details.join(', ')}).` : prefix;
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
  const timeoutMs = (args.timeoutMs ?? 15000) as number;
  const keepTempFile = args.keepTempFile === true;
  const hideDebugOverlay = args.hideDebugOverlay === true;

  const crop = args.crop === undefined ? null : validateCrop(args.crop);
  if (args.crop !== undefined && crop === null) {
    return captureErrorResponse('Invalid crop parameter.', [
      'Provide crop as an object with non-negative numeric x/y and positive width/height values',
    ]);
  }

  const scale = validateScale(args.scale);
  if (args.scale !== undefined && scale === null) {
    return captureErrorResponse('Invalid scale parameter.', [
      'Provide a positive numeric scale value such as 0.5 or 2',
    ]);
  }

  const displayError = getDisplayPreflightError();
  if (displayError) {
    return captureErrorResponse(displayError, [
      'Run on a machine with a display session',
      'On headless Linux, use xvfb-run and point GODOT_PATH to a wrapper script',
    ]);
  }

  const outputPath = makeTempPath();

  // Pass snake_case keys directly to the GDScript operation.
  const params: Record<string, unknown> = {
    output_path: outputPath,
    scene_path: scenePath,
    wait_frames: waitFrames,
    hide_debug_overlay: hideDebugOverlay,
  };
  if (crop) params.crop = crop;
  if (scale !== null) params.scale = scale;

  // NOTE: No --headless. Capture requires a real rendering context.
  const godotArgs = [
    '--path', projectPath,
    '--script', config.operationsScriptPath,
    'capture_screenshot',
    JSON.stringify(params),
  ];

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    await execFileAsync(config.godotPath, godotArgs, {
      signal: controller.signal as AbortSignal,
    });
  } catch (err: unknown) {
    cleanupTemp(outputPath);
    if (timedOut) {
      return {
        content: [{
          type: 'text',
          text: `Capture timed out after ${timeoutMs}ms. The scene may be loading slowly or Godot may have crashed.`,
        }],
        isError: true,
      };
    }
    // Non-zero exit: Godot printed an error via [ERROR]. Check for PNG anyway.
    if (!existsSync(outputPath)) {
      const msg = err instanceof Error ? err.message : String(err);
      return captureErrorResponse(`Capture failed: ${msg}`, [
        'Ensure Godot is installed and GODOT_PATH is set correctly',
        'On headless Linux, wrap Godot in xvfb-run for a virtual display',
        'Verify projectPath contains a project.godot file',
        'Check that scenePath (if provided) exists as a res:// path in the project',
      ]);
    }
  } finally {
    clearTimeout(timer);
  }

  if (!existsSync(outputPath)) {
    return captureErrorResponse(
      'Godot exited without writing a screenshot. The scene may have failed to load or no display is available.',
      [
        'Run on a machine with a display (not in --headless mode)',
        'On headless Linux, use xvfb-run (see README)',
        'Verify the scene loads correctly with run_project first',
      ]
    );
  }

  const imageBuffer = readFileSync(outputPath);
  const imageData = imageBuffer.toString('base64');
  const dimensions = parsePngDimensions(imageBuffer);
  if (!keepTempFile) {
    cleanupTemp(outputPath);
  }

  const sceneLabel = scenePath ? scenePath : 'main scene';
  return {
    content: [
      {
        type: 'text',
        text: formatCaptureSuccessText(
          `Screenshot captured from ${sceneLabel} after ${waitFrames} frames`,
          dimensions,
          keepTempFile ? outputPath : undefined
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
  const timeoutMs = (args.timeoutMs ?? 15000) as number;
  const keepTempFile = args.keepTempFile === true;
  const hideDebugOverlay = args.hideDebugOverlay === true;

  const crop = args.crop === undefined ? null : validateCrop(args.crop);
  if (args.crop !== undefined && crop === null) {
    return captureErrorResponse('Invalid crop parameter.', [
      'Provide crop as an object with non-negative numeric x/y and positive width/height values',
    ]);
  }

  const scale = validateScale(args.scale);
  if (args.scale !== undefined && scale === null) {
    return captureErrorResponse('Invalid scale parameter.', [
      'Provide a positive numeric scale value such as 0.5 or 2',
    ]);
  }

  const displayError = getDisplayPreflightError();
  if (displayError) {
    return captureErrorResponse(displayError, [
      'Run on a machine with a display session',
      'On headless Linux, use xvfb-run and point GODOT_PATH to a wrapper script',
    ]);
  }

  const outputPath = makeTempPath();

  const params: Record<string, unknown> = {
    output_path: outputPath,
    scene_path: scenePath,
    hide_debug_overlay: hideDebugOverlay,
  };
  if (crop) params.crop = crop;
  if (scale !== null) params.scale = scale;

  // NOTE: No --headless. Capture requires a real rendering context.
  const godotArgs = [
    '--path', projectPath,
    '--script', config.operationsScriptPath,
    'capture_scene_screenshot',
    JSON.stringify(params),
  ];

  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    await execFileAsync(config.godotPath, godotArgs, {
      signal: controller.signal as AbortSignal,
    });
  } catch (err: unknown) {
    cleanupTemp(outputPath);
    if (timedOut) {
      return {
        content: [{
          type: 'text',
          text: `Scene screenshot timed out after ${timeoutMs}ms.`,
        }],
        isError: true,
      };
    }
    if (!existsSync(outputPath)) {
      const msg = err instanceof Error ? err.message : String(err);
      return captureErrorResponse(`Scene capture failed: ${msg}`, [
        'Verify scenePath is a valid res:// path (e.g. res://scenes/main.tscn)',
        'Ensure a display is available (use xvfb-run on headless Linux)',
        'Confirm projectPath contains a project.godot file',
      ]);
    }
  } finally {
    clearTimeout(timer);
  }

  if (!existsSync(outputPath)) {
    return captureErrorResponse(
      'Godot exited without writing a scene screenshot. The scene may have failed to load or no display is available.',
      [
        'Run on a machine with a display (not in --headless mode)',
        'On headless Linux, use xvfb-run (see README)',
        'Check that scenePath exists in the project: ' + scenePath,
      ]
    );
  }

  const imageBuffer = readFileSync(outputPath);
  const imageData = imageBuffer.toString('base64');
  const dimensions = parsePngDimensions(imageBuffer);
  if (!keepTempFile) {
    cleanupTemp(outputPath);
  }

  return {
    content: [
      {
        type: 'text',
        text: formatCaptureSuccessText(
          `Scene screenshot captured: ${scenePath}`,
          dimensions,
          keepTempFile ? outputPath : undefined
        ),
      },
      { type: 'image', data: imageData, mimeType: 'image/png' },
    ],
  };
}
