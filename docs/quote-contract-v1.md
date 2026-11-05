# ASB ADR-002 — Quote Contract V1 (review candidate)

**5 November 2026 · Status: NONPRODUCTION, awaiting Claude acceptance and T0–T8 acceptance proofs.**

This is the **joint interface contract** for ASB Data Manager / Shopify storefront, the `asb-pipeline` price kernel, COD order creation, cycle locks, the packed-weight bill, and WhatsApp. It is **not executable checkout code**. The Five-Door founder-approved strategy is unchanged.

## 1. Commercial invariants

1. Each line has one trusted `door`: `apna_order`, `community_order`, `dish_to_cart`, `budget_to_cart`, or `bhao_tao`. Never pool *customer eligibility* across doors.
2. Only Community Hero product lines meeting their *own* tier/pack requirement contribute to that door's Rs 1,200 qualifying **ceiling** subtotal. For Dish/Budget, same conditions are evaluated **independently** within each door. Apna never obtains Community prices.
3. Eligibility persists after a **price-driven** decrease but is recomputed when the customer changes committed quantities before cutoff. Monday and Thursday are independent cycles.
4. Apna has no minimum order total but strictly configured *product-specific* quantities and same-household/per-cycle caps. Dish quantities originate from verified recipes and may exceed Apna caps, including sub-Apna sizes (e.g. 40 g ginger). Dish items are aggregated **before** pricing. No forced extras.
5. Bhao Tao applies to **non-grocery** items only; it neither pools eligibility with grocery doors nor shares grocery pricing.
6. An unchanged order must never cost more than the customer-approved ceiling, at the **line and whole-order level**, notwithstanding final unit rates, packing overage or a later price drop.
7. One customer-facing confirmation, one final COD obligation, one WhatsApp bill, even if Shopify internally stores line-specific `door` metadata.

## 2. Quote V1 — conceptual JSON shape

All money is an integer in **paisa** (1 PKR = 100 paisa); `qty` is a **positive integer** in `g` or `piece`, with no floating-point kilos and no implied Shopify inventory movement. `ceilingLinePaisa` is the **total approved ceiling for that line**, not a per-gram or per-pack unit rate. `quotedLinePaisa` is the currently quoted total (at confirmation it must not exceed the ceiling). `shopifyVariantGid` is the required merchandise identifier for catalogue-backed orders. `sku` is OPTIONAL informational metadata and MUST NOT be the primary key; many current variants have no SKU.

```json
{
  "quoteId": "Q-opaque-unique",
  "version": 3,
  "issuedAt": "2026-11-05T05:10:00Z",
  "expiresAt": "2026-11-05T05:25:00Z",
  "cycleCode": "MON-2026-11-09",
  "deliveryDate": "2026-11-09",
  "customerReference": "server-resolved-household-key",
  "currency": "PKR",
  "lines": [
    {
      "lineId": "L1",
      "door": "apna_order",
      "shopifyVariantGid": "gid://shopify/ProductVariant/111111",
      "canonicalProductId": "ASB-CANON-ONION",
      "sku": null,
      "unit": "g",
      "qty": 1000,
      "sellUnitLabel": "1 kg",
      "heroTier": null,
      "provenance": {"kind": "apna_selection"},
      "ceilingLinePaisa": 21000,
      "quotedLinePaisa": 21000
    },
    {
      "lineId": "L2",
      "door": "dish_to_cart",
      "shopifyVariantGid": "gid://shopify/ProductVariant/222222",
      "canonicalProductId": "ASB-CANON-GINGER",
      "sku": null,
      "unit": "g",
      "qty": 40,
      "sellUnitLabel": "40 g",
      "heroTier": null,
      "provenance": {"kind": "recipe", "recipeIds": ["RCP-000007"]},
      "ceilingLinePaisa": 5000,
      "quotedLinePaisa": 5000
    },
    {
      "lineId": "L3",
      "door": "community_order",
      "shopifyVariantGid": "gid://shopify/ProductVariant/333333",
      "canonicalProductId": "ASB-CANON-ONION",
      "sku": null,
      "unit": "g",
      "qty": 10000,
      "sellUnitLabel": "10 kg pack",
      "heroTier": {"heroWeekId": "H-WEEK-001", "tierId": "ONION-10KG"},
      "provenance": {"kind": "community_pack"},
      "ceilingLinePaisa": 150000,
      "quotedLinePaisa": 150000
    }
  ],
  "communityEligibilityByDoor": {
    "community_order": {"qualifyingCeilingPaisa": 150000, "eligible": true},
    "dish_to_cart": {"qualifyingCeilingPaisa": 0, "eligible": false},
    "budget_to_cart": {"qualifyingCeilingPaisa": 0, "eligible": false}
  },
  "ceilingTotalPaisa": 176000,
  "quotedTotalPaisa": 176000,
  "serverSignature": "opaque-HMAC-over-canonical-versioned-quote"
}
```

**Example only:** the numeric variant IDs, SKUs, prices and tier records are not live product assertions. Here the 10 kg Hero pack has an illustrative Rs 1,500 ceiling and satisfies the Rs 1,200 key on its own; the separate Apna and Dish lines do **not** contribute to eligibility. The customer would pay at most Rs 1,760 for the illustrated mixed cart, before any independently approved later reductions. Production quotes must validate true catalogue tiers and rates.

## 3. Field meanings and validation

| Field | Required validation |
| --- | --- |
| `quoteId`, `version` | Opaque ID + positive integer; database unique; all versions of a quote share an editing chain. Only the current unexpired version is redeemable. |
| `issuedAt`, `expiresAt`, `cycleCode`, `deliveryDate` | Set by server in PKT-aware cycle logic; no cross-cycle carryover. Validate cutoff and expiry at confirmation. |
| `customerReference` | Canonical internal household record, resolved by server. App proxy's shop signature is **not** customer authentication. |
| `lines[].lineId` | Unique within quote; required to reconcile packed weight, Shopify line and WhatsApp billing. |
| `door` | Required per line; allowed values from founder policy; never assign wholesale rights using a cart-global door. |
| `shopifyVariantGid` | Required for catalogue-backed lines; `gid://shopify/ProductVariant/<numeric ID>`; server confirms active mapping and correct product. No `sku` fallback for missing variant GID. |
| `canonicalProductId` | Stable internal ID, used for product-specific Apna caps and ingredient aggregation across variants. Separate from variant GID. |
| `sku` | Optional informational string; backfill in a later catalogue cleanup. |
| `unit`, `qty` | `g` or `piece`, positive safe integer; `sellUnitLabel` clarifies `1 gaddi`, `dozen`, `400 g dahi pack`, etc.; if piece means a sealed pack, record its pack definition in the canonical product master. |
| `heroTier` | Null for non-qualified/non-Hero lines; for potential Hero lines, server-resolved week/tier references. **Tier presence alone does not confer discount.** Evaluate entry and tier together. **R1:** Tier and Rs 1,200 entry eligibility are evaluated against the customer's committed, approved quantities at lock, not subsequently packed quantities. An ASB-caused shortage must not revoke the locked tier; customer-initiated quantity reductions require re-evaluation under the amendment policy. |
| `provenance` | `apna_selection`, `community_pack`, `recipe` (`recipeIds`), `budget_plan` (`planId`), or `bhao_offer` (`offerId`). Never trust the client-supplied source; engine must validate and recompute quantities against approved records. |
| `ceilingLinePaisa`, `quotedLinePaisa` | Both integer >=0; quoted <= ceiling. Must equal sum of client-presented line totals with precise rounding policy. |
| `communityEligibilityByDoor` | Feature-local qualifying totals computed from tier-qualified Hero lines at ceiling. Threshold 120000 paisa. Never sum between doors. |
| `ceilingTotalPaisa`, `quotedTotalPaisa` | Server recomputes from line totals plus any approved fees/credits; never trusts client total. Free Mon/Thu delivery remains. |
| `serverSignature` | Authenticity and integrity of canonical quote, with key rotation support; **not** a substitute for database status, shopper confirmation, identity/abuse checks or idempotency. |

The **committed quotation** is immutable. Changing ingredients/quantities/feature before cutoff creates a new version and immediately invalidates previous unredeemed versions.

### R1 — Immutable tier qualification versus actual packing

- Eligibility and tier selection at cycle lock use the accepted **committed quantity** and qualifying **ceiling-price subtotal** within the relevant door. A shortage caused by ASB after the commitment has been accepted cannot revoke the customer's locked Community tier or the Rs 1,200 entry entitlement.
- Example: customer commits to an approved 10 kg onion Hero pack; ASB can pack only 9.6 kg because of procurement shortage. **Bill the actually delivered 9.6 kg at the previously locked 10 kg tier rate, subject to the approved line ceiling; flag and remediate the short fulfillment.** Never silently change the item to a less favorable tier because ASB supplied less.
- A customer-initiated reduction in committed items/quantities is not an ASB shortage: recompute feature-local qualification and tiers according to cutoff/lock/amendment rules. Do not give permanent entitlement for a customer deliberately removing qualifying quantities.


### Mixed-door examples
- Two different doors may contain the **same variant GID** in two separately identified lines; they must not lose `door` or `provenance` during deduplication.
- Within Dish-to-Cart, aggregate matching recipe ingredients after pantry exclusions and edible/purchase-weight conversion; store the authoritative recipe IDs on the resulting line.
- Community packs remain fixed configurations; two 5 kg packs do **not** automatically earn a 10 kg tier where the 10 kg tier requires a distinct approved pack configuration.

## 4. Shopify order representation — separate from the quote

For an **exact-weight quote line** (e.g. 40 g ginger), use one Shopify order line with **`quantity: 1`** and **`priceSet` equal to the TOTAL agreed line price** in PKR. `title` may describe the measured quantity; `properties` should store source feature, `lineId`, `unit`, `qty`, canonical product, recipe provenance and approved ceiling. **Do not** use Shopify `quantity: 40` at a tiny per-gram unit price. This avoids sub-paisa unit rounding; Shopify quantity counts order line units, not grams. Shopify `weight` may express shipping weight, but is **not** an inventory deduction mechanism.

The live API must be probed for (a) preserving custom title when a `variantId` is supplied, (b) line-item properties survival after order edits, (c) price and tax behaviour on Grow, and (d) COD and WhatsApp reconciliation.

Shopify `orderCreate` uses `write_orders` with an **offline token**; configure `write_app_proxy` if using an app proxy. Test installed app scopes, not just committed `shopify.app.toml`. Shopify orderCreate does **not** recreate checkout's automatic discount behaviour; the server must fully author correct final prices.

**Inventory:** existing sampled Shopify variants are not inventory-tracked. Thus one may use existing cycle procurement and measured packing records as V1 operational stock truth **only if** an actual adjustment/reconciliation process and shortage checks are demonstrated. Record gram-level fulfilled totals internally; do not assume Shopify inventory was decremented. Do not claim complete inventory integrity from the order alone.

## 5. Atomic quote redemption / COD idempotency

An app-proxy HMAC validates the store route, not the identity of the shopper. The server must validate customer confirmation/identity separately.

1. Within a Postgres transaction: acquire stable household+cycle lock, check signed current quote version, read current Apna limits and existing reservations, validate Hero tiers and expiry, and reserve quote state and demand atomically. **R3: this creates a `pending` commitment and MUST NOT increment verified Rate Meter volume.**
2. Commit the reservation **before** Shopify network call; record a unique external-order correlation key and mark `creating`.
3. Call `orderCreate` with a safe explicit inventory behaviour; attach the opaque correlation ID to the order. Never submit two independent Shopify creates on a network timeout. Recover by looking up the correlation ID in Shopify or by an operator-controlled reconciliation path.
4. On success, persist Shopify order ID and mark redeemed. On ambiguous timeout, mark `needs_reconcile`, block automatic retry. On permanent failure, cancel reservation with an auditable reason.
5. A retry for an already-redeemed quote returns the same Shopify order ID; must not create a duplicate commitment, WhatsApp message or COD obligation.
6. A customer edit invalidates superseded unredeemed quote versions; the new version must revalidate the whole quote under one household/cycle lock.

**Required:** a transaction-safe reservation table unique across `quoteId+version` **and** quote-chain order consumption, and tests for concurrent requests, timeout/retry and duplicate webhook delivery.

### R3 — COD commitment verification and Rate Meter

- Creating a quote reservation / COD order means only **`pending`** commitment status. Pending commitments **do not count** toward the collective unlock Rate Meter.
- `verified` status is granted only when the configured founder-approved verification predicate is satisfied. Proposed policy **E1 (AWAITING FOUNDER APPROVAL)**: an ASB server-created order placed before cutoff **and** an explicit customer WhatsApp confirmation reply. No advance payment required in proposed V1.
- **Until E1 has explicit founder approval, never hard-code the WhatsApp verification predicate.** Use versioned configuration, fail closed (pending is not counted), and do not silently treat an order creation event as verification.
- Only commitments **verified in the relevant delivery cycle** may contribute to that cycle's collective meter, **once per commitment ID**. A verified commitment that subsequently progresses to `locked`, `fulfilled` or `paid` retains its original verified qualification for the locked-cycle snapshot; cancelled/refused commitments must be tracked separately and not double-counted. Preserve an auditable verification event or timestamp separate from the mutable lifecycle status.
- Ensure duplicate WhatsApp replies, webhook retries, quote replays and customer amendments never increment the same demand twice. Changes before cutoff must be reconciled against the same canonical commitment ID and its latest approved quantity; no addition across Monday/Thursday cycles.

## 6. Apna cap in native checkout — A3 provisional exception

For the **server-authored confirmation path**: reject any Apna per-product quantity over its household/cycle maximum **before** accepting COD commitment.

For **pure Apna native Shopify checkout while it remains live**: a backend cannot stop Shopify's Grow checkout from accepting an oversized cart using our own custom validation Function. Therefore detect immediately upon the authoritative `orders/create` event, place a **hold / review** on oversize purchases, and notify the customer promptly; do not silently wait until packing, fulfill an over-limit quantity, or quietly change the order. If fulfillment holds need an unsupported API or conflicting operational behaviour, use an internal hold and block allocation with clear staff alerts. This exception is temporary and is **not** equivalent to pre-checkout enforcement. Final single-path enforcement requires moving Apna into the validated server-owned path or a supported checkout-validation alternative.

Household identity should be derived from **normalised phone plus confirmed delivery address/flat and society**, not naive equality of phone alone. This can flag rather than automatically reject multi-household scenarios. Clarify genuine household merges through customer support.

## 7. Line ceiling safety — confirmed defect and owner boundaries

Current line billing is based on `COALESCE(qty_packed,qty_ordered) × price` and may exceed the approved **line** amount after a small packing overage.

Illustration:
- Accepted: 1,000 g at Rs 100/kg ⇒ line ceiling Rs 100.
- Packed: 1,080 g; final rate Rs 95/kg ⇒ arithmetic Rs 102.60.
- **Maximum collectible for that unchanged line remains Rs 100.**

### R2 — Arithmetic rounding, line caps and whole-rupee COD

- The authoritative monetary unit is an integer number of **paisa**; weight is an integer number of **grams**; prices for weight-based products are integer **paisa per kilogram** (for count-based items, integer paisa per piece).
- First calculate each weight line independently using exact integer arithmetic and **round-half-up to one whole paisa**:
  `raw_line_paisa = round_half_up(grams × paisaPerKg / 1000)`. Example: 125 g × 43,333 paisa/kg = 5,416.625 paisa ⇒ **5,417 paisa (Rs 54.17)**.
- Then apply the accepted line ceiling: `line_billed_paisa = min(ceiling_line_paisa, raw_line_paisa)`. A count-based line uses `pieces × paisaPerPiece` and the same ceiling.
- The **cash-on-delivery payable** is `floor(sum(line_billed_paisa) / 100) × 100` paisa, i.e. **round DOWN once, on the combined payable, to a whole rupee**. The difference `sum(line_billed_paisa) - cod_payable_paisa` is displayed as a **rounding credit** (0–99 paisa), never collected. Do **not** round each line to rupees independently.
- Present the line values, the explicit rounding credit and whole-rupee COD amount consistently in Shopify, WhatsApp and the customer's confirmed receipt. The Shopify authoritative payable must be reduced by the same credit through the tested reconciliation workflow.
- Rounding must never increase an individual line above `ceiling_line_paisa`, nor the full order above its accepted ceiling. Unit-price decreases and packing overages must obey the same caps. The price rounding and credit policy must be applied consistently at quote, lock and final billing.

```text
line_billed_paisa = min(ceiling_line_paisa, round_half_up(grams * paisaPerKg / 1000))
gross_bill_paisa = sum(line_billed_paisa)
cod_payable_paisa = floor(gross_bill_paisa / 100) * 100
rounding_credit_paisa = gross_bill_paisa - cod_payable_paisa
```

**Implementation warning:** Use arbitrary-precision or bounded integer math for the multiplication before division (for example `BigInt` in JavaScript), not binary floating-point, to avoid precision/overflow bugs. Confirm the current `bill.js` whole-rupee display does not hide paise or silently round each line upward. The confirmed ceiling remains a hard limit regardless of these display choices.

A short pack is charged for delivered weight and flagged for quality remediation; don't treat under-delivery as an ordinary acceptable substitution. A packing overage may be given free within documented operational tolerances. Do not bill an item that is absent. Discounts must not lift another line above its ceiling, and the **whole order must never exceed its accepted ceiling**, aside from separately customer-approved post-commitment additions.

**Shared ownership:** Claude drafts migration for persisted line ceiling inside its agreed migration range; ChatGPT reviews schema and bill change. `bill.js` and `order_items` changes should be made in a dedicated joint PR, not by two developers simultaneously.

## 8. Minimum acceptance tests before rollout

- **T0 / R3**: expired, forged, tampered, replayed and concurrent quote redemptions never create duplicate COD obligations or double-count a Rate Meter commitment; pending commitment never triggers an unlock, and only configured verified commitments count once.
- **T1**: a mixed-door quote has separate door tags and pricing rights, but one customer-facing checkout/confirmation and bill.
- **T2 / F05 / R1 / R2**: price-drop + overpacking/underpacking results in no greater than confirmed **line and order** ceiling; Shopify total, packing record and WhatsApp final bill match to paisa; ASB 10 kg → 9.6 kg shortage retains locked tier, but customer reduction recalculates; test 125 g × 43,333 paisa/kg ⇒ 5,417 paisa and whole-rupee COD rounding credit.
- **T3**: tampering with `door`, `heroTier`, `qty`, `provenance`, `price`, `household` or `cycle` never unlocks unearned prices.
- **T4**: Apna caps aggregate variants and same-cycle commitments; reject on server confirmation; separate documented native-checkout hold until fully migrated. Dish 40 g remains allowed.
- **T5**: every WhatsApp confirmation and `asal bill` equals the Shopify authoritative payable amount; retries never double-send.
- **T6**: 40 g exact-weight order remains 40 g in quote, pack record, bill and procurement-consumption measurement; do not assume `quantity:1` reduces 40 g stock in Shopify.
- **T7**: a separately approved staff-order test on the real **Grow** store, after dev-store success, confirms parity without customer-visible defects.
- **T8**: editing before cutoff issues a new quote version; previous version cannot create a Shopify order; late edits obey lock-state policy.

**Release gate:** no customer rollout until all relevant tests pass, appropriate app scopes installed, and founder authorizes specific production changes. The existing Shopify storefront and live pipeline remain untouched by this document.

## 9. Handoff to Claude

**Claude has conditionally ACCEPTED this contract. R1–R3 from the 5 Nov acceptance review have been added above. Request: confirm the three additions in the diff and mark the contract review complete.** Specifically review:
- `variantGid` mandatory / SKU optional and canon product mapping;
- `unit` g|piece, `heroTier`, server-recomputed `provenance`;
- native Apna interim hold and the non-equivalence to blocking checkout;
- Shopify quantity=1 custom price/weight + inventory reconciliation;
- line ceiling/underweight handling and transaction idempotency.

If accepted, proceed with Lane C commitments migration and F03/F04 kernel tests. Flag **only actionable counterexamples** or factual Shopify API incompatibilities. No strategy reopening.

References: Shopify GraphQL Admin API 2026-10 `OrderCreateLineItemInput`, `orderCreate`; Shopify app proxy configuration, which needs `write_app_proxy`.
