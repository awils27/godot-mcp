import { existsSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createErrorResponse } from '../utils/mcp-response.js';

export interface CaptureConfig {
  godotPath: string;
  operationsScriptPath: string;
}

export interface CaptureCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureOptions {
  crop: CaptureCrop | null;
  hideDebugOverlay: boolean;
  keepTempFile: boolean;
  scale: number | null;
  timeoutMs: number;
}

export interface CaptureImageDimensions {
  width: number;
  height: number;
}

export function makeTempPath(): string {
  return join(tmpdir(), `godot-mcp-capture-${Date.now()}.png`);
}

export function cleanupTemp(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Ignore cleanup errors.
  }
}

export function parsePngDimensions(buffer: Buffer): CaptureImageDimensions | null {
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

export function validateCrop(crop: unknown): CaptureCrop | null {
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

export function validateScale(scale: unknown): number | null {
  if (scale === undefined) return null;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return null;
  return scale;
}

export function getDisplayPreflightError(): string | null {
  if (process.platform !== 'linux') return null;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return null;
  return 'No graphical display detected. Screenshot capture needs a real display or a virtual display such as xvfb-run.';
}

export function formatCaptureSuccessText(
  prefix: string,
  dimensions: CaptureImageDimensions | null,
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

export function parseCaptureOptions(args: Record<string, unknown>):
  | { ok: true; value: CaptureOptions }
  | { ok: false; error: object } {
  const crop = args.crop === undefined ? null : validateCrop(args.crop);
  if (args.crop !== undefined && crop === null) {
    return {
      ok: false,
      error: createErrorResponse('Invalid crop parameter.', [
        'Provide crop as an object with non-negative numeric x/y and positive width/height values',
      ]),
    };
  }

  const scale = validateScale(args.scale);
  if (args.scale !== undefined && scale === null) {
    return {
      ok: false,
      error: createErrorResponse('Invalid scale parameter.', [
        'Provide a positive numeric scale value such as 0.5 or 2',
      ]),
    };
  }

  const displayError = getDisplayPreflightError();
  if (displayError) {
    return {
      ok: false,
      error: createErrorResponse(displayError, [
        'Run on a machine with a display session',
        'On headless Linux, use xvfb-run and point GODOT_PATH to a wrapper script',
      ]),
    };
  }

  return {
    ok: true,
    value: {
      crop,
      hideDebugOverlay: args.hideDebugOverlay === true,
      keepTempFile: args.keepTempFile === true,
      scale,
      timeoutMs: (args.timeoutMs ?? 15000) as number,
    },
  };
}

export function readCaptureResult(outputPath: string, keepTempFile: boolean): {
  dimensions: CaptureImageDimensions | null;
  imageData: string;
} {
  const imageBuffer = readFileSync(outputPath);
  const imageData = imageBuffer.toString('base64');
  const dimensions = parsePngDimensions(imageBuffer);

  if (!keepTempFile) {
    cleanupTemp(outputPath);
  }

  return { dimensions, imageData };
}
