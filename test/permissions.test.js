import test from 'node:test';
import assert from 'node:assert/strict';

import { PermissionPreset, RiskLevel } from '../src/core/contracts.js';
import { canUseTool, requiresApprovalForTool } from '../src/core/permissions.js';

const readTool = {
  name: 'fs_read',
  mutatesWorkspace: false,
  riskLevel: RiskLevel.LOW,
  requiresApproval: false,
};

const writeTool = {
  name: 'fs_write',
  mutatesWorkspace: true,
  riskLevel: RiskLevel.MEDIUM,
  requiresApproval: false,
};

const commandTool = {
  name: 'run_command',
  mutatesWorkspace: false,
  riskLevel: RiskLevel.HIGH,
  requiresApproval: true,
};

test('read_only exposes safe read tools only', () => {
  assert.equal(canUseTool(PermissionPreset.READ_ONLY, readTool), true);
  assert.equal(canUseTool(PermissionPreset.READ_ONLY, writeTool), false);
  assert.equal(canUseTool(PermissionPreset.READ_ONLY, commandTool), false);
});

test('ask mode requests approval for mutating and high-risk tools', () => {
  assert.equal(requiresApprovalForTool(PermissionPreset.ASK, readTool), false);
  assert.equal(requiresApprovalForTool(PermissionPreset.ASK, writeTool), true);
  assert.equal(requiresApprovalForTool(PermissionPreset.ASK, commandTool), true);
});
