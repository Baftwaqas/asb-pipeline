# Bhao Tao bargaining engine (V1, review candidate)

**Status:** this is a pure engine (`bhao/engine.js`). Nothing is live yet. It has no WhatsApp, no storefront, no database and no AI. Lane C (Claude), 5 Nov 2026.

## Who decides what

| Decision | Engine | Phrasing layer (AI or a person) |
|---|---|---|
| Accept, refuse, lowball check, counter, final offer, close | ✅ | ❌ |
| Every price (ask, settle, line total) | ✅ | ❌ It may only repeat `askPaisa` as given |
| Reply delay | ✅ `delaySeconds` | ❌ |
| Conversation angle | ✅ `angle` | It words that angle in the shopkeeper's voice |

Prices are decided only by the engine, so the phrasing layer can't concede a price. It is never handed a number it is allowed to change.

## The founder's rules (17 Sep), as code

- **Open at the anchor with no discount.** The pitch is quality compared with the market.
- **Don't counter first.** For the first `refuseRounds` replies the engine says no and names no price.
- **Lowball.** An offer below `lowballRatio × anchor` gets a long pause (`delaySeconds.lowball`), a sharp check and no counter.
- **Counters.** They are big and varied, with a step size taken from `stepPlan`, ±`stepJitter`, and are shown in round rupees.
- **Group asks.** `groupTiers` give a lower floor for more pieces, for example 5 pots at a Rs 750 floor against Rs 850 for one. If the customer drops back to fewer pieces, the single-piece floor returns (`askReset`).
- **She wins.** After `settleAfterRounds`, a fair offer is accepted: one at or above `floor + settleBand × (ask − floor)`. With `settleAtLastRound`, her best offer at or above the floor is taken on the last round, so ASB doesn't walk away from a deal it could make.
- **No two conversations are the same.** Each one has its own seed. Angles never repeat back to back, and delays vary.

## Hard guarantees (tested over 2,000 random conversations)

- The price is never below the floor for that quantity, and a floor is never below cost.
- For the same quantity, the ask only goes down.
- A settled price is never above the current ask, and never above the best price the customer named herself.
- The same seed with the same offers replays the same conversation, so it can be audited and used for the data study.
- Only `bhaoTaoEnabled`, **non-grocery** items qualify (contract §1.5). Every floor carries `approvedBy`.
- An accepted offer becomes a `bhao_tao` quote line with `provenance.bhao_offer.offerId`. It expires after `offerTtlMinutes`.

## Decisions for the founder (test values in brackets)

1. **Per item:** anchor, floor and cost; the group tiers; and who sources the 15 items. (Pot: Rs 1,800 anchor, Rs 850 floor, Rs 750 for 5 or more, Rs 600 cost.)
2. **Policy:**
   - Lowball line (35% of the anchor).
   - Refuse rounds (2).
   - Maximum rounds (10).
   - Step plan (35 / 25 / 20 / 15% of the gap, ±20%).
   - Settle band (25%) and when it starts (after round 4).
   - Settle at the last round (yes).
   - Delays (20–90 s normal, 3–7 min lowball).
   - Offer validity (2 hours).
3. **Honesty of angles.** "Running costs", "already tight" and "quality vs market" must be **true statements** when the phrasing layer words them. It must not invent competitor offers, fake stock limits or false "last piece" claims. That protects trust and keeps clear of misleading-sales complaints.

## Seth Ji's voice (`bhao/voice.js`)

The voice turns one engine decision into one WhatsApp line in Roman Urdu, using **xAI Grok** or **Anthropic Claude**, set in the server environment.

- **One price only.** The model is told the single price it may say, or that it may say none.
- **Every reply is checked before a customer sees it:**
  - every number must be one the engine allowed;
  - a counter, final offer or acceptance must actually state its price;
  - no invented scarcity or competitors;
  - no links, phone numbers or role labels, and it must be short.
- **If the check fails,** the voice tries once more, telling the model what was wrong. If that also fails, or the provider errors or times out, or no key is set, a pre-written line is sent instead, so the customer always gets a correct line.
- **Keys exist only in Render's environment** and are never logged or returned:
  - `BHAO_VOICE_PROVIDER` = `xai` | `anthropic` | `off` (default `off`)
  - `XAI_API_KEY` + `XAI_MODEL`
  - `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`
  - `BHAO_VOICE_TIMEOUT_MS` (default 8000)
- **To try it:** run `node scripts/bhao-voice-try.js 900 "itna mehenga kyun?" 1100 2000`. It plays one conversation and shows, for each line, whether it came from the AI or a pre-written line, and why any AI reply was rejected. It touches no database and sends no WhatsApp message.

## Not in this PR

- Storing conversation state, with one conversation per household, item and cycle, so a customer can't restart to reset the ask.
- The WhatsApp route that calls `speak()` for a live chat and stores the conversation.
- Bhao Tao products in Shopify: `bhao_tao_enabled` already exists as a Product Master metafield.
