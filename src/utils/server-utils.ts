export interface OperationParams {
  [key: string]: any;
}

export const PARAMETER_MAPPINGS: Record<string, string> = {
  project_path: 'projectPath',
  godot_path: 'godotPath',
  scene_path: 'scenePath',
  root_node_type: 'rootNodeType',
  parent_node_path: 'parentNodePath',
  node_type: 'nodeType',
  node_name: 'nodeName',
  texture_path: 'texturePath',
  node_path: 'nodePath',
  root_node_path: 'rootNodePath',
  output_path: 'outputPath',
  mesh_item_names: 'meshItemNames',
  new_path: 'newPath',
  file_path: 'filePath',
  directory: 'directory',
  recursive: 'recursive',
  scene: 'scene',
  wait_frames: 'waitFrames',
  wait_for_log: 'waitForLog',
  ready_timeout_ms: 'readyTimeoutMs',
  timeout_ms: 'timeoutMs',
  line_count: 'lineCount',
  hide_debug_overlay: 'hideDebugOverlay',
  keep_temp_file: 'keepTempFile',
  include_owner: 'includeOwner',
};

export function buildReverseParameterMappings(
  parameterMappings: Record<string, string>
): Record<string, string> {
  const reverseMappings: Record<string, string> = {};

  for (const [snakeCase, camelCase] of Object.entries(parameterMappings)) {
    reverseMappings[camelCase] = snakeCase;
  }

  return reverseMappings;
}

export function validatePath(path: string): boolean {
  if (!path || path.includes('..')) {
    return false;
  }

  return true;
}

export function validateClassName(name: string): boolean {
  if (!name) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function isGodot44OrLater(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (match) {
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    return major > 4 || (major === 4 && minor >= 4);
  }
  return false;
}

export function normalizeParameters(
  params: OperationParams,
  parameterMappings: Record<string, string>
): OperationParams {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      let normalizedKey = key;

      if (key.includes('_') && parameterMappings[key]) {
        normalizedKey = parameterMappings[key];
      }

      if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
        result[normalizedKey] = normalizeParameters(params[key] as OperationParams, parameterMappings);
      } else {
        result[normalizedKey] = params[key];
      }
    }
  }

  return result;
}

export function convertCamelToSnakeCase(
  params: OperationParams,
  reverseParameterMappings: Record<string, string>
): OperationParams {
  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const snakeKey =
        reverseParameterMappings[key] || key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

      if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
        result[snakeKey] = convertCamelToSnakeCase(params[key] as OperationParams, reverseParameterMappings);
      } else {
        result[snakeKey] = params[key];
      }
    }
  }

  return result;
}
