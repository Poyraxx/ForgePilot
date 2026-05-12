import { createCommandTool } from './command.js';
import { createFileTools } from './fs-tools.js';
import { createSearchTool } from './search.js';
import { createWebTools } from './web.js';

export function createBuiltInTools() {
  return [...createFileTools(), createSearchTool(), ...createWebTools(), createCommandTool()];
}
