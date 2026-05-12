import fs from 'node:fs/promises';
import path from 'node:path';

import { stripExecutableFields } from '../contracts.js';
import { loadStdioPlugin } from './stdio-plugin.js';

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export class PluginRegistry {
  constructor() {
    this.plugins = [];
    this.tools = [];
  }

  async loadFromDirectories(directories) {
    for (const directory of directories) {
      if (!directory || !(await pathExists(directory))) {
        continue;
      }

      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const candidateRoot = entry.isDirectory()
          ? path.join(directory, entry.name)
          : directory;
        const manifestPath = entry.isDirectory()
          ? path.join(candidateRoot, 'plugin.json')
          : path.join(directory, entry.name);

        if (!manifestPath.endsWith('plugin.json') || !(await pathExists(manifestPath))) {
          continue;
        }

        const plugin = await loadStdioPlugin(manifestPath);
        this.plugins.push(plugin);
        this.tools.push(...plugin.tools);
      }
    }

    return this.plugins;
  }

  getPlugins() {
    return this.plugins.map((plugin) => ({
      name: plugin.name,
      description: plugin.description,
      manifestPath: plugin.manifestPath,
      tools: plugin.tools.map((tool) => stripExecutableFields(tool)),
    }));
  }

  getTools() {
    return [...this.tools];
  }
}
