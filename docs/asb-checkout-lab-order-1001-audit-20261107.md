# ASB Checkout Lab — First Real Shopify Test Order Audit

**Date:** Saturday, 7 November 2026 (Asia/Karachi)
**Environment:** Isolated development store `asb-checkout-lab.myshopify.com`, isolated Render web service and PostgreSQL 18; **not the production store**.
**PR:** #10, draft into `five-door-v1`. **No production deploy or merge.**

## Verified result

- **Shopify order:** `gid://shopify/Order/18999612604450` / **#1001**
- **Shopify field `test`:** `true`
- **Financial status:** `PENDING` (COD obligation, **not paid**)
- **Fulfillment:** `UNFULFILLED`
- **Shopify total:** **PKR 1,556.00**
- **Shipping:** **PKR 0.00**; **tax:** **PKR 0.00**
- **Delivery cycle:** `MON-2026-11-09`; delivery date `2026-11-09`, represented in persisted custom attributes.
- **Quote:** `ASB-LAB-ONCE-B-MON-2026-11-09` / v1; **quote subtotal 155620 paisa = PKR 1,556.20**, **cash rounding credit 20 paisa**; **collectible 155600 paisa = PKR 1,556.00**.
- **Real Shopify line identities:** `gid://shopify/ProductVariant/69644381683746`, `gid://shopify/ProductVariant/69644382797858`, `gid://shopify/ProductVariant/69644384469026`. Each Shopify line has `quantity=1`; exact weights and door provenance are stored in signed-quote/line attributes.

| Door | Synthetic line | Shopify line total | ASB exact weight |
| --- | --- | ---: | ---: |
| Apna Order | Onion | PKR 45.00 | 500 g |
| Dish-to-Cart | Ginger | PKR 11.20 | 40 g |
| Community Order | Community Hero Onion | PKR 1,499.80 | 10,000 g |

**Community original quoted line:** PKR 1,500; **PKR 0.20** cash credit allocated to this line. Its approved ceiling is retained in metadata. This is **not** a cross-door Community price.

## System observations

1. Shopify Dev Dashboard app **ASB Checkout Lab Bridge.** was authenticated through the server-side client credentials grant and actually permitted `orderCreate`.
2. Render log reported `status:"created"`, exactly Shopify order ID `gid://shopify/Order/18999612604450`, `codPaisa:155600`, `roundingCreditPaisa:20`. Independent Admin GraphQL read-back verified these values and the three variants.
3. The first synthetic case A returned `needs_reconcile` with no order ID; read-back showed **zero orders**. The ledger deliberately retained this as an unresolved first attempt and prevented automatic retry. New case B used a **different synthetic household and quote**, not a retry of the uncertain result.
4. The successful case B is a test order only. No real customer notification, payment, inventory decrement, WhatsApp delivery, or rider fulfillment was triggered by the ASB test runner.
5. **Operator flags were disabled immediately after the test.** Latest Render deployment is live and serves only a `SAFE_LOCKED` health response. No public order creation endpoint is exposed.

## Important remaining launch gates

- A failed or ambiguous attempt must have a formal **manual reconciliation/closure workflow** (case A is not silently marked completed or retried).
- A full customer-authenticated quote issuance and authoritative founder-approved quantity-policy pipeline is not yet connected to the ASB store UI. Lab fixture verifier is intentionally synthetic.
- The real Monday/Thursday cutoff implementation and delivery address verification need an end-to-end preview against actual customer flows.
- Real packed-weight adjustments, Community weekly meter verification, bill snapshot, WhatsApp confirmation and Shopify order-edit/COD reconciliation remain separate integration work.
- Verify duplicate re-submission against the completed test order and quote expiry before promoting PR #10, without creating any additional order.
- Conduct independent security review and release gates before merging to `five-door-v1` or touching production.

**Security:** No Shopify client secret, app access token, database URL/password or quote HMAC secret is stored in this report or in source control.
