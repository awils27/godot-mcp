import { existsSync } from 'fs';
import { normalize } from 'path';

type SupportedPlatform = NodeJS.Platform;
type ProcessEnvLike = NodeJS.ProcessEnv;

export function getEnvGodotPath(env: ProcessEnvLike = process.env): string | null {
  return env.GODOT_PATH ? normalize(env.GODOT_PATH) : null;
}

export function getGodotPathCandidates(
  platform: SupportedPlatform = process.platform,
  env: ProcessEnvLike = process.env
): string[] {
  const candidates = ['godot'];

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Godot.app/Contents/MacOS/Godot',
      '/Applications/Godot_4.app/Contents/MacOS/Godot',
      `${env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
      `${env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
      `${env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
    );
  } else if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Godot\\Godot.exe',
      'C:\\Program Files (x86)\\Godot\\Godot.exe',
      'C:\\Program Files\\Godot_4\\Godot.exe',
      'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine\\godot.windows.opt.tools.64.exe',
      `${env.USERPROFILE}\\Godot\\Godot.exe`
    );
  } else if (platform === 'linux') {
    candidates.push(
      'godot4',
      '/usr/bin/godot',
      '/usr/local/bin/godot',
      '/snap/bin/godot',
      `${env.HOME}/.local/bin/godot`
    );
  }

  return candidates.filter(Boolean).map((candidate) => normalize(candidate));
}

export function getFallbackGodotPath(platform: SupportedPlatform = process.platform): string {
  if (platform === 'win32') {
    return normalize('C:\\Program Files\\Godot\\Godot.exe');
  }
  if (platform === 'darwin') {
    return normalize('/Applications/Godot.app/Contents/MacOS/Godot');
  }
  return normalize('/usr/bin/godot');
}

export function resolvePreferredGodotPath(
  platform: SupportedPlatform = process.platform,
  env: ProcessEnvLike = process.env
): string | null {
  const envPath = getEnvGodotPath(env);
  if (envPath) {
    return envPath;
  }

  for (const candidate of getGodotPathCandidates(platform, env)) {
    if (candidate === 'godot' || candidate === 'godot4') {
      return candidate;
    }
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
