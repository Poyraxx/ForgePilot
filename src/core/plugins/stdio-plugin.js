import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createToolDefinition } from '../contracts.js';

function resolveManifestCommand(pluginDir, command) {
  if (!command) {
    throw new Error(`Plugin at "${pluginDir}" is missing a command.`);
  }

  if (command.startsWith('.')) {
    return path.resolve(pluginDir, command);
  }

  return command;
}

function resolveArgs(pluginDir, args = []) {
  return args.map((arg) => arg.replaceAll('${pluginDir}', pluginDir));
}

function parseStdout(rawStdout) {
  const lines = rawStdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {};
  }

  return JSON.parse(lines.at(-1));
}

async function callPluginTool(manifest, pluginDir, toolName, context, args) {
  const command = resolveManifestCommand(pluginDir, manifest.command);
  const child = spawn(command, resolveArgs(pluginDir, manifest.args), {
    cwd: pluginDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Plugin process exited with code ${code}.`));
        return;
      }

      try {
        resolve(parseStdout(stdout));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(
      JSON.stringify({
        tool: toolName,
        arguments: args,
        context: {
          workspaceRoot: context.workspaceRoot,
          permissionPreset: context.permissionPreset,
          sessionId: context.sessionId,
        },
      })
    );
  });
}

export async function loadStdioPlugin(manifestPath) {
  const pluginDir = path.dirname(manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    throw new Error(`Plugin manifest "${manifestPath}" does not declare any tools.`);
  }

  const tools = manifest.tools.map((tool) =>
    createToolDefinition({
      ...tool,
      source: manifest.name,
      handler: (context, args) => callPluginTool(manifest, pluginDir, tool.name, context, args),
    })
  );

  return {
    name: manifest.name,
    description: manifest.description ?? '',
    manifestPath,
    tools,
  };
}
