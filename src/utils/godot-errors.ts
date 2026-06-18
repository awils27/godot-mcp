export type GodotErrorKind =
  | 'scene_load_failure'
  | 'script_failure'
  | 'launch_failure'
  | 'timeout'
  | 'unknown';

export interface GodotErrorDetails {
  kind: GodotErrorKind;
  lines: string[];
  summary: string;
}

function uniqueNonEmptyLines(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

function classifyGodotError(lines: string[]): GodotErrorKind {
  const combined = lines.join('\n').toLowerCase();

  if (combined.includes('timed out')) return 'timeout';
  if (
    combined.includes('failed to load scene') ||
    combined.includes('scene file does not exist') ||
    combined.includes('failed to load main scene')
  ) {
    return 'scene_load_failure';
  }
  if (
    combined.includes('spawn error') ||
    combined.includes('failed to start godot') ||
    combined.includes('enoent') ||
    combined.includes('eacces')
  ) {
    return 'launch_failure';
  }
  if (
    combined.includes('[error]') ||
    combined.includes('failed to parse json parameters') ||
    combined.includes('unknown operation') ||
    combined.includes('failed to save') ||
    combined.includes('failed to pack') ||
    combined.includes('parent node not found') ||
    combined.includes('node not found')
  ) {
    return 'script_failure';
  }

  return 'unknown';
}

export function extractGodotErrorDetails(stdout: string, stderr: string): GodotErrorDetails | null {
  const stderrLines = stderr.split(/\r?\n/);
  const stdoutLines = stdout.split(/\r?\n/);
  const relevantLines = uniqueNonEmptyLines(
    [
      ...stderrLines.filter((line) => line.includes('[ERROR]') || /failed|error/i.test(line)),
      ...stdoutLines.filter((line) => line.includes('[ERROR]') || /failed|error/i.test(line)),
    ]
  );

  if (relevantLines.length === 0) {
    return null;
  }

  return {
    kind: classifyGodotError(relevantLines),
    lines: relevantLines,
    summary: relevantLines[0],
  };
}

export function getGodotErrorSolutions(kind: GodotErrorKind): string[] {
  switch (kind) {
    case 'scene_load_failure':
      return [
        'Verify the target scene path exists and is a valid res:// path',
        'Open the scene in Godot to confirm it loads without missing dependencies',
      ];
    case 'launch_failure':
      return [
        'Ensure Godot is installed and GODOT_PATH points to a launchable executable',
        'Check that the executable is accessible from this process and not blocked by permissions',
      ];
    case 'script_failure':
      return [
        'Check the reported Godot error line for the failing operation or resource',
        'Verify the project files, node paths, and output paths used by the tool',
      ];
    case 'timeout':
      return [
        'Increase the timeout if the project or scene takes longer to load',
        'Check whether Godot opened but stalled on a missing resource or runtime error',
      ];
    default:
      return ['Review the captured Godot stderr/stdout for more context'];
  }
}
