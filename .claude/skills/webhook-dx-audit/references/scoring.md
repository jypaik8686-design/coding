# Scoring & Grading

Turn per-criterion 0/1/2 scores into category scores, an overall percentage, and a grade band.

## Category weights

Weights sum to 100. They are heavier where developers lose the most time and trust (schema, security, delivery), and lighter on the lightweight onboarding categories, matching the program's emphasis on the outbound-event surface.

| # | Category | Weight |
|---|----------|--------|
| 1 | Discovery & signup | 4 |
| 2 | Onboarding & first event | 6 |
| 3 | Implementation guidance | 9 |
| 4 | Event catalog & schema | 13 |
| 5 | Security & authentication | 15 |
| 6 | Delivery semantics & reliability | 15 |
| 7 | Setup surfaces (UI / API / CLI / IaC) | 9 |
| 8 | SDKs & verification libraries | 8 |
| 9 | Consumer self-serve & subscription management | 6 |
| 10 | Consumer-facing observability | 6 |
| 11 | Local dev, testing & local-to-production transition | 5 |
| 12 | Agent / AI readiness | 4 |
| | **Total** | **100** |

## Three states, two roll-ups

Each criterion ends up in one of four positions: scored (0/1/2), Not Supported (= 0), Not Applicable, or Not Assessed. See `rubric.md` for definitions. The same audit produces two scores from this data:

- **Public-scope grade.** "How good are the parts we could see?" Drops both Not Applicable and Not Assessed from both numerator and denominator. The honest score over the publicly reachable subset.
- **Provisional minimum.** "What's the floor if human-in-the-loop (HITL) verification never happens?" Drops Not Applicable from both. Treats Not Assessed as 0 in the numerator with full weight in the denominator. HITL Pass 2 can only raise this number.

When HITL Pass 2 completes (no Not Assessed criteria remain), the two scores converge on a single final grade.

Why two: a Pass-1-only audit with HITL planned should lead with the Provisional minimum, since that is the conservative bound the customer can rely on pre-HITL. A standalone or automated audit with no HITL planned should lead with the Public-scope grade, since the scope is what was reachable by design. Both numbers always go in the scorecard regardless; only the headline framing differs.

## Computing a category score

For each category and each of the two roll-ups, exclude criteria per the rule above and compute:

```
category_pct = (sum of included criterion scores) / (2 * number of included criteria) * 100
```

**Example 1, all criteria assessed.** Security has 6 criteria; you score 2, 1, 1, 0, 2, 2. Sum = 8, max = 12, so **both roll-ups score 67%** (no N/A, no Not Assessed).

**Example 2, one criterion Not Applicable.** Security has 6 criteria; the destination-native-auth criterion is N/A because the platform is webhook-only; the remaining 5 score 2, 2, 1, 0, 2 = 7. Max = 2 * 5 = 10, so **both roll-ups score 70%**. N/A is dropped from both numerator and denominator in both roll-ups.

**Example 3, one criterion Not Assessed.** Security has 6 criteria; one is gated to HITL (Not Assessed); the remaining 5 score 2, 2, 1, 0, 2 = 7.
- Public-scope grade: 7 / (2 * 5) = **70%** (Not Assessed dropped from both).
- Provisional minimum: 7 / (2 * 6) = **58%** (Not Assessed contributes 0 to numerator, full weight in denominator).
- The 12-point gap is the maximum room HITL has to lift the score.

**Example 4, both N/A and Not Assessed.** Security has 6 criteria; one is N/A (webhook-only platform); one is Not Assessed (gated); the remaining 4 score 2, 2, 1, 2 = 7.
- Public-scope: 7 / (2 * 4) = **88%**.
- Provisional minimum: 7 / (2 * 5) = **70%** (Not Assessed in denominator, N/A still dropped).

If every criterion in a category is Not Applicable, drop the whole category and renormalize for both roll-ups: each remaining category's effective weight is `original_weight / (100 - dropped_weight) * 100`. Example: if you drop the 4-weight Discovery category, the remaining categories sum to 96 in weight; multiply each by `100/96 = 1.0417` so they total 100 again. Record any dropped category in the audit's `access_limits` array.

If every criterion in a category is Not Assessed, do not drop the category. The Provisional minimum scores it 0% (full weight); the Public-scope grade drops it (and renormalizes the same way as for fully-N/A categories). This is the only place the two roll-ups treat categories differently.

## Computing the overall score

For each roll-up:

```
overall_pct = sum(category_pct * effective_weight) / sum(effective_weights used)
```

Round to a whole number. Report both Public-scope and Provisional minimum with their grade bands.

## Grade bands

| Overall | Grade |
|---------|-------|
| 85-100 | A |
| 70-84 | B |
| 50-69 | C |
| 30-49 | D |
| 0-29 | F |

The band is a headline, not the point. The recommendations are what the customer acts on. Two platforms can share a band with very different gap profiles, so always pair the grade with the category scorecard and the prioritized list. Do not write qualitative judgments of the grade ("painful", "production-grade", "strong") into the audit; the grade letter and the findings speak for themselves.

Note on boundary effects: rounding-sensitive grades (e.g. an overall in the 28-32 zone where F and D meet, or the 83-87 zone where B and A meet) should not be over-interpreted. Reviewers should sanity-check the grade by reading the per-category scores and the recommendations.

## Prioritizing recommendations

Rank recommendations by **impact x ease**, not by category order:

- **Impact:** how much it removes friction or risk for the integrating developer. A missing or weak signing scheme, no consumer-facing delivery logs, or no retry documentation are high impact.
- **Ease:** how cheaply the platform (or Hookdeck, via a matching offering) can close it. Publishing egress IPs or an `llms.txt` is cheap; shipping a Terraform provider is not.

Lead the recommendation list with high-impact, low-effort items. For each, link the matching Hookdeck offering from `program-mapping.md` where one fits, framed as an option.
