import { PermissionPreset, RiskLevel } from './contracts.js';

export class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionError';
  }
}

export function listPermissionPresets() {
  return [
    {
      id: PermissionPreset.FULL_ACCESS,
      label: 'Full Access',
      description: 'Run available tools directly inside the selected workspace.',
    },
    {
      id: PermissionPreset.ASK,
      label: 'Ask',
      description: 'Pause before writes, deletes, and command execution.',
    },
    {
      id: PermissionPreset.READ_ONLY,
      label: 'Read Only',
      description: 'Only expose safe, non-mutating inspection tools.',
    },
  ];
}

export function canUseTool(permissionPreset, toolDefinition) {
  if (permissionPreset === PermissionPreset.READ_ONLY) {
    return !toolDefinition.mutatesWorkspace && toolDefinition.riskLevel !== RiskLevel.HIGH;
  }

  return true;
}

export function requiresApprovalForTool(permissionPreset, toolDefinition) {
  if (permissionPreset !== PermissionPreset.ASK) {
    return false;
  }

  return Boolean(
    toolDefinition.requiresApproval ||
      toolDefinition.mutatesWorkspace ||
      toolDefinition.riskLevel === RiskLevel.HIGH
  );
}

export function assertToolAllowed(permissionPreset, toolDefinition) {
  if (!canUseTool(permissionPreset, toolDefinition)) {
    throw new PermissionError(
      `Tool "${toolDefinition.name}" is not available when the session uses "${permissionPreset}".`
    );
  }
}
