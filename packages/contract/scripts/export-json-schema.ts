import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderJsonSchemaFiles } from '../src/json-schema.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(packageRoot, 'dist', 'schemas');

mkdirSync(outDir, { recursive: true });

for (const [entity, content] of Object.entries(renderJsonSchemaFiles())) {
  const file = join(outDir, `${entity}.json`);
  writeFileSync(file, content);
  console.log(`wrote ${file}`);
}
