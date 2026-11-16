# Audit schema

JSON Schema (Draft 2020-12) for the YAML artifacts the `webhook-dx-audit`
skill produces and consumes.

## Files

- `audit.schema.yaml` — schema for an audit YAML file (top-level `audit:`).
- `audit.schema.example.yaml` — illustrative Stripe-shaped example audit.
  Validates against `audit.schema.yaml`.
- `hitl-evidence.schema.yaml` — schema for the standalone human-in-the-loop
  (HITL) evidence pre-load file (top-level `hitl_evidence:`). The audit agent
  reads such a file at Pass 1 start to skip HITL asks that are already
  answered.
- `hitl-evidence.schema.example.yaml` — illustrative Stripe-shaped example
  pre-load. Validates against `hitl-evidence.schema.yaml`.

The HITL evidence file uses the same shape that is embedded as
`audit.hitl_evidence` in `audit.schema.yaml`. `hitl-evidence.schema.yaml`
$refs into `audit.schema.yaml` for the shared subtypes.

## Authoring style

- Field names: `snake_case`.
- Multi-line prose: YAML `|` block scalar. Markdown content inside the string
  is preserved verbatim and is the right choice for `summary`,
  `findings[].intro`, `findings[].criteria[].evidence`, and
  `recommendations[].body`.
- Flow style only for scalar arrays (e.g. `passes.pass_2.closed_criteria:
  [a, b, c]`). Block style for everything else.
- Category and criterion IDs are locked enums in the schema. Adding or
  renaming a criterion is a schema bump, not a per-audit decision.

## Status taxonomy

Each criterion has a `status` from the three-state model in
`../references/rubric.md`:

- `scored` — 0/1/2 score with no special label.
- `not_supported` — score is 0 with the explicit "the capability should exist
  but doesn't" intent. `status_reason` required.
- `not_applicable` — N/A by a logical rule (Table 1 destination-type or
  Table 2 audience). `score` is `null`, `status_reason` required.
- `not_assessed` — could not reach at the declared access level; HITL would
  resolve. `score` is `null`, `status_reason` required.

## Dual-score handling

Pass-1-only audits produce two roll-ups (Public-scope and Provisional
minimum). After HITL Pass 2 closes all Not Assessed criteria, the two
converge.

- `grade.overall_pct` and `grade.band` are the headline numbers (single value
  post-convergence; the lead value the audit reports for Pass-1-only runs).
- `grade.public_scope` and `grade.provisional_minimum` are optional
  sub-objects carrying both numbers when they are distinct.
- `grade.hitl_headroom_pct` is `public_scope.pct - provisional_minimum.pct`.
  0 once converged.
- Scorecard entries follow the same pattern: `score_pct` for the single
  value, `public_scope_pct` and `provisional_min_pct` when distinct.

`scoring.md` carries the math.

## Reserved cloud-agent fields

`audit.audit_id`, `audit.submitted_url`, `audit.submitted_at`, and
`audit.submitter_id` are reserved at the top level of `audit:` for the cloud
agent workstream (separate plan). Standalone runs omit them; the cloud agent
populates them later. Reserving them now means audits produced by the cloud
agent will not need a schema bump.

## Validation tooling

A Node-based linter ships in this skill. Install once:

```
npm install
```

Lint both bundled examples:

```
npm run lint
```

Lint an arbitrary audit or HITL evidence file (auto-detects schema from the
top-level key):

```
npm run lint:file -- path/to/audit.yaml path/to/hitl-evidence.yaml
```

The script exits 0 when every file validates, 1 on any failure. Error output
includes the JSON pointer path, the failure message, and ajv's params block
so a misnamed criterion or category ID reports cleanly.

Stack: `ajv` (Draft 2020-12) plus `ajv-formats` plus `js-yaml`. YAML is loaded
with the JSON-compatible schema so dates remain strings (the audit format
treats `prepared` and similar fields as ISO 8601 date strings).

## Adding fields or criteria

1. Update `audit.schema.yaml` (or `hitl-evidence.schema.yaml`).
2. Update the matching enum in `audit.schema.yaml` if you add or rename a
   `CategoryId` or `CriterionId`.
3. Update the example file so it still covers every required field and the
   new addition.
4. Run `npm run lint`.
5. Reflect the field in `../references/rubric.md`, `../references/methodology.md`,
   `../references/scoring.md`, or `../assets/report-template.yaml` as
   appropriate.

The schema is the source of truth for the audit's structure. Rubric or
methodology changes that the schema cannot represent are a schema gap to fix,
not a license to fork the format.
