#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize } from 'path';
import { existsSync, readdirSync, mkdirSync, readFileSync, cpSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { handleCaptureScreenshot, handleCaptureSceneScreenshot } from './tools/capture.js';
import { extractGodotErrorDetails, getGodotErrorSolutions } from './utils/godot-errors.js';
import {
  getEnvGodotPath,
  getFallbackGodotPath,
  getGodotPathCandidates,
} from './utils/godot-paths.js';
import { waitForLogReadySignal } from './utils/log-ready.js';
import { LiveBridgeHost } from './utils/live-bridge.js';
import { createErrorResponse as buildErrorResponse } from './utils/mcp-response.js';
import { RingBuffer } from './utils/ring-buffer.js';
import {
  type OperationParams,
  PARAMETER_MAPPINGS,
  buildReverseParameterMappings,
  convertCamelToSnakeCase,
  isGodot44OrLater,
  normalizeParameters,
  validateClassName,
  validatePath,
} from './utils/server-utils.js';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE: boolean = true; // Always use GODOT DEBUG MODE
const LOG_BUFFER_LIMIT = 2000;
const PROCESS_OUTPUT_LIMIT = 1000;
const LIVE_BRIDGE_ADDON_DIR = 'addons/godot_mcp_bridge';
const LIVE_BRIDGE_PLUGIN_CFG = 'res://addons/godot_mcp_bridge/plugin.cfg';
const LIVE_BRIDGE_AUTOLOAD_NAME = 'GodotMcpBridge';
const LIVE_BRIDGE_AUTOLOAD_PATH = 'res://addons/godot_mcp_bridge/bridge_runtime.gd';

const execFileAsync = promisify(execFile);

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Interface representing a running Godot process
 */
interface GodotProcess {
  process: any;
  output: RingBuffer<string>;
  errors: RingBuffer<string>;
  launchArgs: Record<string, unknown>;
  liveBridge: LiveBridgeHost | null;
}

/**
 * Interface for server configuration
 */
interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean; // New option to control path validation behavior
}

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  private server: Server;
  private activeProcess: GodotProcess | null = null;
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths: Map<string, boolean> = new Map();
  private strictPathValidation: boolean = false;
  // In-memory log buffer for editor console output (shared across launch/run)
  private editorLogLines = new RingBuffer<string>(LOG_BUFFER_LIMIT);
  // Track the editor process spawned by launch_editor so quit_godot can close it
  private editorProcess: any = null;

  /**
   * Parameter name mappings between snake_case and camelCase
   * This allows the server to accept both formats
   */
  private parameterMappings: Record<string, string> = PARAMETER_MAPPINGS;

  /**
   * Reverse mapping from camelCase to snake_case
   * Generated from parameterMappings for quick lookups
   */
  private reverseParameterMappings: Record<string, string> = {};

  constructor(config?: GodotServerConfig) {
    // Initialize reverse parameter mappings
    this.reverseParameterMappings = buildReverseParameterMappings(this.parameterMappings);
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let godotDebugMode = GODOT_DEBUG_MODE;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.server = new Server(
      {
        name: 'godot-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);

    // Cleanup on exit
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  private createErrorResponse(message: string, possibleSolutions: string[] = []): any {
    // Log the error
    console.error(`[SERVER] Error response: ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    return buildErrorResponse(message, possibleSolutions);
  }

  private appendLogLine(buffer: RingBuffer<string>, source: string, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    buffer.push(`[${source}] ${trimmed}`);
  }

  private attachProcessStream(
    stream: NodeJS.ReadableStream | null | undefined,
    source: 'stdout' | 'stderr',
    buffer: RingBuffer<string>
  ): void {
    if (!stream) return;

    let partialLine = '';
    stream.on('data', (chunk: Buffer | string) => {
      partialLine += chunk.toString();
      while (true) {
        const newlineIndex = partialLine.indexOf('\n');
        if (newlineIndex === -1) break;
        const line = partialLine.substring(0, newlineIndex);
        this.appendLogLine(buffer, source, line);
        partialLine = partialLine.substring(newlineIndex + 1);
      }
    });

    stream.on('end', () => {
      if (partialLine.trim()) {
        this.appendLogLine(buffer, source, partialLine);
      }
    });
  }

  private buildOperationErrorResponse(
    actionLabel: string,
    stdout: string,
    stderr: string,
    fallbackSolutions: string[]
  ): object | null {
    const details = extractGodotErrorDetails(stdout, stderr);
    if (!details) {
      return null;
    }

    const solutions = [...details.lines.slice(1, 3), ...getGodotErrorSolutions(details.kind)];
    return this.createErrorResponse(
      `${actionLabel} failed (${details.kind}): ${details.summary}`,
      solutions.length > 0 ? solutions : fallbackSolutions
    );
  }

  private extractJsonResult<T>(stdout: string): T | null {
    const marker = '__MCP_RESULT__:';
    const line = stdout
      .split(/\r?\n/)
      .find((entry) => entry.startsWith(marker));

    if (!line) {
      return null;
    }

    try {
      return JSON.parse(line.slice(marker.length)) as T;
    } catch {
      return null;
    }
  }

  private async resolveGodotPathForArgs(
    args: Record<string, unknown> | undefined
  ): Promise<{ ok: true; godotPath: string } | { ok: false; response: object }> {
    const override = typeof args?.godotPath === 'string' ? args.godotPath.trim() : '';
    if (override) {
      const normalizedOverride = normalize(override);
      if (await this.isValidGodotPath(normalizedOverride)) {
        return { ok: true, godotPath: normalizedOverride };
      }

      return {
        ok: false,
        response: this.createErrorResponse(
          `Invalid godotPath override: ${override}`,
          [
            'Pass a full path to a launchable Godot executable',
            'Remove the override to fall back to auto-detection or GODOT_PATH',
          ]
        ),
      };
    }

    if (!this.godotPath) {
      await this.detectGodotPath();
    }

    if (!this.godotPath) {
      return {
        ok: false,
        response: this.createErrorResponse(
          'Could not find a valid Godot executable path',
          [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable',
          ]
        ),
      };
    }

    return { ok: true, godotPath: this.godotPath };
  }

  private readProjectConfig(projectPath: string): string {
    return readFileSync(join(projectPath, 'project.godot'), 'utf8');
  }

  private extractMainSceneFromConfig(projectConfig: string): string | null {
    const match = projectConfig.match(/run\/main_scene="([^"]+)"/);
    return match?.[1] ?? null;
  }

  private extractProjectNameFromConfig(projectConfig: string): string | null {
    const match = projectConfig.match(/config\/name="([^"]+)"/);
    return match?.[1] ?? null;
  }

  private makeGodotTempLogPath(): string {
    return join(tmpdir(), `godot-mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  }

  private getLiveBridgeSourceDir(): string {
    return join(__dirname, 'addon', 'godot_mcp_bridge');
  }

  private getLiveBridgeProjectDir(projectPath: string): string {
    return join(projectPath, LIVE_BRIDGE_ADDON_DIR);
  }

  private hasLiveBridgeInstalled(projectPath: string): boolean {
    return existsSync(join(this.getLiveBridgeProjectDir(projectPath), 'plugin.cfg'));
  }

  private hasLiveBridgePluginEnabled(projectConfig: string): boolean {
    return projectConfig.includes(LIVE_BRIDGE_PLUGIN_CFG);
  }

  private hasLiveBridgeAutoloadEnabled(projectConfig: string): boolean {
    return projectConfig.includes(`${LIVE_BRIDGE_AUTOLOAD_NAME}="*${LIVE_BRIDGE_AUTOLOAD_PATH}"`);
  }

  private upsertProjectSetting(
    projectConfig: string,
    section: string,
    key: string,
    value: string | null
  ): string {
    const lines = projectConfig.split(/\r?\n/);
    const sectionHeader = `[${section}]`;
    let sectionIndex = lines.findIndex((line) => line.trim() === sectionHeader);

    if (sectionIndex === -1) {
      if (value === null) {
        return projectConfig.endsWith('\n') ? projectConfig : `${projectConfig}\n`;
      }
      const suffix = projectConfig.endsWith('\n') || projectConfig.length === 0 ? '' : '\n';
      return `${projectConfig}${suffix}${sectionHeader}\n${key}=${value}\n`;
    }

    let nextSectionIndex = lines.length;
    for (let index = sectionIndex + 1; index < lines.length; index += 1) {
      if (lines[index].startsWith('[') && lines[index].endsWith(']')) {
        nextSectionIndex = index;
        break;
      }
    }

    const existingIndex = lines.findIndex(
      (line, index) => index > sectionIndex && index < nextSectionIndex && line.startsWith(`${key}=`)
    );

    if (value === null) {
      if (existingIndex !== -1) {
        lines.splice(existingIndex, 1);
      }
      return `${lines.join('\n')}\n`;
    }

    const newLine = `${key}=${value}`;
    if (existingIndex !== -1) {
      lines[existingIndex] = newLine;
    } else {
      lines.splice(nextSectionIndex, 0, newLine);
    }

    return `${lines.join('\n')}\n`;
  }

  private readPackedStringArraySetting(projectConfig: string, section: string, key: string): string[] {
    const pattern = new RegExp(`\\[${section}\\][\\s\\S]*?^${key}=PackedStringArray\\(([^\\n]*)\\)`, 'm');
    const match = projectConfig.match(pattern);
    if (!match?.[1]) {
      return [];
    }

    return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  }

  private writePackedStringArraySetting(
    projectConfig: string,
    section: string,
    key: string,
    values: string[]
  ): string {
    const serializedValues = values.map((value) => `"${value}"`).join(', ');
    return this.upsertProjectSetting(
      projectConfig,
      section,
      key,
      `PackedStringArray(${serializedValues})`
    );
  }

  private writeProjectConfig(projectPath: string, projectConfig: string): void {
    writeFileSync(join(projectPath, 'project.godot'), projectConfig, 'utf8');
  }

  private getLiveBridgeStatusSnapshot(projectPath: string): {
    installed: boolean;
    pluginEnabled: boolean;
    autoloadEnabled: boolean;
    status: 'not_installed' | 'installed_disabled' | 'enabled_no_runtime_session' | 'connected_ready';
  } {
    const installed = this.hasLiveBridgeInstalled(projectPath);
    if (!installed) {
      return {
        installed,
        pluginEnabled: false,
        autoloadEnabled: false,
        status: 'not_installed',
      };
    }

    const projectConfig = this.readProjectConfig(projectPath);
    const pluginEnabled = this.hasLiveBridgePluginEnabled(projectConfig);
    const autoloadEnabled = this.hasLiveBridgeAutoloadEnabled(projectConfig);

    if (!pluginEnabled || !autoloadEnabled) {
      return {
        installed,
        pluginEnabled,
        autoloadEnabled,
        status: 'installed_disabled',
      };
    }

    const activeProjectPath = this.activeProcess?.launchArgs.projectPath;
    if (
      activeProjectPath === projectPath &&
      this.activeProcess?.liveBridge &&
      this.activeProcess.liveBridge.status.connected
    ) {
      return {
        installed,
        pluginEnabled,
        autoloadEnabled,
        status: 'connected_ready',
      };
    }

    return {
      installed,
      pluginEnabled,
      autoloadEnabled,
      status: 'enabled_no_runtime_session',
    };
  }

  private listScenePaths(projectPath: string): string[] {
    const scenes: string[] = [];

    const scanDirectory = (currentPath: string) => {
      const entries = readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }

        const entryPath = join(currentPath, entry.name);
        if (entry.isDirectory()) {
          scanDirectory(entryPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.tscn')) {
          const relativePath = normalize(entryPath.slice(projectPath.length + 1)).replace(/\\/g, '/');
          scenes.push(`res://${relativePath}`);
        }
      }
    };

    scanDirectory(projectPath);
    scenes.sort();
    return scenes;
  }

  private async waitForLiveBridgeConnection(liveBridge: LiveBridgeHost, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (liveBridge.status.connected) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return liveBridge.status.connected;
  }

  private async withLiveBridgeRequest<T>(
    projectPath: string,
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = 3000
  ): Promise<{ ok: true; payload: T } | { ok: false; response: object }> {
    const liveStatus = this.getLiveBridgeStatusSnapshot(projectPath);
    if (liveStatus.status === 'not_installed') {
      return {
        ok: false,
        response: this.createErrorResponse(
          'Live bridge addon is not installed for this project.',
          ['Use install_live_bridge first']
        ),
      };
    }

    if (liveStatus.status === 'installed_disabled') {
      return {
        ok: false,
        response: this.createErrorResponse(
          'Live bridge addon is installed but not enabled for this project.',
          ['Use enable_live_bridge to enable the addon and autoload entry']
        ),
      };
    }

    if (!this.activeProcess || this.activeProcess.launchArgs.projectPath !== projectPath) {
      return {
        ok: false,
        response: this.createErrorResponse(
          'The project is not currently running under MCP control.',
          ['Use run_project or run_scene after enabling the live bridge addon']
        ),
      };
    }

    const liveBridge = this.activeProcess.liveBridge;
    if (!liveBridge) {
      return {
        ok: false,
        response: this.createErrorResponse(
          'Live bridge session is not active for the running project.',
          ['Restart the project after enabling the live bridge addon']
        ),
      };
    }

    const connected = await this.waitForLiveBridgeConnection(liveBridge, timeoutMs);
    if (!connected) {
      return {
        ok: false,
        response: this.createErrorResponse(
          'Live bridge runtime did not connect in time.',
          ['Ensure the addon autoload is enabled and the project started normally']
        ),
      };
    }

    try {
      const payload = await liveBridge.request<T>(command, params, timeoutMs);
      return { ok: true, payload };
    } catch (error: any) {
      return {
        ok: false,
        response: this.createErrorResponse(
          `Live bridge request failed: ${error?.message || 'Unknown error'}`,
          ['Try rerunning the project or reloading the live bridge addon']
        ),
      };
    }
  }

  /**
   * Validate a path to prevent path traversal attacks
   */
  private validatePath(path: string): boolean {
    return validatePath(path);
  }

  /**
   * Validate a Godot class name to prevent arbitrary script instantiation.
   * Class names must be simple identifiers (e.g. "Node2D", "CharacterBody3D").
   * Rejects anything that looks like a path (res://, absolute paths, dots, slashes, colons).
   */
  private validateClassName(name: string): boolean {
    return validateClassName(name);
  }

  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    // Check cache first
    if (this.validatedPaths.has(path)) {
      return this.validatedPaths.get(path)!;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      // Try to execute Godot with --version flag
      // Using execFileAsync with argument array to prevent command injection
      await execFileAsync(path, ['--version']);

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    const envGodotPath = getEnvGodotPath();
    if (envGodotPath) {
      const normalizedPath = normalize(envGodotPath);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    const possiblePaths = getGodotPathCandidates(osPlatform);

    // Try each possible path
    for (const path of possiblePaths) {
      if (await this.isValidGodotPath(path)) {
        this.godotPath = path;
        this.logDebug(`Found Godot at: ${path}`);
        return;
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      this.godotPath = getFallbackGodotPath(osPlatform);

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    if (this.activeProcess) {
      this.logDebug('Killing active Godot process');
      this.activeProcess.process.kill();
      if (this.activeProcess.liveBridge) {
        await this.activeProcess.liveBridge.close();
      }
      this.activeProcess = null;
    }
    if (this.editorProcess) {
      this.logDebug('Killing tracked editor process');
      try {
        this.editorProcess.kill();
      } catch (_) {}
      this.editorProcess = null;
    }
    await this.server.close();
  }

  /**
   * Check if the Godot version is 4.4 or later
   * @param version The Godot version string
   * @returns True if the version is 4.4 or later
   */
  private isGodot44OrLater(version: string): boolean {
    return isGodot44OrLater(version);
  }

  /**
   * Normalize parameters to camelCase format
   * @param params Object with either snake_case or camelCase keys
   * @returns Object with all keys in camelCase format
   */
  private normalizeParameters(params: OperationParams): OperationParams {
    return normalizeParameters(params, this.parameterMappings);
  }

  /**
   * Convert camelCase keys to snake_case
   * @param params Object with camelCase keys
   * @returns Object with snake_case keys
   */
  private convertCamelToSnakeCase(params: OperationParams): OperationParams {
    return convertCamelToSnakeCase(params, this.reverseParameterMappings);
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string,
    godotPathOverride?: string
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);


    // Ensure godotPath is set
    if (!this.godotPath && !godotPathOverride) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    const godotPath = godotPathOverride ?? this.godotPath!;

    try {
      // Serialize the snake_case parameters to a valid JSON string
      const paramsJson = JSON.stringify(snakeCaseParams);

      // Build argument array for execFile to prevent command injection
      // Using execFile with argument arrays avoids shell interpretation entirely
      const args = [
        '--log-file',
        this.makeGodotTempLogPath(),
        '--headless',
        '--path',
        projectPath,  // Safe: passed as argument, not interpolated into shell command
        '--script',
        this.operationsScriptPath,
        operation,
        paramsJson,  // Safe: passed as argument, not interpreted by shell
      ];

      
      if (GODOT_DEBUG_MODE) {
        args.push('--debug-godot');
      }

      this.logDebug(`Executing: ${godotPath} ${args.join(' ')}`);

      const { stdout, stderr } = await execFileAsync(godotPath, args);

      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (error: unknown) {
      // If execFileAsync throws, it still contains stdout/stderr
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return {
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? '',
        };
      }

      throw error;
    }
  }

  /**
   * Get the structure of a Godot project
   * @param projectPath Path to the Godot project
   * @returns Object representing the project structure
   */
  private async getProjectStructure(projectPath: string): Promise<any> {
    try {
      // Get top-level directories in the project
      const entries = readdirSync(projectPath, { withFileTypes: true });

      const structure: any = {
        scenes: [],
        scripts: [],
        assets: [],
        other: [],
      };

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();

          // Skip hidden directories
          if (dirName.startsWith('.')) {
            continue;
          }

          // Count files in common directories
          if (dirName === 'scenes' || dirName.includes('scene')) {
            structure.scenes.push(entry.name);
          } else if (dirName === 'scripts' || dirName.includes('script')) {
            structure.scripts.push(entry.name);
          } else if (
            dirName === 'assets' ||
            dirName === 'textures' ||
            dirName === 'models' ||
            dirName === 'sounds' ||
            dirName === 'music'
          ) {
            structure.assets.push(entry.name);
          } else {
            structure.other.push(entry.name);
          }
        }
      }

      return structure;
    } catch (error) {
      this.logDebug(`Error getting project structure: ${error}`);
      return { error: 'Failed to get project structure' };
    }
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
    const projects: Array<{ path: string; name: string }> = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'launch_editor',
          description: 'Launch Godot editor for a specific project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              godotPath: {
                type: 'string',
                description: 'Optional per-call override for the Godot executable path.',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_project',
          description: 'Run the Godot project and capture output',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scene: {
                type: 'string',
                description: 'Optional: Specific scene to run',
              },
              godotPath: {
                type: 'string',
                description: 'Optional per-call override for the Godot executable path.',
              },
              waitForLog: {
                type: 'string',
                description: 'Optional log substring to wait for before returning success.',
              },
              readyTimeoutMs: {
                type: 'number',
                description: 'Maximum time to wait for waitForLog to appear before returning an error (default 10000).',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_debug_output',
          description: 'Get the current debug output and errors',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'stop_project',
          description: 'Stop the currently running Godot project',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_godot_version',
          description: 'Get the installed Godot version',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'list_projects',
          description: 'List Godot projects in a directory',
          inputSchema: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Directory to search for Godot projects',
              },
              recursive: {
                type: 'boolean',
                description: 'Whether to search recursively (default: false)',
              },
            },
            required: ['directory'],
          },
        },
        {
          name: 'get_main_scene',
          description: 'Get the configured main scene for a Godot project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'list_scenes',
          description: 'List .tscn scenes in a Godot project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_project_info',
          description: 'Retrieve metadata about a Godot project',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'create_scene',
          description: 'Create a new Godot scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path where the scene file will be saved (relative to project)',
              },
              rootNodeType: {
                type: 'string',
                description: 'Type of the root node (e.g., Node2D, Node3D)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'add_node',
          description: 'Add a node to an existing scene',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              parentNodePath: {
                type: 'string',
                description: 'Path to the parent node (e.g., "root" or "root/Player")',
              },
              nodeType: {
                type: 'string',
                description: 'Type of node to add (e.g., Sprite2D, CollisionShape2D)',
              },
              nodeName: {
                type: 'string',
                description: 'Name for the new node',
              },
              properties: {
                type: 'object',
                description: 'Optional properties to set on the node',
              },
            },
            required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
          },
        },
        {
          name: 'load_sprite',
          description: 'Load a sprite into a Sprite2D node',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              nodePath: {
                type: 'string',
                description: 'Path to the Sprite2D node (e.g., "root/Player/Sprite2D")',
              },
              texturePath: {
                type: 'string',
                description: 'Path to the texture file (relative to project)',
              },
            },
            required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
          },
        },
        {
          name: 'export_mesh_library',
          description: 'Export a scene as a MeshLibrary resource',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (.tscn) to export',
              },
              outputPath: {
                type: 'string',
                description: 'Path where the mesh library (.res) will be saved',
              },
              meshItemNames: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Optional: Names of specific mesh items to include (defaults to all)',
              },
            },
            required: ['projectPath', 'scenePath', 'outputPath'],
          },
        },
        {
          name: 'save_scene',
          description: 'Save changes to a scene file',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Path to the scene file (relative to project)',
              },
              newPath: {
                type: 'string',
                description: 'Optional: New path to save the scene to (for creating variants)',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'get_uid',
          description: 'Get the UID for a specific file in a Godot project (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              filePath: {
                type: 'string',
                description: 'Path to the file (relative to project) for which to get the UID',
              },
            },
            required: ['projectPath', 'filePath'],
          },
        },
        {
          name: 'update_project_uids',
          description: 'Update UID references in a Godot project by resaving resources (for Godot 4.4+)',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'install_live_bridge',
          description: 'Install the optional live inspection addon into a Godot project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'enable_live_bridge',
          description: 'Enable the live inspection addon and runtime autoload for a Godot project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'disable_live_bridge',
          description: 'Disable the live inspection addon and runtime autoload for a Godot project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'uninstall_live_bridge',
          description: 'Remove the optional live inspection addon from a Godot project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_live_bridge_status',
          description: 'Get install/enable/runtime status for the optional live inspection addon.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'check_scripts',
          description: 'Load GDScript files headlessly to catch parse and static typing errors.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scriptPath: {
                type: 'string',
                description: 'Optional res:// path to a specific script file to validate.',
              },
              includeScenes: {
                type: 'boolean',
                description: 'Also load .tscn scenes to catch script attachment and scene load errors.',
              },
              godotPath: {
                type: 'string',
                description: 'Optional per-call override for the Godot executable path.',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_scene_tree',
          description: 'Inspect the node tree of a scene file without running the full project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'Optional res:// path to the scene file. Defaults to the project main scene.',
              },
              rootNodePath: {
                type: 'string',
                description: 'Optional node path inside the instantiated scene to inspect as a subtree.',
              },
              includeOwner: {
                type: 'boolean',
                description: 'Include owner paths in each returned node when available.',
              },
              godotPath: {
                type: 'string',
                description: 'Optional per-call override for the Godot executable path.',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_live_main_scene',
          description: 'Get the current live main scene from the addon-enabled running project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_live_scene_tree',
          description: 'Inspect the live node hierarchy from an addon-enabled running project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              rootNodePath: {
                type: 'string',
                description: 'Optional node path to inspect as a subtree.',
              },
              includeOwner: {
                type: 'boolean',
                description: 'Include owner paths in returned nodes when available.',
              },
              maxNodes: {
                type: 'number',
                description: 'Maximum node count to include in the returned tree.',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'get_live_node_state',
          description: 'Inspect a specific live node in an addon-enabled running project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              nodePath: {
                type: 'string',
                description: 'Node path to inspect from the current live scene.',
              },
              propertyNames: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional property names to serialize for the target node.',
              },
            },
            required: ['projectPath', 'nodePath'],
          },
        },
        {
          name: 'get_live_property_list',
          description: 'List accessible live properties for a node in an addon-enabled running project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              nodePath: {
                type: 'string',
                description: 'Node path to inspect from the current live scene.',
              },
              propertyNames: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional property names to filter the returned property list.',
              },
              includeValues: {
                type: 'boolean',
                description: 'Include current serialized values for each returned property.',
              },
              scriptOnly: {
                type: 'boolean',
                description: 'Only include script-defined properties.',
              },
            },
            required: ['projectPath', 'nodePath'],
          },
        },
        {
          name: 'get_live_script_variables',
          description: 'Inspect script-defined live variables for a node in an addon-enabled running project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              nodePath: {
                type: 'string',
                description: 'Node path to inspect from the current live scene.',
              },
              variableNames: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional script variable names to include.',
              },
            },
            required: ['projectPath', 'nodePath'],
          },
        },
        {
          name: 'list_live_groups',
          description: 'List active groups from an addon-enabled running project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              includeMembers: {
                type: 'boolean',
                description: 'Include member node paths for each group.',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'capture_debug_state',
          description: 'Capture a combined live debug snapshot from an addon-enabled running project.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              rootNodePath: {
                type: 'string',
                description: 'Optional node path to inspect as the primary subtree.',
              },
              propertyNames: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional property names to serialize for the selected node.',
              },
              includeOwner: {
                type: 'boolean',
                description: 'Include owner paths in returned nodes when available.',
              },
              maxNodes: {
                type: 'number',
                description: 'Maximum node count to include in the returned tree.',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'run_scene',
          description: 'Run a specific Godot scene in debug mode and capture output.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the Godot project directory',
              },
              scenePath: {
                type: 'string',
                description: 'res:// path to the scene file to run.',
              },
              godotPath: {
                type: 'string',
                description: 'Optional per-call override for the Godot executable path.',
              },
              waitForLog: {
                type: 'string',
                description: 'Optional log substring to wait for before returning success.',
              },
              readyTimeoutMs: {
                type: 'number',
                description: 'Maximum time to wait for waitForLog to appear before returning an error (default 10000).',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
        {
          name: 'reload_project',
          description: 'Restart the currently tracked Godot project using the last run configuration.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_editor_log',
          description: 'Get recent console output from the Godot editor process launched by this MCP server.',
          inputSchema: {
            type: 'object',
            properties: {
              lineCount: {
                type: 'number',
                description: 'Number of trailing lines to return (default 50, max 1000)',
              },
            },
          },
        },
        {
          name: 'view_log',
          description: 'View recent console output from the last launched editor or running project. Returns the last N lines of captured stdout/stderr.',
          inputSchema: {
            type: 'object',
            properties: {
              lineCount: {
                type: 'number',
                description: 'Number of trailing lines to return (default 50, max 1000)',
              },
            },
          },
        },
        {
          name: 'quit_godot',
          description: 'Close the Godot editor that was launched by this MCP server via launch_editor. Only closes editors spawned by this server.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'capture_screenshot',
          description:
            'Run a Godot scene and capture a screenshot of the rendered output. Returns the image so the agent can visually verify the scene. Requires a real display (not --headless). On headless Linux, wrap Godot with xvfb-run.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the directory containing project.godot',
              },
              scenePath: {
                type: 'string',
                description:
                  'Optional res:// path to a .tscn file to run. Defaults to the project main scene.',
              },
              waitFrames: {
                type: 'number',
                description:
                  'Number of frames to render before capture (default 10). Lets shaders, physics, and layout settle.',
              },
              timeoutMs: {
                type: 'number',
                description:
                  'Hard timeout in milliseconds (default 15000). Godot is killed if the capture takes longer.',
              },
              crop: {
                type: 'object',
                description: 'Optional crop rectangle applied after capture.',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                },
              },
              scale: {
                type: 'number',
                description: 'Optional image scale factor applied after capture, such as 0.5 or 2.',
              },
              hideDebugOverlay: {
                type: 'boolean',
                description: 'Temporarily hides Control-based UI before capture to reduce HUD/debug overlay noise.',
              },
              keepTempFile: {
                type: 'boolean',
                description: 'Keep the captured PNG on disk and include its temporary path in the response text.',
              },
              godotPath: {
                type: 'string',
                description: 'Optional per-call override for the Godot executable path.',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'capture_scene_screenshot',
          description:
            'Load a specific .tscn scene file and capture one rendered frame without running the full project. Returns the image for visual inspection. Requires a real display (not --headless).',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the directory containing project.godot',
              },
              scenePath: {
                type: 'string',
                description: 'res:// path to the .tscn file to load and capture.',
              },
              timeoutMs: {
                type: 'number',
                description: 'Hard timeout in milliseconds (default 15000).',
              },
              crop: {
                type: 'object',
                description: 'Optional crop rectangle applied after capture.',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                },
              },
              scale: {
                type: 'number',
                description: 'Optional image scale factor applied after capture, such as 0.5 or 2.',
              },
              hideDebugOverlay: {
                type: 'boolean',
                description: 'Temporarily hides Control-based UI before capture to reduce HUD/debug overlay noise.',
              },
              keepTempFile: {
                type: 'boolean',
                description: 'Keep the captured PNG on disk and include its temporary path in the response text.',
              },
              godotPath: {
                type: 'string',
                description: 'Optional per-call override for the Godot executable path.',
              },
            },
            required: ['projectPath', 'scenePath'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      switch (request.params.name) {
        case 'launch_editor':
          return await this.handleLaunchEditor(request.params.arguments);
        case 'run_project':
          return await this.handleRunProject(request.params.arguments);
        case 'get_debug_output':
          return await this.handleGetDebugOutput();
        case 'stop_project':
          return await this.handleStopProject();
        case 'get_godot_version':
          return await this.handleGetGodotVersion();
        case 'list_projects':
          return await this.handleListProjects(request.params.arguments);
        case 'get_main_scene':
          return await this.handleGetMainScene(request.params.arguments);
        case 'list_scenes':
          return await this.handleListScenes(request.params.arguments);
        case 'get_project_info':
          return await this.handleGetProjectInfo(request.params.arguments);
        case 'create_scene':
          return await this.handleCreateScene(request.params.arguments);
        case 'add_node':
          return await this.handleAddNode(request.params.arguments);
        case 'load_sprite':
          return await this.handleLoadSprite(request.params.arguments);
        case 'export_mesh_library':
          return await this.handleExportMeshLibrary(request.params.arguments);
        case 'save_scene':
          return await this.handleSaveScene(request.params.arguments);
        case 'get_uid':
          return await this.handleGetUid(request.params.arguments);
        case 'update_project_uids':
          return await this.handleUpdateProjectUids(request.params.arguments);
        case 'install_live_bridge':
          return await this.handleInstallLiveBridge(request.params.arguments);
        case 'enable_live_bridge':
          return await this.handleEnableLiveBridge(request.params.arguments);
        case 'disable_live_bridge':
          return await this.handleDisableLiveBridge(request.params.arguments);
        case 'uninstall_live_bridge':
          return await this.handleUninstallLiveBridge(request.params.arguments);
        case 'get_live_bridge_status':
          return await this.handleGetLiveBridgeStatus(request.params.arguments);
        case 'check_scripts':
          return await this.handleCheckScripts(request.params.arguments);
        case 'get_scene_tree':
          return await this.handleGetSceneTree(request.params.arguments);
        case 'get_live_main_scene':
          return await this.handleGetLiveMainScene(request.params.arguments);
        case 'get_live_scene_tree':
          return await this.handleGetLiveSceneTree(request.params.arguments);
        case 'get_live_node_state':
          return await this.handleGetLiveNodeState(request.params.arguments);
        case 'get_live_property_list':
          return await this.handleGetLivePropertyList(request.params.arguments);
        case 'get_live_script_variables':
          return await this.handleGetLiveScriptVariables(request.params.arguments);
        case 'list_live_groups':
          return await this.handleListLiveGroups(request.params.arguments);
        case 'capture_debug_state':
          return await this.handleCaptureDebugState(request.params.arguments);
        case 'run_scene':
          return await this.handleRunScene(request.params.arguments);
        case 'reload_project':
          return await this.handleReloadProject();
        case 'get_editor_log':
          return await this.handleGetEditorLog(request.params.arguments);
        case 'view_log':
          return await this.handleViewLog(request.params.arguments);
        case 'quit_godot':
          return await this.handleQuitGodot();
        case 'capture_screenshot': {
          const args = this.normalizeParameters(request.params.arguments as Record<string, unknown>);
          const resolved = await this.resolveGodotPathForArgs(args);
          if (!resolved.ok) {
            return resolved.response;
          }
          return await handleCaptureScreenshot(
            args,
            { godotPath: resolved.godotPath, operationsScriptPath: this.operationsScriptPath }
          );
        }
        case 'capture_scene_screenshot': {
          const args = this.normalizeParameters(request.params.arguments as Record<string, unknown>);
          const resolved = await this.resolveGodotPathForArgs(args);
          if (!resolved.ok) {
            return resolved.response;
          }
          return await handleCaptureSceneScreenshot(
            args,
            { godotPath: resolved.godotPath, operationsScriptPath: this.operationsScriptPath }
          );
        }
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const resolved = await this.resolveGodotPathForArgs(args);
      if (!resolved.ok) {
        return resolved.response;
      }
      const godotPath = resolved.godotPath;

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);

      // Clear the log buffer on each new launch
      this.editorLogLines.clear();

      const process = spawn(godotPath, ['--log-file', this.makeGodotTempLogPath(), '-e', '--path', args.projectPath], {
        stdio: 'pipe',
      });

      this.attachProcessStream(process.stdout, 'stdout', this.editorLogLines);

      // Pipe stderr into the shared log buffer (line by line) — Godot writes errors here
      this.attachProcessStream(process.stderr, 'stderr', this.editorLogLines);

      // Track the spawned editor so quit_godot can close it later
      this.editorProcess = process;

      process.on('exit', () => {
        if (this.editorProcess === process) {
          this.logDebug('Godot editor exited naturally');
          this.editorProcess = null;
        }
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot editor:', err);
        this.appendLogLine(this.editorLogLines, 'spawn error', err.message);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched for project at ${args.projectPath} using ${godotPath}. Use get_editor_log to check the console output.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to launch Godot editor: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const resolved = await this.resolveGodotPathForArgs(args);
      if (!resolved.ok) {
        return resolved.response;
      }
      const godotPath = resolved.godotPath;

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Kill any existing process
      if (this.activeProcess) {
        this.logDebug('Killing existing Godot process before starting a new one');
        this.activeProcess.process.kill();
        if (this.activeProcess.liveBridge) {
          await this.activeProcess.liveBridge.close();
        }
      }

      const cmdArgs = ['--log-file', this.makeGodotTempLogPath(), '-d', '--path', args.projectPath];
      if (args.scene && this.validatePath(args.scene)) {
        this.logDebug(`Adding scene parameter: ${args.scene}`);
        cmdArgs.push(args.scene);
      }

      const liveBridgeStatus = this.getLiveBridgeStatusSnapshot(args.projectPath);
      let liveBridge: LiveBridgeHost | null = null;
      let spawnEnv: NodeJS.ProcessEnv = process.env;
      if (liveBridgeStatus.status !== 'not_installed' && liveBridgeStatus.status !== 'installed_disabled') {
        liveBridge = new LiveBridgeHost();
        await liveBridge.start();
        spawnEnv = {
          ...process.env,
          GODOT_MCP_LIVE_HOST: liveBridge.host,
          GODOT_MCP_LIVE_PORT: String(liveBridge.port),
          GODOT_MCP_LIVE_TOKEN: liveBridge.token,
        };
      }

      this.logDebug(`Running Godot project: ${args.projectPath}`);
      const childProcess = spawn(godotPath, cmdArgs, { stdio: 'pipe', env: spawnEnv });
      const output = new RingBuffer<string>(PROCESS_OUTPUT_LIMIT);
      const errors = new RingBuffer<string>(PROCESS_OUTPUT_LIMIT);
      this.attachProcessStream(childProcess.stdout, 'stdout', output);
      this.attachProcessStream(childProcess.stderr, 'stderr', errors);

      childProcess.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code}`);
        if (this.activeProcess && this.activeProcess.process === childProcess) {
          if (this.activeProcess.liveBridge) {
            void this.activeProcess.liveBridge.close();
          }
          this.activeProcess = null;
        }
      });

      childProcess.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        this.appendLogLine(errors, 'spawn error', err.message);
        if (this.activeProcess && this.activeProcess.process === childProcess) {
          if (this.activeProcess.liveBridge) {
            void this.activeProcess.liveBridge.close();
          }
          this.activeProcess = null;
        }
      });

      this.activeProcess = {
        process: childProcess,
        output,
        errors,
        launchArgs: {
          projectPath: args.projectPath,
          scene: args.scene,
          godotPath: args.godotPath ?? godotPath,
          waitForLog: args.waitForLog,
          readyTimeoutMs: args.readyTimeoutMs,
        },
        liveBridge,
      };

      if (typeof args.waitForLog === 'string' && args.waitForLog.trim()) {
        const readyTimeoutMs =
          typeof args.readyTimeoutMs === 'number' && Number.isFinite(args.readyTimeoutMs)
            ? Math.max(1, Math.floor(args.readyTimeoutMs))
            : 10000;

        const waitResult = await waitForLogReadySignal(
          childProcess,
          output,
          errors,
          args.waitForLog,
          readyTimeoutMs
        );

        if (!waitResult.ok) {
          if (waitResult.reason === 'exit') {
            return this.createErrorResponse(
              `Godot project exited before the ready signal "${args.waitForLog}" appeared.`,
              [
                'Use get_debug_output or view_log to inspect startup errors',
                'Verify the requested scene and project resources load correctly',
              ]
            );
          }

          return this.createErrorResponse(
            `Godot project did not emit the ready signal "${args.waitForLog}" within ${readyTimeoutMs}ms.`,
            [
              'Increase readyTimeoutMs if the project loads slowly',
              'Use get_debug_output or view_log to inspect startup progress while the process continues running',
            ]
          );
        }

        return {
          content: [
            {
              type: 'text',
              text: `Godot project started and reported ready via log match "${args.waitForLog}" on line: ${waitResult.matchedLine}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode using ${godotPath}. Use get_debug_output to see output.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to run Godot project: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process.',
        [
          'Use run_project to start a Godot project first',
          'Check if the Godot process crashed unexpectedly',
        ]
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              output: this.activeProcess.output.toArray(),
              errors: this.activeProcess.errors.toArray(),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private async handleStopProject() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot process to stop.',
        [
          'Use run_project to start a Godot project first',
          'The process may have already terminated',
        ]
      );
    }

    this.logDebug('Stopping active Godot process');
    this.activeProcess.process.kill();
    const output = this.activeProcess.output.toArray();
    const errors = this.activeProcess.errors.toArray();
    if (this.activeProcess.liveBridge) {
      await this.activeProcess.liveBridge.close();
    }
    this.activeProcess = null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Godot project stopped',
              finalOutput: output,
              finalErrors: errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = await execFileAsync(this.godotPath!, ['--version']);
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to get Godot version: ${errorMessage}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
        ]
      );
    }
  }

  /**
   * Handle the list_projects tool
   */
  private async handleListProjects(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.directory) {
      return this.createErrorResponse(
        'Directory is required',
        ['Provide a valid directory path to search for Godot projects']
      );
    }

    if (!this.validatePath(args.directory)) {
      return this.createErrorResponse(
        'Invalid directory path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return this.createErrorResponse(
          `Directory does not exist: ${args.directory}`,
          ['Provide a valid directory path that exists on the system']
        );
      }

      const recursive = args.recursive === true;
      const projects = this.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`,
        [
          'Ensure the directory exists and is accessible',
          'Check if you have permission to read the directory',
        ]
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            
            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            
            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();
              
              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };
        
        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({ 
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }
  
    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }
  
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }
  
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }
  
      this.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const execOptions = { timeout: 10000 }; // 10 second timeout
      const { stdout } = await execFileAsync(this.godotPath!, ['--version'], execOptions);
  
      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(args.projectPath);
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const extractedName = this.extractProjectNameFromConfig(this.readProjectConfig(args.projectPath));
        if (extractedName) {
          projectName = extractedName;
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Project path and scene path are required',
        ['Provide valid paths for both the project and the scene']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    const rootNodeType = args.rootNodeType || 'Node2D';
    if (!this.validateClassName(rootNodeType)) {
      return this.createErrorResponse(
        'Invalid rootNodeType',
        ['rootNodeType must be a built-in Godot class name (no paths, no file extensions)']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

      const createSceneError = this.buildOperationErrorResponse('Create scene', stdout, stderr, [
        'Check if the root node type is valid',
        'Ensure you have write permissions to the scene path',
        'Verify the scene path is valid',
      ]);
      if (createSceneError) {
        return createSceneError;
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodeType, and nodeName']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    if (!this.validateClassName(args.nodeType)) {
      return this.createErrorResponse(
        'Invalid nodeType',
        ['nodeType must be a built-in Godot class name (no paths, no file extensions)']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      const addNodeError = this.buildOperationErrorResponse('Add node', stdout, stderr, [
        'Check if the node type is valid',
        'Ensure the parent node path exists',
        'Verify the scene file is valid',
      ]);
      if (addNodeError) {
        return addNodeError;
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, nodePath, and texturePath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.nodePath) ||
      !this.validatePath(args.texturePath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Check if the texture file exists
      const texturePath = join(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return this.createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`,
          [
            'Ensure the texture path is correct',
            'Upload or create the texture file first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

      const loadSpriteError = this.buildOperationErrorResponse('Load sprite', stdout, stderr, [
        'Check if the node path is correct',
        'Ensure the node is a Sprite2D, Sprite3D, or TextureRect',
        'Verify the texture file is a valid image format',
      ]);
      if (loadSpriteError) {
        return loadSpriteError;
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */
  private async handleExportMeshLibrary(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath, scenePath, and outputPath']
      );
    }

    if (
      !this.validatePath(args.projectPath) ||
      !this.validatePath(args.scenePath) ||
      !this.validatePath(args.outputPath)
    ) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

      const exportMeshError = this.buildOperationErrorResponse('Export mesh library', stdout, stderr, [
        'Check if the scene contains valid 3D meshes',
        'Ensure the output path is valid',
        'Verify the scene file is valid',
      ]);
      if (exportMeshError) {
        return exportMeshError;
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and scenePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !this.validatePath(args.newPath)) {
      return this.createErrorResponse(
        'Invalid new path',
        ['Provide a valid new path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return this.createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`,
          [
            'Ensure the scene path is correct',
            'Use create_scene to create a new scene first',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

      const saveSceneError = this.buildOperationErrorResponse('Save scene', stdout, stderr, [
        'Check if the scene file is valid',
        'Ensure you have write permissions to the output path',
        'Verify the scene can be properly packed',
      ]);
      if (saveSceneError) {
        return saveSceneError;
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath || !args.filePath) {
      return this.createErrorResponse(
        'Missing required parameters',
        ['Provide projectPath and filePath']
      );
    }

    if (!this.validatePath(args.projectPath) || !this.validatePath(args.filePath)) {
      return this.createErrorResponse(
        'Invalid path',
        ['Provide valid paths without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Check if the file exists
      const filePath = join(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return this.createErrorResponse(
          `File does not exist: ${args.filePath}`,
          ['Ensure the file path is correct']
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      const getUidError = this.buildOperationErrorResponse('Get UID', stdout, stderr, [
        'Check if the file is a valid Godot resource',
        'Ensure the file path is correct',
      ]);
      if (getUidError) {
        return getUidError;
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  private buildEditorLogResponse(args: any) {
    args = this.normalizeParameters(args);

    let lineCount = 50; // default
    if (args.lineCount !== undefined && typeof args.lineCount === 'number') {
      lineCount = Math.max(1, Math.min(1000, Math.floor(args.lineCount)));
    }

    const lines = this.editorLogLines.tail(lineCount);

    return {
      content: [
        {
          type: 'text',
          text: lines.length > 0 ? lines.join('\n') : '(no output captured yet)',
        },
      ],
    };
  }

  /**
   * Handle the get_editor_log tool
   */
  private async handleGetEditorLog(args: any) {
    return this.buildEditorLogResponse(args);
  }

  /**
   * Handle the view_log tool
   */
  private async handleViewLog(args: any) {
    return this.buildEditorLogResponse(args);
  }

  private async handleInstallLiveBridge(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]
      );
    }

    const sourceDir = this.getLiveBridgeSourceDir();
    if (!existsSync(join(sourceDir, 'plugin.cfg')) || !existsSync(join(sourceDir, 'bridge_runtime.gd'))) {
      return this.createErrorResponse(
        'Live bridge addon assets are missing from the MCP build.',
        ['Run npm run build to copy addon assets into the build output']
      );
    }

    mkdirSync(join(args.projectPath, 'addons'), { recursive: true });
    cpSync(sourceDir, this.getLiveBridgeProjectDir(args.projectPath), {
      recursive: true,
      force: true,
    });

    const status = this.getLiveBridgeStatusSnapshot(args.projectPath);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Live bridge addon installed.',
              ...status,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleEnableLiveBridge(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    if (!this.hasLiveBridgeInstalled(args.projectPath)) {
      return this.createErrorResponse(
        'Live bridge addon is not installed for this project.',
        ['Use install_live_bridge first']
      );
    }

    let projectConfig = this.readProjectConfig(args.projectPath);
    const enabledPlugins = this.readPackedStringArraySetting(projectConfig, 'editor_plugins', 'enabled');
    if (!enabledPlugins.includes(LIVE_BRIDGE_PLUGIN_CFG)) {
      enabledPlugins.push(LIVE_BRIDGE_PLUGIN_CFG);
    }
    projectConfig = this.writePackedStringArraySetting(
      projectConfig,
      'editor_plugins',
      'enabled',
      enabledPlugins
    );
    projectConfig = this.upsertProjectSetting(
      projectConfig,
      'autoload',
      LIVE_BRIDGE_AUTOLOAD_NAME,
      `"*${LIVE_BRIDGE_AUTOLOAD_PATH}"`
    );
    this.writeProjectConfig(args.projectPath, projectConfig);

    const status = this.getLiveBridgeStatusSnapshot(args.projectPath);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Live bridge addon enabled.',
              ...status,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleDisableLiveBridge(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]
      );
    }

    let projectConfig = this.readProjectConfig(args.projectPath);
    const enabledPlugins = this
      .readPackedStringArraySetting(projectConfig, 'editor_plugins', 'enabled')
      .filter((pluginPath) => pluginPath !== LIVE_BRIDGE_PLUGIN_CFG);
    projectConfig = this.writePackedStringArraySetting(
      projectConfig,
      'editor_plugins',
      'enabled',
      enabledPlugins
    );
    projectConfig = this.upsertProjectSetting(
      projectConfig,
      'autoload',
      LIVE_BRIDGE_AUTOLOAD_NAME,
      null
    );
    this.writeProjectConfig(args.projectPath, projectConfig);

    const activeProcess = this.activeProcess;
    if (activeProcess && activeProcess.launchArgs.projectPath === args.projectPath && activeProcess.liveBridge) {
      await activeProcess.liveBridge.close();
      activeProcess.liveBridge = null;
    }

    const status = this.getLiveBridgeStatusSnapshot(args.projectPath);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Live bridge addon disabled.',
              ...status,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleUninstallLiveBridge(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]
      );
    }

    let projectConfig = this.readProjectConfig(args.projectPath);
    const enabledPlugins = this
      .readPackedStringArraySetting(projectConfig, 'editor_plugins', 'enabled')
      .filter((pluginPath) => pluginPath !== LIVE_BRIDGE_PLUGIN_CFG);
    projectConfig = this.writePackedStringArraySetting(
      projectConfig,
      'editor_plugins',
      'enabled',
      enabledPlugins
    );
    projectConfig = this.upsertProjectSetting(
      projectConfig,
      'autoload',
      LIVE_BRIDGE_AUTOLOAD_NAME,
      null
    );
    this.writeProjectConfig(args.projectPath, projectConfig);

    rmSync(this.getLiveBridgeProjectDir(args.projectPath), { recursive: true, force: true });

    const activeProcess = this.activeProcess;
    if (activeProcess && activeProcess.launchArgs.projectPath === args.projectPath && activeProcess.liveBridge) {
      await activeProcess.liveBridge.close();
      activeProcess.liveBridge = null;
    }

    const status = this.getLiveBridgeStatusSnapshot(args.projectPath);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Live bridge addon uninstalled.',
              ...status,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetLiveBridgeStatus(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(
        `Not a valid Godot project: ${args.projectPath}`,
        [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]
      );
    }

    const status = this.getLiveBridgeStatusSnapshot(args.projectPath);
    const activeProcess = this.activeProcess;
    const runtime =
      activeProcess && activeProcess.launchArgs.projectPath === args.projectPath && activeProcess.liveBridge
        ? activeProcess.liveBridge.status
        : null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ...status,
              runtime,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetLiveMainScene(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    const result = await this.withLiveBridgeRequest<Record<string, unknown>>(
      args.projectPath,
      'get_live_main_scene'
    );
    if (!result.ok) {
      return result.response;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.payload, null, 2),
        },
      ],
    };
  }

  private async handleGetLiveSceneTree(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    const bridgeParams = this.convertCamelToSnakeCase({
      rootNodePath: args.rootNodePath,
      includeOwner: args.includeOwner,
      maxNodes: args.maxNodes,
    });
    const result = await this.withLiveBridgeRequest<Record<string, unknown>>(
      args.projectPath,
      'get_live_scene_tree',
      bridgeParams
    );
    if (!result.ok) {
      return result.response;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.payload, null, 2),
        },
      ],
    };
  }

  private async handleGetLiveNodeState(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.nodePath) {
      return this.createErrorResponse(
        'Project path and node path are required',
        ['Provide a valid projectPath and nodePath']
      );
    }

    const bridgeParams = this.convertCamelToSnakeCase({
      nodePath: args.nodePath,
      propertyNames: Array.isArray(args.propertyNames) ? args.propertyNames : undefined,
    });
    const result = await this.withLiveBridgeRequest<Record<string, unknown>>(
      args.projectPath,
      'get_live_node_state',
      bridgeParams
    );
    if (!result.ok) {
      return result.response;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.payload, null, 2),
        },
      ],
    };
  }

  private async handleGetLivePropertyList(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.nodePath) {
      return this.createErrorResponse(
        'Project path and node path are required',
        ['Provide a valid projectPath and nodePath']
      );
    }

    const bridgeParams = this.convertCamelToSnakeCase({
      nodePath: args.nodePath,
      propertyNames: Array.isArray(args.propertyNames) ? args.propertyNames : undefined,
      includeValues: args.includeValues,
      scriptOnly: args.scriptOnly,
    });
    const result = await this.withLiveBridgeRequest<Record<string, unknown>>(
      args.projectPath,
      'get_live_property_list',
      bridgeParams
    );
    if (!result.ok) {
      return result.response;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.payload, null, 2),
        },
      ],
    };
  }

  private async handleGetLiveScriptVariables(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath || !args.nodePath) {
      return this.createErrorResponse(
        'Project path and node path are required',
        ['Provide a valid projectPath and nodePath']
      );
    }

    const bridgeParams = this.convertCamelToSnakeCase({
      nodePath: args.nodePath,
      variableNames: Array.isArray(args.variableNames) ? args.variableNames : undefined,
    });
    const result = await this.withLiveBridgeRequest<Record<string, unknown>>(
      args.projectPath,
      'get_live_script_variables',
      bridgeParams
    );
    if (!result.ok) {
      return result.response;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.payload, null, 2),
        },
      ],
    };
  }

  private async handleListLiveGroups(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    const bridgeParams = this.convertCamelToSnakeCase({
      includeMembers: args.includeMembers,
    });
    const result = await this.withLiveBridgeRequest<Record<string, unknown>>(
      args.projectPath,
      'list_live_groups',
      bridgeParams
    );
    if (!result.ok) {
      return result.response;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.payload, null, 2),
        },
      ],
    };
  }

  private async handleCaptureDebugState(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    const bridgeParams = this.convertCamelToSnakeCase({
      rootNodePath: args.rootNodePath,
      propertyNames: Array.isArray(args.propertyNames) ? args.propertyNames : undefined,
      includeOwner: args.includeOwner,
      maxNodes: args.maxNodes,
    });
    const result = await this.withLiveBridgeRequest<Record<string, unknown>>(
      args.projectPath,
      'capture_debug_state',
      bridgeParams
    );
    if (!result.ok) {
      return result.response;
    }

    const payload = { ...result.payload } as Record<string, unknown>;
    const activeProcess = this.activeProcess;
    if (activeProcess && activeProcess.launchArgs.projectPath === args.projectPath) {
      payload.recentRuntimeLogs = {
        stdout: activeProcess.output.tail(50),
        stderr: activeProcess.errors.tail(50),
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  /**
   * Handle the run_scene tool
   */
  private async handleRunScene(args: any) {
    args = this.normalizeParameters(args);

    if (!args.scenePath) {
      return this.createErrorResponse(
        'Scene path is required',
        ['Provide a valid res:// scene path to run']
      );
    }

    if (!this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid scene path',
        ['Provide a valid res:// scene path without ".." or other potentially unsafe characters']
      );
    }

    return await this.handleRunProject({
      ...args,
      scene: args.scenePath,
    });
  }

  /**
   * Handle the reload_project tool
   */
  private async handleReloadProject() {
    if (!this.activeProcess) {
      return this.createErrorResponse(
        'No active Godot project to reload.',
        [
          'Use run_project or run_scene first',
          'The process may have already terminated',
        ]
      );
    }

    const launchArgs = { ...this.activeProcess.launchArgs };
    this.logDebug(`Reloading Godot project with launch args: ${JSON.stringify(launchArgs)}`);

    this.activeProcess.process.kill();
    if (this.activeProcess.liveBridge) {
      await this.activeProcess.liveBridge.close();
    }
    this.activeProcess = null;

    return await this.handleRunProject(launchArgs);
  }

  /**
   * Handle the get_main_scene tool
   */
  private async handleGetMainScene(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      const mainScene = this.extractMainSceneFromConfig(this.readProjectConfig(args.projectPath));
      if (!mainScene) {
        return this.createErrorResponse(
          'No main scene is configured for this project.',
          ['Set application/run/main_scene in project.godot or provide a scene directly to run_scene']
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: mainScene,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get main scene: ${error?.message || 'Unknown error'}`,
        ['Verify the project path is accessible and project.godot is readable']
      );
    }
  }

  /**
   * Handle the list_scenes tool
   */
  private async handleListScenes(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      const scenes = this.listScenePaths(args.projectPath);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(scenes, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to list scenes: ${error?.message || 'Unknown error'}`,
        ['Verify the project path is accessible and contains readable scene files']
      );
    }
  }

  /**
   * Handle the get_scene_tree tool
   */
  private async handleGetSceneTree(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    if (args.scenePath && !this.validatePath(args.scenePath)) {
      return this.createErrorResponse(
        'Invalid scene path',
        ['Provide a valid res:// scene path without ".." or other potentially unsafe characters']
      );
    }

    if (args.rootNodePath && typeof args.rootNodePath !== 'string') {
      return this.createErrorResponse(
        'Invalid rootNodePath',
        ['Provide rootNodePath as a string such as "." or "Player/Camera2D"']
      );
    }

    try {
      const resolved = await this.resolveGodotPathForArgs(args);
      if (!resolved.ok) {
        return resolved.response;
      }

      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      const params: Record<string, unknown> = {
        includeOwner: args.includeOwner === true,
      };
      if (args.scenePath) {
        params.scenePath = args.scenePath;
      }
      if (args.rootNodePath) {
        params.rootNodePath = args.rootNodePath;
      }

      const { stdout, stderr } = await this.executeOperation(
        'get_scene_tree',
        params,
        args.projectPath,
        resolved.godotPath
      );

      const result = this.extractJsonResult<{ scene_path: string; tree: unknown }>(stdout);
      if (result) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      const sceneTreeError = this.buildOperationErrorResponse('Get scene tree', stdout, stderr, [
        'Verify the scene path exists and loads correctly in Godot',
        'Check that rootNodePath points to an existing node in the scene',
      ]);
      if (sceneTreeError) {
        return sceneTreeError;
      }

      return this.createErrorResponse(
        'Failed to parse scene tree result from Godot.',
        [
          'Check the operation output for unexpected script errors',
          'Try the scene directly in Godot to verify it loads cleanly',
        ]
      );
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to get scene tree: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the check_scripts tool
   */
  private async handleCheckScripts(args: any) {
    args = this.normalizeParameters(args);

    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    if (args.scriptPath && !this.validatePath(args.scriptPath)) {
      return this.createErrorResponse(
        'Invalid script path',
        ['Provide a valid res:// script path without ".." or other potentially unsafe characters']
      );
    }

    try {
      const resolved = await this.resolveGodotPathForArgs(args);
      if (!resolved.ok) {
        return resolved.response;
      }

      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      const params: Record<string, unknown> = {
        includeScenes: args.includeScenes === true,
      };
      if (args.scriptPath) {
        params.scriptPath = args.scriptPath;
      }

      const { stdout, stderr } = await this.executeOperation(
        'check_scripts',
        params,
        args.projectPath,
        resolved.godotPath
      );

      const parsed = this.extractJsonResult<{
        checked_scripts: string[];
        failed_scripts: string[];
        checked_scenes: string[];
        failed_scenes: string[];
      }>(stdout);

      if (!parsed) {
        const checkScriptsError = this.buildOperationErrorResponse('Check scripts', stdout, stderr, [
          'Ensure the project scripts are readable and parse correctly in Godot',
          'Try validating a specific scriptPath first to narrow down failures',
        ]);
        return (
          checkScriptsError ??
          this.createErrorResponse(
            'Failed to parse script-check result from Godot.',
            ['Check the Godot stderr/stdout output for parser errors']
          )
        );
      }

      if (parsed.failed_scripts.length > 0 || parsed.failed_scenes.length > 0) {
        return this.createErrorResponse(
          `Script validation failed for ${parsed.failed_scripts.length} script(s) and ${parsed.failed_scenes.length} scene(s).`,
          [
            ...(parsed.failed_scripts.slice(0, 3).map((path) => `Failed script: ${path}`)),
            ...(parsed.failed_scenes.slice(0, 3).map((path) => `Failed scene: ${path}`)),
            'Fix the reported script or scene parse/load errors in Godot and try again',
          ]
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                checkedScripts: parsed.checked_scripts,
                checkedScenes: parsed.checked_scenes,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to check scripts: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
    // Normalize parameters to camelCase
    args = this.normalizeParameters(args);
    
    if (!args.projectPath) {
      return this.createErrorResponse(
        'Project path is required',
        ['Provide a valid path to a Godot project directory']
      );
    }

    if (!this.validatePath(args.projectPath)) {
      return this.createErrorResponse(
        'Invalid project path',
        ['Provide a valid path without ".." or other potentially unsafe characters']
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse(
            'Could not find a valid Godot executable path',
            [
              'Ensure Godot is installed correctly',
              'Set GODOT_PATH environment variable to specify the correct path',
            ]
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`,
          [
            'Ensure the path points to a directory containing a project.godot file',
            'Use list_projects to find valid Godot projects',
          ]
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
      const version = versionOutput.trim();

      if (!this.isGodot44OrLater(version)) {
        return this.createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`,
          [
            'Upgrade to Godot 4.4 or later to use UIDs',
            'Use resource paths instead of UIDs for this version of Godot',
          ]
        );
      }

      // Execute using the current project root inside Godot.
      // Passing the absolute host path through to resave_resources() breaks
      // because the Godot-side script prefixes non-resource paths with res://,
      // turning /mnt/... into malformed res:///mnt/....
      // Explicitly pass a resource-root path so the Godot-side operation stays
      // inside the active project context without tripping its empty-params check.
      const params = {
        projectPath: 'res://',
      };
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

      const updateUidError = this.buildOperationErrorResponse('Update project UIDs', stdout, stderr, [
        'Check if the project is valid',
        'Ensure you have write permissions to the project directory',
      ]);
      if (updateUidError) {
        return updateUidError;
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return this.createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`,
        [
          'Ensure Godot is installed correctly',
          'Check if the GODOT_PATH environment variable is set correctly',
          'Verify the project path is accessible',
        ]
      );
    }
  }

  /**
   * Handle the quit_godot tool
   */
  private async handleQuitGodot() {
    if (!this.editorProcess) {
      return this.createErrorResponse(
        'No Godot editor process is currently tracked',
        ['The editor may have been closed already, or launch_editor was not used to start it']
      );
    }

    try {
      this.logDebug('Quitting Godot editor');
      this.editorProcess.kill();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(
        `Failed to quit Godot editor: ${errorMessage}`,
        ['The process may have already exited']
      );
    } finally {
      this.editorProcess = null;
    }

    return {
      content: [
        {
          type: 'text',
          text: 'Godot editor closed successfully.',
        },
      ],
    };
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Detect Godot path before starting the server
      await this.detectGodotPath();

      if (!this.godotPath) {
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }

      // Check if the path is valid
      const isValid = await this.isValidGodotPath(this.godotPath);

      if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.error(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] This may cause issues when executing Godot commands');
          console.error('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
        }
      }

      console.error(`[SERVER] Using Godot at: ${this.godotPath}`);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server
const server = new GodotServer();
server.run().catch((error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', errorMessage);
  process.exit(1);
});
