# ADR-001 — Unified ASB shopping statement with feature-aware order lines (Option B)

**Decision date:** 20 October 2026  
**Decision:** ACCEPTED — architecture; **implementation not yet authorized**.  
**User-approved choice:** Option B, consolidated grocery statement with feature-wise
sections. **No Shopify integration, database migration, message activation,
template submission or production change is part of this ADR.**

## 1. Customer contract: one view, accurate underlying boundaries

- One customer can purchase from **Apna Order**, **Community Bulk Buying**,
  **Dish-to-Cart**, **Budget-to-Cart**, and **Bhao Tao**.
- A **grocery checkout that contains multiple eligible grocery features**
  should generate **one confirmation for that checkout**, a single
  basket-level savings headline, and **only the feature sections actually
  used**. Each feature section has its own item lines, subtotal and optional
  eligible savings subtotal. Each line shows quantity, Bazaar reference (when
  substantiated), ASB price and difference.
- **Bhao Tao is non-grocery only.** Never apply grocery shipping/minimum,
  market-rate, tax, returns or final-price promises to a Bhao Tao line. A
  single ASB account / cart *overview* can list it alongside grocery groups,
  but its **payment bill, fulfillment and terms remain separate** unless all
  relevant compatibility checks have been explicitly designed, approved and
  tested. Do not falsely advertise one payable amount for incompatible groups.
- **More than one Shopify checkout** by the same customer does **not** mean
  the system may silently replace individual confirmations with one
  confirmation. Send **one confirmation per accepted checkout and eligible
  delivery/payment group**. An optional **cumulative household statement**
  can reference several checkouts and revisions, but must be identified as a
  statement (not a new order or payment demand) and must never double-charge,
  re-book, or re-send old confirmations.
- A **single checkout covering distinct delivery cycles** displays distinct
  delivery-group dates and subtotals; do not fabricate a single delivery date.
  A one-message shopping *overview* is allowed, but legally/operationally
  different commitments require separate underlying confirmation or invoices.

**Language & accessibility:** readable Roman Urdu, familiar feature labels,
large primary figures, no crossed-out Bazaar reference prices, no
per-kg mental arithmetic for a 250 g purchase. Only used feature sections
appear. Small baskets can show every line; large baskets get a short summary
plus a secure full-itemization path / customer-requested detail. Never hide
amounts the customer owes or undisclosed terms in truncated text.

## 2. The invariants we will enforce

### Feature provenance
- EVERY Shopify order line gets **exactly one immutable buying-feature ID**:
  `apna_order`, `community_bulk_buying`, `dish_to_cart`,
  `budget_to_cart`, `bhao_tao`.
- Optional provenance attributes: dish/recipe ID, weekly budget plan ID and
  week, community pack ID / collective meter ID, negotiated quote/version,
  originating feature UI.
- Provenance is determined by a **server-created and signed checkout context**,
  linked to exact Shopify line/variant identities; never inferred from product
  title, SKU, vendor, price, or unchecked browser/cart attributes.
- A product bought from two features remains **two distinct purchase lines**
  at its own pack, quoted rate, discounts, rule set, and fulfillable commitment.
  `Piyaz 1 kg (Apna Order)` + `Piyaz 10 kg (Community)` must not become
  `Piyaz 11 kg` at a synthesized price.

### Boundaries / eligibility
- All **grocery** features: **FREE delivery (Rs 0)**. Verify Shopify actually
  charges zero before accepting checkout; never quietly invent shipping fees.
- **Apna Order**: no Rs 1,200 floor.
- **Community**: >= Rs 1,200 **Community-eligible payable subtotal after
  allocated discounts**; grocery lines from other features cannot satisfy
  the floor. If below: a gentle amount-remaining nudge and BLOCK checkout,
  on both UX and server/Shopify checkout validation. Only offered packs, one
  qualifying pack per product (no 5kg + 5kg / 10kg + 10kg loopholes).
- **Dish-to-Cart**: no approved minimum; costed ingredient lines retain
  Dish-to-Cart provenance, while optional ordinary-cart ingredients stay
  Apna Order if they were added through that feature.
- **Budget-to-Cart**: select an explicitly approved **weekly** tier greater
  than Rs 1,200; the exact tiers and qualifying-spend rule **remain TBD**.
  The server must enforce the per-plan spend ceiling across ALL Budget-to-Cart
  checkouts for the same customer and week, not merely within one cart;
  include reserved/committed amounts and handle concurrent devices.
  No silent overspend, negative remaining budget, or unauthorized rollover.
  Checkout fails closed until plan values are approved.
- **Bhao Tao**: non-grocery; pricing, shipping, return, tax, payment and
  fulfillment policy not presumed from grocery. Unknown feature/invalid
  provenance causes review/refusal, not a guessed feature.
- **Mixed carts** must be partitioned before validation: discounts,
  minimums, packs, deliveries and taxes scoped to the responsible group.
  No cross-feature subsidy or counting the same discount twice.

### Time, money, savings
- `booked_at` comes from each **original Shopify accepted order timestamp**,
  not webhook arrival, worker time, or WhatsApp send time. Display in
  **Asia/Karachi**, including weekday, date, and clock time. An aggregated
  multi-checkout statement shows separate timestamps or a clearly stated
  range, not a fake singular booking time.
- Keep currency and arithmetic in **integer minor units**, reconcile all
  subtotals, discount allocations, shipping, and taxes to verified Shopify
  payment totals. A displayed "maximum payable" must be enforceable; the
  later actual final bill must reflect permitted repricing, weighing,
  cancellation, refund, and amendment rules.
- Each eligible grocery line's **Bazaar reference must match the purchased
  quantity and comparable quality**, with source, geography, observation
  time, and documented aggregation rules. Missing/stale/noncomparable data
  are not fabricated. A market "average" is used only when there is a
  genuine reproducible average of recorded comparable observations.
- Grocery basket saving, *only with complete eligible evidence* =
  `sum(Bazaar totals for every eligible grocery line) -
  (sum(ASB grocery line totals) - eligible grocery discount)`.
  Negative lines REDUCE the net saving; negative total is explicitly a
  disadvantage. If evidence is incomplete, do not claim a whole-basket
  saving; report covered-line comparisons and coverage.
- **Delivery is free at ASB**, but a rupee-value "delivery saving" is ONLY
  shown if there is an independently documented, genuinely comparable
  delivery alternative for the same basket/geography/date. Keep grocery
  basket saving and delivery benefit separately labeled by default. A single
  combined "shopping + delivery" figure is permitted **only** when the two
  components reference the same consistent alternative purchase scenario
  and there is no double counting. Otherwise say "FREE DELIVERY" without
  pricing an imaginary fee.
- Bhao Tao savings and delivery value must never be added to grocery
  Bazaar-comparison savings without independently validated, compatible
  definitions and approved copy.

## 3. Canonical domain model — design, not a migration

```text
ASB Customer
  ├─ ASB Shopping Session (UX grouping; optional)
  └─ Checkout Group (one accepted Shopify checkout / Shopify order identity)
       ├─ Verified checkout context (server-issued; versioned; expiry)
       ├─ Feature Purchase Lines (immutable exact Shopify line identities)
       │    ├─ feature + optional recipe/plan/community/negotiation context
       │    ├─ actual purchased pack/quantity, booked money/discount
       │    ├─ frozen market-observation provenance and comparability
       │    └─ state/revision links for fulfilment, refunds or corrections
       ├─ Fulfillment & payment groups (separate promises where needed)
       │    ├─ Grocery cycle A (Apna Order / Dish / Budget / Community)
       │    ├─ Grocery cycle B, if applicable
       │    └─ Non-grocery Bhao Tao (separate terms)
       └─ Customer Statement(s)
            ├─ Grocery checkout confirmation V3 (frozen, versioned)
            ├─ Grocery final bill (frozen; later state)
            ├─ Optional multi-checkout cumulative overview (not an invoice)
            └─ Non-grocery statement/invoice (independent)
```

Proposed logical records (exact table and key design subject to schema review):

1. **checkout_groups**: unique `(shop, shopify_order_id)`, accepted timestamp,
   verified customer identity, currency, pricing/policy version and
   checkout-context digest. A single Shopify order can span features, but it
   must not be mistaken for one grocery delivery cycle.
2. **checkout_feature_lines**: unique
   `(shop, shopify_order_id, shopify_line_item_id)`, mandatory feature,
   variant/pack/recipe/plan IDs, quantity, individual monetary components,
   and pointer to frozen market quote/observation. No cross-feature
   collapsing. Record item-level discount attribution deterministically;
   reconcile rounded pennies on a stable allocation order. Corrections use
   explicit revision/superseding events rather than rewriting a frozen bill.
3. **fulfillment_groups**: links lines that share service domain,
   delivery cycle/date, pricing/finalization obligations, merchant,
   payment and applicable policy. Record group membership and amount.
   Community operational settlement remains separate from standard grocery
   `orders/order_items`, even if the customer sees a common shopping summary.
4. **statement_snapshots**: immutable `(checkout_group_id, document_type,
   fulfillment_group_id or scope, revision)` or equivalent uniqueness.
   Frozen display payload, full itemization, totals, booking timestamps,
   market-comparison coverage, delivery terms, template/version,
   digest, created timestamp and group readiness. Customer-visible order
   reference must map unambiguously to underlying Shopify orders.
5. **statement_send_attempts**: idempotency key
   `asb:v3:<checkout-group>:<scope>:<document-type>:<revision>`,
   authorization, transport, Meta message ID, callback receipts and
   unknown-outcome review state. Exactly-once processing in DB; **at-most-once
   automatic external attempts**, with manual reconciliation for ambiguous
   outcomes. A cumulative informational update never reuses the original
   checkout-confirmation key.

Do not extend any production table without migration impact/rollback
analysis. Existing IDs, immutable event payloads, Community provenance,
customer identity constraints and 017 idempotency guards must survive.

## 4. Event flow & cross-feature readiness barrier

```text
Feature UIs -> unified cart / explicit separate fulfillment groups
 -> server-issued, trusted feature-by-line checkout context
 -> server recomputes amounts + validates EVERY feature/group
 -> fail? gentle nudge; no Shopify order
 -> pass? Shopify accepts checkout
 -> webhook stored once, source lines durably identified/captured
 -> Community intake resolves / Community commitment created by a
    future separately-tested feature backend (NOT currently implemented)
 -> grocery bag persists separately using existing 017 idempotency
 -> all promised included groups ready? freeze V3 statement atomically
 -> outbox/claim with message-scope key, holds, age/retry guards
 -> Meta-approved template / controlled dispatch
 -> receipts + full audit trail
```

**Critical: do not claim an entire mixed checkout is "confirmed" while
Community lines are only captured/resolved in today's Phase-1 intake.**
`community/worker.js` currently creates **no commitment, meter action or
customer billing**. If any required group is pending or in review, keep the
consolidated payment confirmation on hold or send a separately approved
non-monetary "order processing" notice (not an incorrect receipt). Escalate
and reconcile; NEVER omit the Community items and label the remainder as
the complete bill.

For an accepted checkout with multiple grocery features and compatible
delivery/payment rules, build **one atomic aggregate V3 snapshot** from the
canonical feature ledger, never from a grocery-only projection plus hoped-for
Community amounts. Any incomplete/unknown feature mapping blocks that
aggregate and emits an operational alert. A later snapshot revision must
refer to earlier messages and have explicit send authorization rules.

For separately booked Shopify checkouts, preserve each order's immediate
booking confirmation and timestamp; an **optional** cumulative view for a
common delivery cycle can be generated later, with clear "updated statement"
copy and stable component order references. Do not send it by default until
its messaging policy is approved.

## 5. Existing code constraints — independently verified on main

- `community/intake.js` permanently captures Community order lines keyed by
  shop + Shopify order + Shopify line, while
  `community/sanitize.js` **removes Community lines and monetary totals**
  from the ordinary grocery path.
- `grocery/apply.js` has a one-source-per-Shopify-order capture, treats
  Community-only orders as `bill_state='not_required'`, and currently
  freezes a **grocery-only** bill after writing the grocery bag.
- `grocery/write.js` merges orders per household/per cycle, and upserts
  `order_items` by `(order_id, product_id)`: it **does not preserve feature
  provenance** for identical products from multiple features.
- Migration 017 already protects `shopify_order_source_lines` by unique
  `(source_id, shopify_line_item_id)`, and only supports kind =
  `grocery|community|skipped`; kind is **not** customer shopping feature.
- `community/worker.js` Phase 1 only resolves registered variants; it
  **does not settle Community purchases or send a bill**.
- Current `checkout/policy-v3.js` in draft PR #5 accepts **one** feature per
  evaluation; current `billing/v3-preview.js` likewise previews one
  feature. They are domain prototypes **not a consolidated billing system**.
  Implement a future `evaluateCheckoutGroup(featureSubcarts[])` and
  `composeFeatureAwareStatement(verifiedFeatureLines[])` by adaptation,
  with new database and integration tests; do not falsely declare the
  existing prototype "Option B complete".

## 6. UX: one-feature vs multi-feature & long orders

**Single feature:**
```text
ASB — Order ASB-...
Book hua: Monday, 19 October 2026 • 12:30 PM (PKT)
🧺 Apna Order
Adrak 250 gram
Bazaar Rate: Rs 200
ASB Rate: Rs 145
...
💚 Poori basket ki bachat: Rs 55 (only if fully substantiated)
Delivery: FREE | Maximum payable: Rs 145
Delivery: Thursday, 22 October
```
**Multi-feature, one eligible grocery checkout:**
```text
Order: ASB-...
Book hua: ... (PKT)
💚 Puri grocery basket ki bachat: Rs X [only if verified]

1. Apna Order — 2 items — Rs A
2. Community Bulk Buying — 1 pack — Rs B
3. Dish-to-Cart — 4 ingredients — Rs C

Bazaar reference total: Rs M [only with full coverage]
ASB grocery total: Rs G
Delivery: FREE
Maximum payable: Rs G
Delivery: Thursday, ... [or separate date per fulfillment group]
View item-wise market rates: [secure, functional details link / reply workflow]
```
For 5+ or bulky lines, show section summaries and the savings headline, and
provide a proper detailed itemization access path. Never make a 30-line text
block with tiny hard-to-read labels. Never invent a nonfunctional link.

Bhao Tao may be listed as its own section in the shopping *overview*,
but no combined grocery "maximum payable" that silently includes non-grocery
terms. Name each payable scope explicitly.

## 7. Required test matrix (development/staging only)

- One grocery feature; 2, 3, and 4 grocery features, same checkout;
  zero unrelated feature headings; stable section and line order.
- Identical SKU in two features; identical SKU in separate Shopify orders;
  no netting, no duplicate or wrong price.
- Community Rs 1,199 rejected; Rs 1,200 accepted; a mixed Rs 800 Apna +
  Rs 500 Community rejected; discount reduces Community below floor;
  5+5 duplicate pack rejected; 10kg variant accepted only if offered.
- Budget tier unconfigured fails closed; approved tier >Rs 1,200; two
  checkouts in the same week, concurrency and stale quote cannot break cap.
- Different delivery dates/schedules, cancelled subgroup, partial
  fulfillment, unavailable item, weighed-down final price, partial refund,
  mixed currency/payment/merchant/tax policy: do not conflate amounts.
- Unverified/expired Bazaar reference; loss-making line; net savings
  negative; item-wise difference sums precisely to basket result; no
  unsupported delivery-saving claim or double counting.
- 1/10/20+ item message readability; full details; native Urdu item names
  beside Roman Urdu and amounts; Meta approved templates and body limits.
- Original Shopify booking day/time converted to PKT; follow-on purchases
  retain their distinct times; delivery date separate.
- Duplicated/out-of-order webhooks; contradictory feature metadata; unknown
  Community variant; partially ready checkout; 017 replay; crash/restart;
  2 workers racing; exactly one send attempt; Meta timeout unknown; receipt
  delivered/read; no old-message resend. Reconcile frozen snapshots.
- Shadow mode: compare group totals to Shopify accepted order amount and
  the legacy grocery-only projection; **no external WhatsApp calls**.

## 8. Change-control & implementation order

1. **ADR acceptance:** this document (Option B architecture).
2. **Read-only live store audit:** identify actual storefront/checkout code,
   Shopify validation capabilities, shipping configuration, item properties,
   discount allocation and source-of-truth billing totals. No changes.
3. **Schema / contract proposal and tests:** staged-only migration plan,
   transaction/locking/idempotency design, legacy compatibility, backfill
   strategy (do not retroactively reclassify old lines without provenance).
4. **Build server policy integration** with feature-level checkout enforcement
   and approved Budget-tier configuration when available.
5. **Implement Community settlement and canonical feature ledger** as
   distinct, audited work. Preserve Phase-1 isolation.
6. **Compose/read-only preview** of V3 consolidated statements; prove price
   and market-evidence reconciliation. Approved UI from current HTML demo
   is visual direction, not yet equivalent to deployed renderer.
7. **Meta templates, staged delivery tests, owner review, explicit approval**
   of *each* live database migration, Shopify change, and message activation.
   Stage first with WhatsApp stub, then a single authorized recipient.

**Release gate:** no production deploy, no activation of automatic WhatsApp
billing, no merge to `main` and no mutation of Shopify/Neon production without
the owner's explicit go-ahead. Existing live V2 frozen bills/receipts unchanged.

### Accepted vs still to be approved

**Accepted:** Option B presentation and feature identity; grocery delivery
FREE; Community >=Rs 1,200 feature-only checkout floor; Community pack rules;
weekly Budget tier model (>Rs 1,200 starter tier); true basket-net savings
with line-level comparisons; booking time; separation of incompatible
non-grocery obligations; no partial/false confirmation.

**Not yet approved:** precise weekly Budget tiers and min spend, how
mixed cart is implemented in the actual Shopify storefront, market-survey
freshness policy, comparable competitor delivery fee (if any), Meta template
wording/approval, cumulative statement auto-send policy, and Bhao Tao
terms. These open configuration questions do **not** invalidate Option B's
architecture; their gates fail closed.
