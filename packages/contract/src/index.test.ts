import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import * as moduleExports from './index.js';
import {
  CONTRACT_SCHEMA_ENTITIES,
  exportJsonSchemas,
  PHELM_CONTRACT_VERSION,
  renderJsonSchemaFiles,
} from './index.js';

const ENTITY_SCHEMAS = [
  'UserSchema',
  'ProjectCharterSchema',
  'MilestoneSchema',
  'EventSchema',
  'SnapshotSchema',
  'RiskSchema',
  'SuggestionSchema',
  'ProposalSchema',
  'TaskSpecSchema',
  'TaskSchema',
  'AgentConnectionSchema',
  'DecisionLogSchema',
] as const;

describe('barrel exports', () => {
  it('re-exports every contract entity schema', () => {
    for (const name of ENTITY_SCHEMAS) {
      expect(moduleExports[name], `missing export: ${name}`).toBeDefined();
    }
  });

  it('re-exports the JSON Schema helpers', () => {
    expect(typeof exportJsonSchemas).toBe('function');
    expect(typeof renderJsonSchemaFiles).toBe('function');
    expect(CONTRACT_SCHEMA_ENTITIES.length).toBe(12);
  });
});

describe('PHELM_CONTRACT_VERSION', () => {
  it('matches package.json version', () => {
    expect(PHELM_CONTRACT_VERSION).toBe(pkg.version);
  });
});
