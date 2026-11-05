# Dish-to-Cart exact-quantity pricing (V1, review candidate)

**Status:** this is a pure kernel (`dish/kernel.js`). Nothing is live yet. It has no Shopify write, no checkout and no database. Lane C (Claude), 5 Nov 2026.

## What it does

The server passes the recipes the customer picked, with servings, option choices and pantry items to skip. It also passes the verified records it read from the Recipe Master metaobjects and the live catalogue. The kernel returns quote-contract v1 lines for the `dish_to_cart` door.

1. **It validates every client input.**
   - Recipe ids must be known.
   - Servings must be a whole number from 1 to the policy maximum.
   - Each recipe can appear only once.
   - Each option group needs exactly one valid choice (for example goat | beef | lamb).
   - Only items marked as pantry items can be left out.
2. **It uses only verified, active records.** That covers the recipe, each ingredient line, each unit and each scaling profile. A missing volume-to-gram conversion fails the quote. So do an unknown quantity basis, a missing price and an unapproved pack profile.
3. **It scales each ingredient.**
   - `Linear` and `Fixed` scaling are allowed by policy. `Capped` is supported but not enabled.
   - `Power Curve` (Needs Review, and it gives irrational factors) is refused, and so is `Piecewise` (inactive).
   - Min/max quantities are applied, then the result is converted to grams or pieces.
   - An **edible** quantity is converted to purchase weight using the ingredient's verified yield.
4. **It aggregates before pricing** (contract §1.4). Quantities are summed per ingredient across all chosen recipes, then **rounded up once** to a whole gram or piece. No forced extras: the customer gets the exact quantity.
5. **It prices** with the owner-approved ASB Pack Intelligence method (PCK profiles, 4 Oct 2026):
   - Start from the price of the verified live pack **nearest** the needed quantity. On a tie, use the larger pack.
   - Prorate that price to the needed quantity. Add **20%** only when the need is smaller than that pack.
   - Round to the nearest whole rupee.
   - **The price is never above a whole live pack that already covers the need.** For example, 120 g must not cost more than the 125 g pack.
6. **It emits one line per product**, following contract §4:
   - `quantity: 1`, with `priceSet` set to the whole line price.
   - The title is, for example, `Adrak — 40 g (Dish-to-Cart)`.
   - Properties carry the door, line id, canonical product, unit, qty, recipe ids and ceiling.
   - `provenance.recipeIds` is set by the server. The line price is also its line ceiling.

All arithmetic uses exact BigInt rationals. If anything fails, the whole quote returns no lines.

## Example (live catalogue prices, 5 Nov)

| Need | Reference pack | Price |
|---|---|---|
| Ginger 40 g | 125 g @ Rs 87 | 87 × 40/125 × 1.20 = Rs 33.41 → **Rs 33** |
| Ginger 63 g (40 g + 22.5 g from two recipes) | 125 g @ Rs 87 | 87 × 63/125 × 1.20 = Rs 52.62 → **Rs 53** |
| Onion 600 g | 500 g @ Rs 105 | 105 × 600/500 = **Rs 126**, with no markup |
| Ginger 120 g | 125 g @ Rs 87 | Rs 100.22 would exceed the pack, so **Rs 87** |

## Decisions for the founder

1. **Exact grams versus the pack ladder.** The quote contract (5 Nov) says exact quantities with no forced extras. The PCK profiles' *selection rule* (4 Oct) says "choose the smallest ASB pack ≥ the total". The kernel follows the contract (exact) and uses the PCK **pricing** method. Please confirm.
2. **Rounding.** PCK rounds each line to the nearest rupee, so a line can round up by as much as 49 paisa. R2's order-level floor then gives no paisa credit. Is nearest-rupee per Dish line acceptable, or should Dish lines round down?
3. **Small-pack premium on top of a small pack.** Adrak 125 g is already Rs 0.70/g, against Rs 0.58/g for the 250 g pack. The 20% premium is added on top of that 125 g price. Is that intended?
4. **Who verifies the recipes, and which 20 go first?** As of 5 Nov the Recipe Master holds 152 recipes, and the sampled ingredient lines are `Needs Review`. The kernel will refuse every one of them until they are verified.

## Not in this PR

- An adapter that reads Recipe Master metaobjects and live variants into the kernel's input shape, using read-only Admin GraphQL.
- Persisting Dish quotes and redeeming them (contract §5).
- Dish-door Community eligibility. `heroTier` is null here.
- Packing and billing for exact-weight lines. PR #11's line ceiling already caps them.
