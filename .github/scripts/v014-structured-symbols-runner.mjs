import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath = '.github/scripts/v014-structured-symbols.mjs';
let source = readFileSync(sourcePath, 'utf8');
source = source
  .replace(
    "    assert.ok(registration, `missing registration for ${name}`);",
    "    assert.ok(registration, 'missing registration for ' + name);",
  )
  .replace(
    "    assert.ok(registration.config.outputSchema, `${name} is missing outputSchema`);",
    "    assert.ok(registration.config.outputSchema, name + ' is missing outputSchema');",
  );

const fixedPath = '/tmp/v014-structured-symbols-fixed.mjs';
writeFileSync(fixedPath, source, 'utf8');
await import(pathToFileURL(fixedPath).href);
