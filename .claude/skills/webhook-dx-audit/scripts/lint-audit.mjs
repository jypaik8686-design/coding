#!/usr/bin/env node
// Lint a webhook-dx-audit YAML file against schema/audit.schema.yaml or
// schema/hitl-evidence.schema.yaml.
//
// Usage: node scripts/lint-audit.mjs <file.yaml> [<file2.yaml> ...]
//
// Schema is auto-detected from the top-level key (audit: or hitl_evidence:).
// Exits 0 when every file validates, 1 on any failure.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import yaml from "js-yaml";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(here, "..", "schema");

const auditSchema = yaml.load(
  readFileSync(resolve(schemaDir, "audit.schema.yaml"), "utf8"),
  { schema: yaml.JSON_SCHEMA },
);
const hitlSchema = yaml.load(
  readFileSync(resolve(schemaDir, "hitl-evidence.schema.yaml"), "utf8"),
);

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // Allow our $id values that don't end in .json.
  validateFormats: true,
});
addFormats.default(ajv);

ajv.addSchema(auditSchema);
ajv.addSchema(hitlSchema);

const validateAudit = ajv.getSchema(auditSchema.$id);
const validateHitl = ajv.getSchema(hitlSchema.$id);

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: lint-audit.mjs <file.yaml> [<file.yaml> ...]");
  process.exit(2);
}

let failed = 0;

for (const file of files) {
  const abs = resolve(process.cwd(), file);
  let data;
  try {
    data = yaml.load(readFileSync(abs, "utf8"), { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    console.error(`${file}: YAML parse failed: ${err.message}`);
    failed += 1;
    continue;
  }

  let validate;
  let kind;
  if (data && typeof data === "object" && "audit" in data) {
    validate = validateAudit;
    kind = "audit";
  } else if (data && typeof data === "object" && "hitl_evidence" in data) {
    validate = validateHitl;
    kind = "hitl-evidence";
  } else {
    console.error(
      `${file}: cannot auto-detect schema; top-level key must be 'audit:' or 'hitl_evidence:'`,
    );
    failed += 1;
    continue;
  }

  const ok = validate(data);
  if (ok) {
    console.log(`${file}: OK (${kind})`);
  } else {
    failed += 1;
    console.error(`${file}: FAIL (${kind})`);
    for (const err of validate.errors ?? []) {
      const where = err.instancePath || "(root)";
      const detail = err.params ? ` ${JSON.stringify(err.params)}` : "";
      console.error(`  ${where} ${err.message}${detail}`);
    }
  }
}

process.exit(failed === 0 ? 0 : 1);
