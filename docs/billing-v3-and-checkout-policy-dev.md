# ASB Billing V3 + Checkout Policy — development design contract (19 Oct 2026)

> **Development only.** Nothing in this branch modifies the live WhatsApp
> V2 templates, frozen bill snapshots, bill sender, app settings, production
> database, Render environment or Shopify checkout. Do not merge or deploy
> without separate user approval.

## Confirmed operating rules

1. **Savings headline:** whole-basket *net* savings, with item-by-item proof.
   Net means all comparable lines, including lines on which ASB costs **more**,
   not the sum of only positive wins.
2. **Grocery delivery is FREE** for Apna Order, Community Bulk Buying,
   Dish-to-Cart and Budget-to-Cart. Bhao Tao is exclusively **non-grocery**;
   its delivery and checkout rules are not defined here.
3. **Apna Order:** no Rs 1,200 minimum.
4. **Community Bulk Buying:** minimum **Rs 1,200 after discounts**, validated
   **before** checkout with a gentle Roman Urdu nudge. Only offered pack
   variants; one pack per product (e.g. cannot add 5kg twice to fake 10kg).
5. **Dish-to-Cart:** no minimum has been approved; free delivery.
6. **Budget-to-Cart:** customers select a **weekly** tier. The smallest offered
   tier must be **above Rs 1,200**, but the actual tier amounts and minimum
   qualifying spend have **not yet been decided**. Checkout stays blocked
   until approved tier configuration exists. Budgets are hard ceilings; never
   silently charge above the chosen tier.
7. **Bhao Tao:** no grocery features, minimums or delivery promises inherited.

## Prototype modules (not wired to live endpoints)

- `checkout/policy-v3.js`: domain policy evaluator. Input prices, eligibility,
  pack variants, selected tier and discount MUST come from a trusted server
  quote / Shopify-side enforcement, never trusted browser values. Emits
  `allowed`, machine reason, payable total, min/remaining and a user-friendly
  Roman Urdu nudge. Returns `deliveryPaisa:0` only for grocery.
- `billing/v3-preview.js`: *read-only* preview of checkout confirmation or
  final bill. Expects canonical line amounts **in paisa** and a time-stamped
  comparable reference for any item advertised as a market comparison.
  Explicitly rejects delivery charges in grocery bills.

## Market-rate evidence and savings reconciliation

The present production schema contains `market_unit_price` but the current
bill loader does **not** include a source, quality-match assessment or last
price-check timestamp. Therefore those legacy rates are **not automatically
qualified** to support a V3 verified-basket savings claim.

V3's preview requires, for **each line**:
- market-price total for the SAME purchased weight / grade / market unit;
- an identifiable market observation source;
- a valid observation timestamp within a *proposed* 24-hour window;
- an affirmative comparable-quality check.

Twenty-four hours is a proposed starting policy, **not a verified market-rate
freshness standard**; it requires business approval and actual data collection.
Do not silently label an unverified figure "average market price." To say
"average", ASB must define and document the average from recorded observations.

If **every item** qualifies, headline basket savings =
`sum(comparable market item totals) - (ASB item totals - real discount)`.
Negative values must be displayed as a **price disadvantage**, not masked.
If evidence is incomplete, V3 explicitly states **partial/unverified** and
refuses a claim of whole-basket savings; eligible item comparisons remain
visible. It must never invent the missing comparisons or selectively exclude
an item where ASB is dearer.

The checkout confirmation quotes **maximum payable** at the current published
price; final bill shows **actual payable** after any permitted downward price
adjustment and final weighing. Both must reconcile with order rows. Delivery
remains FREE.

## WhatsApp customer-facing V3 — UX

Priority: **whole-basket comparison → purchased quantities and individual
comparisons → payable total → FREE delivery → delivery date**.

Suggested compact skeleton:

```text
🛒 APNA SASTA BAZAAR
Assalam-o-Alaikum!
Order ASB-001018 — mil gaya ✅
💚 POORI BASKET KI BACHAT: Rs 55

🧺 SAMAN
Adrak (250 gram): ASB Rs 145 | Bazaar Rs 200 | Bachat Rs 55

Bazaar total: Rs 200
ASB saman: Rs 145
🚚 Delivery: FREE
Zyada se zyada denge: Rs 145
Delivery: Thursday, 22 October
Delivery ke din rate kam hua to final bill kam ho sakta hai.
```

Figures above reproduce test #1037's existing *recorded* reference values
solely for illustrating layout. They have **not** been independently validated
as today's market prices.

For large baskets, the short WhatsApp message must show whole-basket numbers
and a short selection **without distorting** the total. Full itemization must
be available through a deliberately designed follow-up mechanism (e.g. after a
customer reply opens the service window, or a functional order-details page).
`v3-preview` returns all item rows in `detailText` and a
`previewTooLong` warning; **it is not a Meta-approved template**.
Exact template wording, variable lengths, item truncation, accessibility for
older customers, template language (Urdu/Roman Urdu), marketing vs utility
classification, and receipt formatting still need design/review and Meta
approval. Do not rewrite `asb_order_bill_v2` or `asb_final_bill_v2`.

## Production gaps and gating (must be closed BEFORE live use)

- **Shopify checkout:** This repository is the Render/Neon billing pipeline,
  not the live storefront checkout. The pure policy module **does not prevent
  placement of a Shopify order**. Identify and implement the actual feature
  entrypoints, server-generated prices, cart/checkout blocking rules, and
  Shopify validation capabilities. Frontend-only "disabled checkout" can be
  bypassed. Test checkout URLs, accelerated checkout, draft-order API, mixed
  carts, discounts, and stale browser sessions.
- **Community minimum:** Enforce across *eligible Community item totals* after
  discounts, not total grocery values in a mixed cart. Decide feature/cart
  ownership and split policy for mixed carts before enforcing.
- **Budget-to-Cart:** Confirm actual weekly tiers and eligible minimum spend,
  duration of the selected week, substitution/availability rules, cap enforcement,
  and treatment of changing prices. Never auto-substitute above budget.
- **Delivery:** Audit Shopify profiles, discount rules, existing order DB rows,
  webhooks and storefront copy. The evaluator does not modify these.
- **Price intelligence:** Persist comparable market observations and collection
  times, snapshot them with frozen customer prices, define freshness, monitoring
  and overrides. Do not update an already frozen V2 bill.
- **Meta messaging:** Prepare V3 templates separately, obtain approval, test
  with controlled accounts, prove at-most-once delivery and receipts.
- **Rollout:** all test traffic isolated. Keep
  `GROCERY_BILL_SEND=off` until a separate explicit production-send approval.

## Tests

Run `npm test` in CI with disposable PostgreSQL and stubbed WhatsApp. New
`test/checkout-policy-v3.test.js` and `test/billing-v3-preview.test.js`
exercise minimum amounts, pack rules, discount timing, budget gating,
net basket savings (including negative lines), partial/aged market evidence,
free delivery and final-vs-confirmation differences.

**No production change is authorized by completion of these tests.**
