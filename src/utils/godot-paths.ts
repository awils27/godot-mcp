import { existsSync, readdirSync } from 'fs';
import { join, normalize } from 'path';

type SupportedPlatform = NodeJS.Platform;
type ProcessEnvLike = NodeJS.ProcessEnv;

function dedupeNormalizedPaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map((candidate) => normalize(candidate)))];
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function getWindowsProgramRoots(env: ProcessEnvLike): string[] {
  return [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : undefined,
    env.LOCALAPPDATA,
    env.USERPROFILE,
  ].filter((value): value is string => Boolean(value));
}

function getDynamicWindowsGodotCandidates(env: ProcessEnvLike): string[] {
  const candidates: string[] = [];

  for (const root of getWindowsProgramRoots(env)) {
    if (!existsSync(root)) continue;

    for (const entry of safeReadDir(root)) {
      const lower = entry.toLowerCase();
      if (!lower.includes('godot')) continue;

      const fullPath = join(root, entry);
      if (fullPath.toLowerCase().endsWith('.exe')) {
        candidates.push(fullPath);
        continue;
      }

      for (const child of safeReadDir(fullPath)) {
        if (/^godot.*\.exe$/i.test(child)) {
          candidates.push(join(fullPath, child));
        }
      }
    }
  }

  return candidates;
}

export function getEnvGodotPath(env: ProcessEnvLike = process.env): string | null {
  return env.GODOT_PATH ? normalize(env.GODOT_PATH) : null;
}

export function getGodotPathCandidates(
  platform: SupportedPlatform = process.platform,
  env: ProcessEnvLike = process.env
): string[] {
  const commandCandidates = ['godot'];
  const filesystemCandidates: string[] = [];

  if (platform === 'darwin') {
    commandCandidates.push('godot4');
    filesystemCandidates.push(
      '/Applications/Godot.app/Contents/MacOS/Godot',
      '/Applications/Godot_4.app/Contents/MacOS/Godot',
      `${env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
      `${env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
      `${env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
    );
  } else if (platform === 'win32') {
    filesystemCandidates.push(
      'C:\\Program Files\\Godot\\Godot.exe',
      'C:\\Program Files\\Godot Engine\\Godot.exe',
      'C:\\Program Files (x86)\\Godot\\Godot.exe',
      'C:\\Program Files (x86)\\Godot Engine\\Godot.exe',
      'C:\\Program Files\\Godot_4\\Godot.exe',
      'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
      'C:\\Program Files\\Godot_v4\\Godot.exe',
      'C:\\Program Files (x86)\\Godot_v4\\Godot.exe',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine\\godot.windows.opt.tools.64.exe',
      env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Godot\\Godot.exe` : '',
      env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Godot Engine\\Godot.exe` : '',
      `${env.USERPROFILE}\\Godot\\Godot.exe`
    );
    filesystemCandidates.push(...getDynamicWindowsGodotCandidates(env));
  } else if (platform === 'linux') {
    commandCandidates.push('godot4');
    filesystemCandidates.push(
      '/usr/bin/godot',
      '/usr/local/bin/godot',
      '/snap/bin/godot',
      `${env.HOME}/.local/bin/godot`
    );
  }

  return dedupeNormalizedPaths([...filesystemCandidates, ...commandCandidates]);
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
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const candidate of getGodotPathCandidates(platform, env)) {
    if (candidate === 'godot' || candidate === 'godot4') {
      return candidate;
    }
  }

  return null;
}
