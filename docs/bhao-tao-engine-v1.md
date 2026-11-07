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
   - Delays (20–90 s normal, **1–2 min lowball**: the founder's call on 7 Nov after the first live test; it was 3–7 min).
   - Offer validity (2 hours).
3. **Honesty of angles.** "Running costs", "already tight" and "quality vs market" must be **true statements** when the phrasing layer words them. It must not invent competitor offers, fake stock limits or false "last piece" claims. That protects trust and keeps clear of misleading-sales complaints.

## Seth Ji's voice (`bhao/voice.js`)

The voice turns one engine decision into one WhatsApp line in Roman Urdu, using **Groq**, **xAI Grok** or **Anthropic Claude**, set in the server environment.

- **One price only.** The model is told the single price it may say, or that it may say none.
- **Every reply is checked before a customer sees it:**
  - every number must be one the engine allowed;
  - a counter, final offer or acceptance must actually state its price;
  - no invented scarcity or competitors;
  - no links, phone numbers or role labels, and it must be short.
- **If the check fails,** the voice tries once more, telling the model what was wrong. If that also fails, or the provider errors or times out, or no key is set, a pre-written line is sent instead, so the customer always gets a correct line.
- **Keys exist only in Render's environment** and are never logged or returned:
  - `BHAO_VOICE_PROVIDER` = `groq` | `xai` | `anthropic` | `off` (default `off`)
  - `GROQ_API_KEY` + `GROQ_MODEL`
  - `XAI_API_KEY` + `XAI_MODEL`
  - `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`
  - `BHAO_VOICE_TIMEOUT_MS` (default 8000)
- **To try it:** run `node scripts/bhao-voice-try.js 900 "itna mehenga kyun?" 1100 2000`. It plays one conversation and shows, for each line, whether it came from the AI or a pre-written line, and why any AI reply was rejected. It touches no database and sends no WhatsApp message.

## Competitor price watch (migration 024, `bhao/price-watch.js`)

The founder's decision of 7 Nov: Seth Ji may use competitor prices for drama, but he must never bluff.

**Setup and the daily check**
- **One-time setup.** A person adds each competitor product page they have **confirmed is the same item**, and their name is recorded:
  `node scripts/price-watch-run.js --add ITEM daraz <product url> --by NAME`
  Search and catalogue pages are refused.
- **Daily check, automatic.** `node scripts/price-watch-run.js --check` (for example as a Render Cron Job) reads only those product pages, one at a time, a few seconds apart, as `ASB-PriceCheck/1.0`.
  - It obeys the site's robots.txt. Daraz's allows product pages and blocks catalogue and search pages.
  - It reads the price only from the page's structured data. Two different prices on one page count as unreadable, never a guess.
  - Every outcome is stored, append-only: ok, unavailable, blocked, HTTP error or unreadable. A blocked page is recorded and never worked around.

**What Seth Ji may say**
- Seth Ji may quote a marketplace only from an **OK check less than 48 hours old** that is **higher than his current ask**, and only that exact number.
- If any listing on that marketplace is at or below our price, he never quotes that marketplace; instead the founder gets an alert.
- "Bas 2 bachi hain" or "last piece" are allowed only when the real stock count passed in is 3 or fewer, and the number must match.
- Fake deadlines ("sirf aaj", "offer khatam") are always blocked.

## WhatsApp (migration 025, `bhao/whatsapp.js`, `bhao/runtime.js`)

Off unless `BHAO_TAO_WHATSAPP=on` **and** migration 025 is applied. When it's off, the webhook does exactly what it did before. The golden test confirms this.

**Starting and continuing a bargain**
- **Start:** the customer sends **`BHAO <ITEM-CODE>`**. The storefront's "Seth Ji se bhao karein" button will pre-fill this.
- Seth Ji opens at the anchor price. Her later texts continue the bargain. Anything else she sends stays with the normal inbox, which shows every message in either case.
- **Pacing:** Seth Ji's reply waits for the engine's pause (20–90 s, or 1–2 min after a lowball), then a 10-second sweep sends it. If she writes again before then, the pending reply is **superseded**, so she never gets an answer to something she has already moved past.
- **One turn, like a person** (founder, 7 Nov): his reply answers **everything she has written since he last spoke**, every question and point, in one message. If she named a price and then only chatted ("200" … "fazool baat mat karo"), the price is still answered, at its original pause; chatting never drops it or restarts the clock. When she asks what it costs mid-chat, he may repeat his **current** ask, never a lower one.

**Rules that protect the price**
- **No reset by restarting:** a new bargain on the same item within 7 days continues from her last ask.
- A bargain that has been silent for 24 hours lapses, matching WhatsApp's free-reply window.
- **Quantity:** "5 lein" is remembered for her next price, so the bulk floor applies.
- **Accepted:** Seth Ji's line, then *"✅ Sauda pakka … Hamari team aap ko order confirm karne ke liye abhi message karegi."* **No order is created automatically**: the team confirms it, until it's wired to Lane A's server order path.

**After the deal: aftercare** (migration 026, founder's live test, 7 Nov)
- For 24 hours after a deal, Seth Ji still answers her, so he never goes silent after "Sauda pakka".
- **"Cancel karo / nahi chahiye / mat bhejo / rehne do"** cancels the deal:
  - status `cancelled`, with the agreed offer kept as evidence and `cancelled_at` set;
  - the log says *"CANCELLED … team: do not confirm this order"*;
  - he accepts it graciously within 10–30 seconds, with no guilt-tripping.
- A question ("kya cancel ho sakta hai?") is answered, not treated as a cancellation.
- Anything else is answered at the **agreed** price. That price can no longer move up or down, and the team will confirm the order.
- **"Dost ne 800 mein li" or "Daraz pe 1200 ki hai":** he never calls her a liar and never matches it. He may repeat her number, and he names another website only when a checked competitor price exists.
- After a cancellation he points her back to `BHAO <ITEM>`. Nothing reopens by itself.

**Records and setup**
- Every line in and out is stored, append-only. Each record keeps the engine decision, whether the AI or a template wrote it, any rejections, the pause, and the send result. Meta redelivering a message changes nothing.
- **Items:** `scripts/bhao-items.js --add …` holds the founder-approved anchor, floor, cost, bulk tiers, facts and stock. The floor can never be below cost.

## Not in this PR

- Storing conversation state, with one conversation per household, item and cycle, so a customer can't restart to reset the ask.
- The WhatsApp route that calls `speak()` for a live chat and stores the conversation.
- Bhao Tao products in Shopify: `bhao_tao_enabled` already exists as a Product Master metafield.
- Passing live stock counts and `competitorFacts` from the WhatsApp route into `speak()`.
- The founder alert channel for "a competitor is cheaper than us" (it is returned today as `alerts`).
