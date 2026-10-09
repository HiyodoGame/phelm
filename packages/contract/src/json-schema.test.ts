import { describe, expect, it } from 'vitest';
import { CONTRACT_SCHEMA_ENTITIES, exportJsonSchemas } from './json-schema.js';

describe('exportJsonSchemas', () => {
  it('exports every contract entity keyed by name', () => {
    const exported = exportJsonSchemas();
    expect(Object.keys(exported).sort()).toEqual([...CONTRACT_SCHEMA_ENTITIES].sort());
  });

  it('emits self-contained draft 2020-12 object schemas', () => {
    for (const [entity, schema] of Object.entries(exportJsonSchemas())) {
      expect(schema.$schema, entity).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.type, entity).toBe('object');
      expect(JSON.stringify(schema), entity).not.toContain('$ref');
    }
  });

  it('locks the exported shapes', () => {
    expect(exportJsonSchemas()).toMatchSnapshot();
  });
});
