import { stripExecutableFields } from './contracts.js';
import { assertToolAllowed, canUseTool } from './permissions.js';

export class ToolRegistry {
  constructor(definitions = []) {
    this.tools = new Map();
    definitions.forEach((definition) => this.register(definition));
  }

  register(toolDefinition) {
    this.tools.set(toolDefinition.name, toolDefinition);
    return toolDefinition;
  }

  registerAll(definitions) {
    definitions.forEach((definition) => this.register(definition));
  }

  get(toolName) {
    return this.tools.get(toolName);
  }

  getAll() {
    return [...this.tools.values()];
  }

  listVisibleDefinitions(permissionPreset) {
    return this.getAll()
      .filter((tool) => canUseTool(permissionPreset, tool))
      .map((tool) => stripExecutableFields(tool));
  }

  async execute(toolName, args, executionContext) {
    const toolDefinition = this.get(toolName);

    if (!toolDefinition) {
      throw new Error(`Unknown tool "${toolName}".`);
    }

    assertToolAllowed(executionContext.permissionPreset, toolDefinition);
    return toolDefinition.handler(executionContext, args ?? {});
  }
}
