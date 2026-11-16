# Webhook DX Audit Rubric

Score every criterion 0, 1, or 2, OR mark it Not Applicable / Not Assessed:

- **0 (Missing / Not Supported):** No evidence the capability exists, or it is absent where a developer would reasonably expect it. Use "Not Supported" in evidence when you want to make clear *why* the score is 0 (the capability should exist but doesn't), e.g. "Not Supported: signing scheme absent from the public docs".
- **1 (Partial):** Present but incomplete, undocumented, hard to find, or weaker than current practice.
- **2 (Present):** Clearly available, documented, and matching what a developer integrating in production would expect.
- **N/A (Not Applicable):** A logical rule excludes the criterion *as a concept* for this platform. Examples: Cat 5 destination-native auth on a webhook-only platform (no non-HTTP destinations to score auth for); Cat 5 webhook-specific criteria on a non-HTTP-only platform (no webhook deliveries to sign); Cat 8 verification helper when webhooks are not offered. N/A criteria are dropped from both the numerator and the denominator. Use this only when the criterion structurally does not apply. NOT for "the platform should have this but doesn't" cases - a recommended capability whose absence is a gap (e.g. no CLI, no SDKs, no signing scheme) scores 0 (Not Supported), not N/A.
- **Not Assessed:** Should be assessed but cannot be reached right now. Examples: dashboard-gated criteria on a Pass-1 audit (no test account), client-rendered surfaces not visible to a non-browser fetch. Not Assessed criteria contribute 0 to the numerator with full weight in the denominator (conservative floor), and are also reported separately so a human-in-the-loop (HITL) pass can lift them. See `scoring.md` for the dual-score aggregation.

The three states are distinct and the math differs:

| Label | Why | Numerator | Denominator |
|---|---|---|---|
| Not Supported (= 0) | capability should exist but doesn't | 0 | full weight |
| Not Applicable | logical rule excludes it | dropped | dropped |
| Not Assessed | should assess but couldn't | 0 (in Provisional minimum) / dropped (in Public-scope grade) | full weight (Provisional) / dropped (Public-scope) |

Pass-1 audits produce two scores: a **Public-scope grade** (drops Not Assessed; honest score over what was reachable) and a **Provisional minimum** (treats Not Assessed as 0 for the floor a HITL audit can only raise). See `scoring.md`.

**Whose experience you are scoring:** categories 1 through 11 are the human developer's experience, judged from the surfaces a person uses (rendered HTML docs, dashboard, published API reference). Category 12 is the only place AI and agent readiness is scored. Do not reward a platform in categories 1 through 11 for having `.md`/`llms.txt` docs or agent skills; that belongs in 12.

**Scope: webhooks and event destinations.** "Webhooks" remains the most common outbound delivery mechanism, but the broader concept is *event destinations*: HTTP webhooks plus other targets (SQS, Pub/Sub, RabbitMQ, EventBridge, Kafka, Azure Event Grid). The terminology is in flux: Stripe popularized "event destinations", Shopify is moving to "Event Subscriptions", others still call the whole thing "webhooks". Score against the broader concept regardless of what the platform calls it. The benchmark for what an event-destinations offering should provide is the Event Destinations initiative at https://eventdestinations.org (required: at least two destination types including webhooks, automatic retries with backoff, CRUD APIs, failure alerts; recommended: at-least-once delivery, topic subscriptions, auto-disable, dashboard UI, manual retries, payload filtering).

The categories below are ordered roughly along the integration journey. Weights live in `scoring.md`; the heaviest categories are Event catalog & schema, Security & authentication, and Delivery semantics & reliability, because those are where developers lose the most time and trust.

## Categories

1. Discovery & signup
2. Onboarding & first event
3. Implementation guidance
4. Event catalog & schema
5. Security & authentication
6. Delivery semantics & reliability
7. Setup surfaces (UI / API / CLI / IaC)
8. SDKs & verification libraries
9. Consumer self-serve & subscription management
10. Consumer-facing observability
11. Local dev, testing & local-to-production transition
12. Agent / AI readiness

---

## N/A logic: source of truth

The following tables are the authoritative list of when a criterion is **Not Applicable**. Apply mechanically based on the destination types the platform offers (Table 1) and the platform's intended audience (Table 2), both declared at methodology step 0. Do not re-derive N/A from per-criterion text. If you add a new criterion whose applicability depends on a structural fact about the platform or its audience, add a row to one of these tables rather than introducing a new inline clause.

### Table 1: Destination-type-driven N/A

| Step-0 fact | Criteria that become N/A | Why |
|---|---|---|
| Platform does NOT offer HTTP webhooks | Cat 5: Signature scheme; Replay protection; Secret rotation; Destination auth options; Source IP / egress. Cat 8: Verification helper. | No HTTP webhook deliveries exist to sign, time, secure, or verify. |
| Platform does NOT offer non-HTTP destinations (SQS, Pub/Sub, EventBridge, Kafka, Event Grid, etc.) | Cat 5: Destination-native auth. | No non-HTTP destinations exist to score native auth for. |
| Platform offers BOTH webhooks AND non-HTTP destinations | (none) - score all criteria. | The full Cat 5 surface applies. |
| Platform offers NEITHER webhooks NOR non-HTTP destinations | The audit does not apply. Stop and report "no outbound event surface" rather than producing a 0/F grade. | Auditing a platform with no event-delivery surface is out of scope. |

### Table 2: Audience-driven N/A

Some criteria are load-bearing for a developer-platform audience (where integrators are software engineers writing production code) but irrelevant for a no-code/low-code SaaS audience (where integrators are power users wiring up automations through a UI). The auditor declares the platform's intended audience at the start of the audit; criteria not relevant to that audience are N/A.

| Audience | Criteria that become N/A | Why |
|---|---|---|
| **developer-platform** (default) | (none) - score all criteria. | Integrators are software engineers; the full rubric applies. |
| **no-code-saas** | Cat 7: Infrastructure as code. Cat 11: Workflow / scenario simulation; Local-to-production transition. | Integrators are power users wiring up automations; IaC, scripted workflow simulation, and local-dev-to-prod handoff are not part of their toolkit. |
| **mixed** | Use judgment per criterion; default to scoring all criteria unless the platform clearly serves one audience exclusively. | Many platforms straddle both audiences. Err toward scoring to surface the gap. |

Pick one audience; do not default away from the rubric without reason. The audience declaration goes in the audit's `audience.designation` field (with at least three supporting entries in `audience.signals`) and should be cited when a criterion is marked N/A under Table 2.

Reminder: N/A is **not** for "recommended capability absent" - that's Not Supported (score 0). See the three-state taxonomy above. The decision rule: "Does this criterion make sense as a question for this platform?" If the answer is no (no SQS destinations -> "is the SQS auth native?" is incoherent), it's N/A. If the answer is yes but the platform doesn't ship the capability (every dev platform should have a CLI -> "is the CLI agent-friendly?" makes sense and the answer is "there isn't one"), it's 0.

---

## Access level requirements: source of truth for Not Assessed

Each criterion is reachable at a defined minimum access level. The audit declares the access level it actually has, and any criterion above that level is **Not Assessed** for this run. The table below is the authoritative source. Apply mechanically, exactly like the N/A table.

**Access levels (each builds on the previous):**

| Level | What the audit has |
|---|---|
| **L0: Public** | Docs, SDK source, machine specs (OpenAPI/AsyncAPI/JSON Schema), llms.txt, public GitHub repos. No login. |
| **L1: Account** | A logged-in session: can read the dashboard, settings, configuration screens, and any account-gated documentation. |
| **L2: Active usage** | L1 plus at least one delivered event observed: can see delivery logs, retry attempts, response bodies, and alerting behavior in practice. |

How L1 or L2 was obtained does not matter to the rubric. The auditor may have signed up themselves (human), used agent-driven signup (e.g. Stripe Projects, https://projects.dev), or been given access by the platform's operator or another party. The audit declares the access level it has reached, regardless of means.

**Criteria with access requirements above L0** (everything else is L0 and always assessable):

| Criterion | Minimum level |
|---|---|
| Cat 1: In-product discoverability of webhook configuration | L1 |
| Cat 2: Time to first event (walked) | L1 (or L0 if docs clearly reconstruct the path) |
| Cat 2: Test event / trigger (verified) | L1 |
| Cat 7: Dashboard configuration (verified) | L1 (L0 if the docs describe the UI in detail enough to judge) |
| Cat 9: Self-serve endpoint management (verified) | L1 (L0 if fully documented in API + dashboard docs) |
| Cat 10: Delivery logs | L2 |
| Cat 10: Payload & response inspection | L2 |
| Cat 10: Latency / attempt detail | L2 |
| Cat 11: Inspect & replay in dev | L2 |
| Cat 11: Test / sandbox parity | L2 |
| Cat 11: Workflow / scenario simulation (verified) | L2 (L0 if docs explicitly enumerate scenarios) |

For criteria marked "L1 (or L0 if ...)", score from L0 evidence if available; otherwise mark Not Assessed until access is reached. Never invent evidence to avoid the Not Assessed label.

**Scoring from absence of documentation (works at any access level).** If a criterion can be answered from L0 absence-of-documentation alone — the public docs are completely silent on the capability, with no reference in the webhook intro, API reference, dashboard documentation, or changelog — score 0 (Not Supported) from L0 even if the criterion is tagged L1 or L2 in this table. The access-level requirement is for VERIFICATION of a documented or claimed capability, not for confirming non-existence. Example: Cat 2 test event is tagged L1, but if no public surface references a test-event capability at all, score 0 (Not Supported) from L0 rather than Not Assessed.

A criterion's "Not Assessed" status under this table is deterministic given the run's declared access level. If a criterion is not in this table, it is L0 and must be scored (0/1/2 or N/A per the N/A logic table) — Not Assessed should never apply to it.

If you add a new criterion that requires more than public access, add a row to this table.

---

## 1. Discovery & signup

Lightweight. Two questions: can a developer find the webhook/event-destinations offering in the docs, and can they find where it would be configured inside the product?

- **Findability of webhook docs.** Can you reach the webhook/event docs from the top-level docs or product nav in one or two clicks? 0: buried or search-only. 1: present but only in deep nav (e.g. a sub-sidebar). 2: clearly linked as a top-level section.
- **In-product discoverability of webhook configuration.** From a signed-in account on any tier, can a user discover that the platform offers webhooks and find where they would be configured? This measures findability of the configuration surface, not access to actually create webhooks — plan-gating (e.g. Pro plan required) does not reduce the score as long as the configuration surface is visible and reachable. 0: webhooks are not discoverable from product nav; users on lower tiers have no way to know the feature exists or where it lives. 1: discoverable but the path is unclear or requires deep navigation. 2: clearly findable in product navigation, with plan-gating indicators if applicable.

Note on what is NOT scored here: pre-purchase evaluation of webhooks (a business-model question, not DX) and the ability to test webhooks without producing real domain activity (covered by Cat 2 Test event / trigger and Cat 11 Test / sandbox parity).

## 2. Onboarding & first event

Lightweight. Time and clarity from "I have an account" to "I received a first event".

- **Guided path to first webhook.** Is there a quickstart or in-product guidance that walks to a first delivered event? 0: none. 1: docs only, no in-product help. 2: quickstart plus in-product cues.
- **Time to first event.** Could a competent developer plausibly receive a first event in under ~15 minutes from the public surface? 0: unclear or blocked. 2: yes, with an obvious path.
- **Test event / trigger.** Can the developer fire a test event from the dashboard or API without producing real domain activity? 0: must create real data. 1: limited or hidden. 2: explicit "send test event".

## 3. Implementation guidance

Webhook implementation guidance: what the platform teaches integrators about verifying, handling, and deduping its HTTP webhook deliveries. Non-HTTP destinations are scored under Cat 5 (destination-native auth) and Cat 6 (delivery semantics).

- **Verification walkthrough with code.** Is there copy-pasteable signature-verification code, ideally in more than one language/framework? 0: prose only or none. 1: one snippet, partial. 2: complete, multi-language.
- **Processing & handler guidance.** Does the platform tell integrators how to handle production traffic? The handler-lifecycle practice integrators should follow is *ingest, verify, queue*: acknowledge the delivery quickly with 2xx, verify the signature, then queue the work to a background processor so burst traffic and slow downstream work do not exceed the platform's response timeout. The criterion scores whether the platform teaches this practice (with the actual timeout window stated) and points integrators at the available implementations of it they can adopt. The four items below are different categories of thing (a managed solution, two cloud-native compositions, a self-hosted setup); they are not all "reference architectures" in the formal sense. The ingest-verify-queue name itself is best-practice shorthand, not a canonical industry term. 0: silent on processing practices. 1: mentions some elements (e.g. "respond quickly" without naming the timeout window, or "process asynchronously" without a queue setup, or names the practice but no pointers to concrete implementations). 2: covers the ingest-verify-queue practice explicitly, states the response timeout window, and points integrators at the available implementations of it: a managed solution like Hookdeck Event Gateway (which ships this out of the box), cloud-native compositions like AWS EventBridge + API Gateway or GCP Pub/Sub + a serverless function, or a self-hosted queue + worker setup on the integrator's own infrastructure.
- **Idempotency guidance.** Does the documentation (a) identify the unique delivery ID developers should dedupe on (a top-level event ID in the payload, a `webhook-id`-style header, an `X-...-Delivery` header, or equivalent) AND (b) explain the high-level dedup pattern (check ID → process → store ID → return success for duplicates)? 0: no idempotency guidance. 1: idempotency mentioned but the dedup ID is not clearly identified, OR the high-level pattern is missing. 2: clear ID identification AND high-level approach explained. (Distinct from Cat 4 per-event unique ID, which scores whether the ID exists in the schema; this criterion scores whether the docs teach developers how to use it.)
- **Best-practices coverage.** Out-of-order delivery, retries-from-the-consumer-side, timeouts. 0: none. 1: partial. 2: explicit guidance on each. (Idempotency is scored separately above.)
- **Accuracy & freshness.** Do docs match observed behavior and current API? 0: stale/contradictory. 2: consistent with what you tested.

## 4. Event catalog & schema

How a developer learns what events exist and what each payload contains. Heavily weighted.

- **Event type catalog.** Is there a complete list of event types with descriptions? 0: none. 1: partial or scattered. 2: complete, single source.
- **Payload definitions.** Are payload fields defined (types, required, meaning), not just one example blob? 0: example only. 1: examples plus loose notes. 2: defined fields per event.
- **Per-event unique ID.** Is there a documented per-event unique delivery ID — a top-level field in the payload (e.g. `event.id`), a header (e.g. `webhook-id`, `X-GitHub-Delivery`), or equivalent? This is the ID consumers dedupe on for idempotency, distinct from any domain ID inside the payload (e.g. `post.id` is not a delivery ID). 0: no documented per-event unique ID. 1: a unique ID is delivered (e.g. UUID in headers) but the docs don't identify it as the dedup key, OR it's inconsistently provided. 2: per-event unique ID clearly documented as the dedup key. (Cat 3 Idempotency guidance scores whether the docs teach how to use this ID; this criterion scores whether the ID exists in the schema.)
- **Machine-readable spec.** Are events/payloads in OpenAPI 3.1's `webhooks` block, AsyncAPI, or per-event JSON Schema for programmatic use? 0: no spec. 1: a REST API spec exists but does not declare per-event payload contracts (no OpenAPI 3.1 `webhooks` block, no AsyncAPI, no per-event JSON Schema, only a generic `event` envelope schema). 2: per-event payloads declared in a fetchable spec, suitable for codegen and validation. (This is about formal schemas a developer uses for codegen and validation, not the `llms.txt`/agent-docs signal, which is scored in category 12.)
- **Sample payloads.** Are realistic sample payloads available per event type (in docs or fireable)? 0: none. 2: representative samples per type.
- **Versioning & evolution.** Is there a stated policy for schema changes (versioning, additive-only, deprecation notice)? 0: none. 1: mentioned, vague. 2: clear policy.
- **Payload shape guidance.** Is the event envelope (the top-level shape wrapping each event payload) consistent across all event types and documented? 0: envelope varies between events, or is undocumented. 1: envelope is consistent in practice but not surfaced in docs. 2: envelope is consistent and documented (whether on each event page or as a shared envelope description). Bonus signals worth noting in evidence: explicit thin (id + fetch) vs fat (full object) rationale; alignment to a standard envelope like CloudEvents. These are not required to score 2; their presence is a quality signal worth citing in evidence.

## 5. Security & authentication

Authentication of outbound deliveries to consumers: HTTP webhooks (signing, replay protection, secret rotation) and non-HTTP destinations (destination-native auth). Heavily weighted.

Security must match the destination type. For HTTP webhooks the bar is signing (HMAC or asymmetric), replay protection, secret rotation, and optional egress controls. For non-HTTP destinations (SQS, Pub/Sub, EventBridge, Kafka, Azure Event Grid) the platform should use the destination's native auth: IAM roles / cross-account ARNs for AWS, service accounts and Workload Identity for GCP, managed identities for Azure, SASL/mTLS for Kafka brokers. Native destination auth is often stronger than HMAC + bearer because the cloud provider handles key management, rotation, and revocation.

Which Cat 5 criteria apply depends on the destination types the platform offers. See the N/A logic table above; it is the source of truth.

- **Signature scheme (webhooks).** Is HTTP delivery signed (HMAC-SHA256 baseline, asymmetric a plus) with the scheme documented? 0: unsigned or undocumented. 1: signed but thinly documented. 2: documented, robust scheme.
- **Replay protection (webhooks).** Is a timestamp included in the signed material with guidance on a tolerance window? 0: none. 1: timestamp present, no guidance. 2: signed timestamp plus replay guidance.
- **Secret rotation (webhooks).** Can a customer rotate the signing secret, ideally with two active secrets during overlap? 0: no/unknown. 1: rotation possible, no overlap. 2: overlapping rotation supported and documented.
- **Destination-native auth (non-HTTP).** For each non-HTTP destination type offered, is the platform's auth model the destination's native one (IAM/cross-account roles for SQS/EventBridge, service accounts for Pub/Sub, managed identities for Event Grid, SASL/mTLS for Kafka), with clear setup docs? 0: relies on shared secrets or undocumented. 1: native auth but thinly documented or limited. 2: native auth, well documented per destination.
- **Destination auth options (webhooks).** Beyond the platform's signature on its own request: configurable bearer tokens, custom headers, OAuth2 client credentials, or mTLS that the integrator can require of the receiving endpoint. The mechanism must be documented as an authentication option (not just shipped as an arbitrary header passthrough); an integrator scanning the docs for "how do I authenticate inbound deliveries" should find concrete guidance. Score this separately from the signature scheme. 0: none documented as auth — either the only authentication is the platform-side signature, or the platform ships a passthrough field (e.g. arbitrary custom headers) without framing it as an auth mechanism. 1: one configurable option, documented as auth (e.g. bearer token only, with usage guidance). 2: multiple options, each documented as auth.
- **Source IP / egress (webhooks).** Are static egress IPs or an allowlist published so consumers can firewall the source? 0: none. 2: documented IPs/range.

## 6. Delivery semantics & reliability

What happens after "send", and whether the developer can reason about it. Heavily weighted.

- **Destination type breadth.** Does the platform deliver to more than one destination type, including at least one beyond HTTP webhooks (SQS, Pub/Sub, RabbitMQ, EventBridge, Kafka, Azure Event Grid, etc.)? This is the Event Destinations initiative's required capability. 0: webhooks only. 1: webhooks plus one additional type (meets the minimum bar). 2: webhooks plus multiple additional types covering at least one AWS and one non-AWS target. Note in the evidence which destination types are documented and whether each has parity for the rest of this category (retries, replay, observability).
- **Retry policy.** Is the retry behavior (backoff, max attempts, total window) documented? 0: silent. 1: mentioned, vague. 2: precise and clear.
- **Delivery guarantee stated.** Is at-least-once (or other) delivery explicitly stated, with dedup guidance tied to idempotency? 0: unstated. 1: implied. 2: explicit, with dedup guidance.
- **Manual replay / redelivery.** Can a failed or past event be redelivered via UI and/or API/CLI? 0: no replay path. 1: one path available (UI-only or API/CLI-only), OR partial coverage (e.g. replay in test/sandbox mode but not in live). 2: both UI and API/CLI, available in all modes.
- **Failure handling & auto-disable.** Two related questions, scored together: (a) Is post-retry behavior defined in docs (endpoint disabled, dead-lettered, dropped)? (b) Is auto-disable an actual platform feature with a documented reactivation path? 0: neither documented. 1: post-retry behavior described but no auto-disable feature, OR auto-disable exists but reactivation is undocumented. 2: both documented (post-retry behavior + auto-disable with reactivation path).
- **Failure alerting.** Are consumers *pushed* a notification of sustained failures or a disabled endpoint (email, Slack, callback, meta-webhook)? Score only push channels: the platform must tell the integrator without them having to check. A dashboard widget the integrator must look at counts as 0 here; that surface is scored under category 10 (observability) instead. 0: none. 1: one push channel, limited or undocumented configurability. 2: configurable push alerting across channels. (Folds in "state transition / meta webhooks": treat meta-webhooks as one valid implementation of this, not a separate requirement.)
- **Ordering & rate controls.** Is ordering behavior documented, and can the consumer cap delivery rate to protect their endpoint? 0: neither. 1: one. 2: both addressed.

## 7. Setup surfaces (UI / API / CLI / IaC)

Whether a developer can configure webhooks and event destinations the way they work, not just one way.

- **Dashboard configuration.** Can webhooks/destinations be created and managed in a UI? 0: no. 2: full UI management.
- **API configuration.** Are there documented API endpoints to create/update/delete webhook config? 0: none. 1: partial/undocumented. 2: complete and documented.
- **CLI support.** Is there a CLI that can manage or test webhook config? 0: none. 1: exists but limited. 2: covers config/testing.
- **Infrastructure as code.** Terraform provider or equivalent for declarative webhook/destination config? 0: none. 1: community provider with current resource coverage, OR vendor-maintained but missing webhook/destination resources. 2: vendor-maintained AND covers current webhook/destination resources. Note in evidence whether the provider is community or official, and which resources are covered.

## 8. SDKs & verification libraries

The libraries a developer reaches for, especially for verification. This category is webhook-focused on purpose: webhooks remain the most common destination type, and a hand-rolled HMAC implementation is where most integrators get burned. For non-HTTP destinations the equivalent concern (signed deliveries, message authentication) is handled by the destination's native SDK (AWS SDK, Google Cloud client, Kafka client), so it is not re-scored here, only noted as evidence under category 5's destination-native auth criterion.

- **SDK availability.** Are there official SDKs in the languages the audience uses? 0: none. 1: one or two. 2: broad coverage.
- **Verification helper (webhooks).** Does an SDK expose a first-class verify/constructEvent helper for HTTP webhooks (not hand-rolled HMAC)? 0: no helper exists (either because no SDKs ship one or because there is no signature scheme to verify against — in the latter case the upstream gap is Cat 5). 1: documented manual verification only. 2: SDK helper with examples.
- **Typed events / payloads.** Are event payloads typed (TypeScript types, generated models) for safe handling across destination types? 0: none. 1: partial. 2: typed across SDKs.

## 9. Consumer self-serve & subscription management

How much the integrating developer can manage without contacting the platform.

- **Self-serve endpoint management.** Can the consumer add/edit/remove their own endpoints? 0: support ticket required. 2: self-serve.
- **Subscription granularity.** Can they subscribe to specific event types/topics rather than all-or-nothing? 0: all-or-nothing. 1: coarse filtering. 2: per-type/topic.
- **Multiple endpoints.** Can a customer register more than one endpoint (e.g. per environment or service)? 0: single only. 2: multiple supported.

## 10. Consumer-facing observability

Whether the developer can see and debug their own deliveries, distinct from the platform's internal view.

- **Delivery logs.** Can the consumer see per-event delivery attempts (status code, timestamp)? 0: none. 1: limited/recent only. 2: searchable log.
- **Payload & response inspection.** Can they inspect the sent payload and their endpoint's response/body? 0: no. 2: full request/response visible.
- **Latency / attempt detail.** Three distinct signals: (a) attempt count, (b) next-retry time, (c) response latency per attempt. 0: none visible. 1: attempt count and/or next-retry time visible but response latency missing. 2: all three (attempt count, next-retry time, and per-attempt response latency).

## 11. Local dev, testing & local-to-production transition

Receiving and debugging on localhost, and the path from dev to prod. Criteria focus on HTTP webhooks (localhost tunnels and replay); non-HTTP destinations rely on cloud-provider emulators (LocalStack, GCP Pub/Sub emulator, Azure Service Bus emulator, etc.) as equivalents.

- **Local receiving story.** Is there a documented way to receive events on localhost (tunnel, CLI, or recommended tool)? 0: none. 1: mentions third-party generically. 2: clear, supported path.
- **Inspect & replay in dev.** Can events be inspected and replayed during development? 0: no. 2: yes.
- **Test / sandbox parity.** Is there a test mode whose webhook behavior matches production closely enough to trust? 0: none. 1: exists but diverges. 2: faithful test mode.
- **Workflow / scenario simulation.** Can a developer simulate a multi-event lifecycle (e.g. subscription_creation, renewal, cancellation; or checkout-to-invoice-to-payment) with a single trigger, so they can test their handler against realistic event sequences and ordering? This is a maturity differentiator, not a baseline; many platforms score 0 here and that is fine. 0: each test event is isolated; no way to fire a sequence. 1: implicit workflow via prerequisite chaining (firing one event creates the necessary related events as side effects), OR scripting/fixture primitives that let the developer compose sequences but no curated scenarios shipped (e.g. Stripe CLI fixtures). 2: named lifecycle scenarios that fire a curated sequence of related events in one trigger (e.g. Paddle's `subscription_creation` firing 12 events end-to-end).
- **Local-to-production transition.** Is the move from local/test to production documented (secrets, URLs, going live without surprises)? 0: unaddressed. 1: implicit. 2: documented transition.

## 12. Agent / AI readiness

The only category where AI/agent concerns are scored. Whether AI coding agents can discover, read, and correctly use the platform's webhooks. Score against the externally observable layers of Hookdeck's agent-ready model: Information, Guidance, and Action. The model's other two layers, Verification (CI on doc examples, drift detection, agent evals) and Measurement (server-side agent-traffic analytics), are internal practices you usually cannot see from outside, so mark them Not Assessed unless the platform documents them publicly (they should be assessed; the gap is access, not applicability). Reference: https://hookdeck.com/blog/developer-platform-agent-ready

Two signals that also serve agents, the formal API spec (OpenAPI/AsyncAPI) and typed SDKs, are scored under categories 4 and 8 respectively to avoid double counting. Do not re-score them here.

Information layer:

- **Discoverable index (`llms.txt`).** Is there an `llms.txt` at a stable URL that maps the docs and points to `.md` page versions? 0: none. 1: present but thin, or points only to HTML. 2: present, points to `.md`, scoped sensibly.
- **Markdown doc versions.** Are docs available as `.md` at fetchable URLs, ideally served with `Content-Type: text/markdown` so agent tooling gets lossless passthrough? 0: HTML only. 1: `.md` exists but wrong/missing content-type or incomplete coverage. 2: `.md` at clean URLs with the right content-type.
- **Push-to-agent doc actions.** Do doc pages offer actions to hand content to an agent (Copy as Markdown, Open in Claude/ChatGPT/Cursor)? 0: none. 1: Copy-as-Markdown only, OR a single Open-in-X destination. 2: multiple push-to-agent destinations (e.g. Copy as Markdown + Open in Claude/ChatGPT/Cursor). For docs hosted on modern platforms (Mintlify 2025+, Docusaurus 3+, GitBook, ReadMe), these controls are typically JS-rendered and may not appear in a non-browser fetch; default to Not Assessed and verify in a real browser during HITL rather than scoring 0 from a fetch that returns no buttons.

Guidance layer:

- **Agent guidance & skills.** Is there task-oriented agent content (how-to guides, prompts, or a dedicated agent skill, e.g. in `hookdeck/webhook-skills`) that teaches workflows and links to reference rather than duplicating it? 0: none. 1: generic how-tos only. 2: a dedicated skill or prompt that orchestrates the integration.

Action layer:

- **API access for agents.** Is there a public API for webhook configuration that agents can call directly? This is the foundational agent surface: an agent can always fall back to the API for complex tasks even when no higher-level wrapper exists. This criterion overlaps with Cat 7 API configuration and Cat 4 machine-readable spec; it captures the agent-readiness view of the same surface distinctly. 0: no public API for webhook config (dashboard-only, support-ticket-required, undocumented). 1: API exists but only via an SDK with no raw HTTP equivalent, or webhook endpoints are undocumented. 2: documented public HTTP API for webhook configuration.
- **CLI or MCP for the webhook surface.** Is there a CLI or MCP that an agent can use for higher-leverage tasks on the webhook surface (setup, research, analysis)? Either suffices; the question is whether the agent has an agent-shaped interface beyond the raw API. A CLI should have structured output (`--output json` or equivalent) and actionable errors; an MCP should expose a small, scoped tool surface for webhook operations. 0: neither CLI nor MCP covers the webhook surface (a platform-wide MCP that does not include webhook tools scores 0 here, even if the MCP is otherwise well-built). 1: CLI or MCP exists but only partially covers the webhook surface (e.g. read-only inspection, missing CRUD on webhook configs), OR the surface exists but lacks structured output / actionable errors. 2: CLI or MCP exists and covers the core webhook management workflows (CRUD on webhook configs at minimum) with structured output / agent-friendly tools.
