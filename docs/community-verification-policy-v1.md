# ADR-002-VERIFY-001 — Community Commitment Shield V1 (Option A)

**Founder approval:** 5 November 2026. **Policy:** Verification-first Community orders with proportionate risk checks and **selective** payment security. **Status:** implementation specification; no production setting or feature activated. **Priority:** Community pilot in November, all five doors by 31 December.

## Founder-approved principle

A COD customer's WhatsApp reply is evidence of purchasing intention, **not proof of payment** or a guarantee against refusal. We will not make advance payment mandatory for every first-time Community customer. We protect wholesale procurement through order-specific confirmation, verified location, conservative risk review, duplicate checks and exposure limits, with voluntary or risk-based deposits only after a tested payment integration.

## Minimum V1 rule for a commitment to be counted in the public Rate Meter

**All** of the following are required:

1. **Order accepted on ASB's server before the assigned Monday/Thursday cutoff**, with immutable quote ID/version, full line quantities, approved ceiling, household identity and unique commitment ID.
2. **Explicit order-specific WhatsApp confirmation** from the associated customer phone, tied to current quote version, validated webhook origin and response token. A copied "YES", duplicate click or reply to an obsolete quote does not count.
3. **Operationally valid delivery address** (society + sufficiently complete house/tower/flat/landmark, accepted by operator when uncertain), within the supported delivery footprint. Existing successfully delivered household addresses may be trusted without repeating manual verification.
4. **Risk gate passed:** duplicate/abnormal commitments screened, with explicit operator override for flagged genuine households. Device/phone/address similarity is not proof of fraud; family sharing must not trigger automatic blacklisting.
5. **No pending founder/operations-approved payment-security requirement** remains unmet. For a flagged order that requires deposit/security, verification waits until the provider confirms the payment. A screenshot alone is not proof.

Until all requirements pass, status remains `pending` or `under_review`. **Pending and under-review quantities do not count toward wholesale unlock.**

Only one current verified commitment may contribute its approved quantity to a given product+cycle meter; verification is deduplicated across webhook retries, quote replay, customer amendments and possible Shopify duplicate order receipts. Community eligibility for customer prices is still calculated **by feature, using committed tier-qualified ceiling values**, not across doors.

## Separate verification and financial-security dimensions

Keep **`verification_state`** (`pending`, `under_review`, `verified`, `rejected`, `cancelled`) distinct from the **fulfillment lifecycle** (`locked`, `packed`, `fulfilled`, `paid`, `refused`) and **`payment_security_state`** (`unsecured_cod`, `deposit_confirmed`, `prepaid_confirmed`).

- A verified COD order may be **financially unsecured**; never advertise it as prepaid, guaranteed or payment-backed.
- A deposit/prepayment is secured **only after independently verified payment-provider settlement/confirmation**. Any deposit is credited to the same order's final balance, including Community price drops, with clearly disclosed adjustments/refund terms.
- For V1, trusted repeat customers still send a one-tap/order-specific WhatsApp acknowledgment. A no-reply trust fast path requires a later separate founder approval after empirical refusal data.
- A transaction reservation creates `pending`, **not** `verified`. Retain an auditable `verified_at` and policy version separately from current order status. Cancellation, refusal and modifications are captured as event history and reflected in meter accounting.

## Risk and procurement guardrails

- Use clear, explainable flags: unusual bulk commitment, repeated unexplained COD refusals, incomplete/unserviceable address, abnormal ordering bursts, contradictory customer details and suspicious duplicate submissions.
- Never penalize a buyer for an ASB-caused shortage, late arrival or incorrect delivery. Never automatically reject an account because of a shared family phone/address.
- Human review can confirm or refuse a risk-flagged commitment, with an audit reason and opportunity for the customer to clarify.
- The procurement operator sees both **verified committed kilograms** and **payment-secured kilograms**, plus estimated downside if unsecured COD orders are refused.
- Set a conservative configurable **maximum unsecured procurement exposure per delivery cycle**, using verified landed cost, perishability, likely resale/recovery and delivery economics. **No founder-approved numeric exposure threshold exists yet**; do not invent one or silently apply an arbitrary percentage.
- When a proposed order would breach the configured exposure/risk limit, require manual review or a transparently offered payment-backed option; do not misstate payment status.
- Disclose deposit amounts, any cancellation treatment and customer remedies before collecting funds. Legal/payment-provider terms must be reviewed before enabling deposits.

## Acceptance tests for Claude's Community migration / Rate Meter

1. A pending reservation and a Shopify order with no WhatsApp acknowledgment contribute **0 kg** verified.
2. A valid WhatsApp confirmation for the current quote version plus address/risk approval contributes eligible Hero kilograms **once**; repeated webhook delivery does not increase them.
3. A response for a superseded quote does not verify the revised commitment; changed quantity requires renewed confirmation before cutoff.
4. A flagged order under review does not count; verified-after-review counts only if still eligible before lock.
5. Unverified orders in Monday cannot contribute to Thursday; neither can the same order contribute twice across cycles.
6. Deposits verified by provider are marked `deposit_confirmed`; a forged payment screenshot is insufficient.
7. ASB-caused short pack after lock retains the committed tier; actual billed weight is charged within accepted line ceiling.
8. Cancelled/refused/fulfilled/paid quantities are separately reportable; retroactive edits never create duplicate meter units.
9. Controlled pilot reports confirmed COD kilograms, payment-secured kilograms, fulfilled/paid kilograms and customer-caused refusal rates by Hero and society.

## Config v1 (illustrative contract values, not production environment switches)

```json
{
  "policyVersion": "ADR-002-VERIFY-001",
  "requireOrderBeforeCutoff": true,
  "requireOrderSpecificWhatsappConfirmation": true,
  "requireServiceableHouseholdAddress": true,
  "requireRiskGateApproval": true,
  "countPendingTowardUnlock": false,
  "allowTrustedSkipWhatsapp": false,
  "depositForEveryNewCustomer": false,
  "depositRequiredWhenRiskFlagged": "manual-review-decision",
  "maxUnsecuredExposurePaisaPerCycle": null
}
```

`null` means the financial exposure threshold **is not configured or approved**, not unlimited exposure. Pilot procurement requires explicit operating-authority review until a numerical limit is set. The implementation must fail closed on missing verification config.

**Code ownership:** Claude lane C implements verification config and Community 021 ledger; ChatGPT lane A integrates signed quotes, customer confirmation and order adapters. Do not put a payment screenshot or an unverified quote directly into the public Rate Meter.

**No rollout or live switch changes from this document.**
