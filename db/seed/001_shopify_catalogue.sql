-- ============================================================================
-- ASB PIPELINE — seed 001: product catalogue, imported from Shopify
--
-- Shopify is the source of truth for the catalogue. This file is a snapshot of
-- the 49 ACTIVE products in apnasastabazaar.com, keyed on shopify_variant_id.
--
-- WHY THIS EXISTS
-- server.js -> resolveProduct() matches an incoming Shopify line item on
-- shopify_variant_id, then sku, and if neither hits it invents a stub product
-- named 'SHOPIFY-47836797862146'. Every order so far has produced stubs: no
-- unit, no Urdu name, no place in the price book. A bill built on stubs is a
-- bill with improvised line items. This file is what stops that.
--
-- IDEMPOTENT. Safe to re-run after adding products in Shopify.
--   * New variant          -> inserted.
--   * Existing variant     -> names/unit/image refreshed in place, so the
--                             product_id stays stable and ALREADY-PLACED
--                             ORDERS KEEP POINTING AT THE RIGHT ROW.
--   * Existing STUB row    -> its 'SHOPIFY-xxxx' sku is replaced with the real
--                             one. A real sku is never overwritten.
--
-- PRICES ARE DELIBERATELY NOT HERE. products has no price column by design:
-- the ceiling is per-cycle and lives in cycle_prices. Shopify's current prices
-- are recorded in the comment block at the foot of this file so the cycle price
-- book can be built from them in the next step.
--
--   psql "$DATABASE_URL" -f db/seed/001_shopify_catalogue.sql
-- ============================================================================

BEGIN;

INSERT INTO products (
  sku, name_en, name_ur, name_roman, category,
  unit, step_qty, min_qty, is_weighed,
  shopify_product_id, shopify_variant_id, image_url,
  sort_order, is_active, market_price
) VALUES
  ('ASB-VEG-001', 'Potato', 'آلو', 'Aloo', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9280520978690', '47322500333826', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-sasa-46443328-31514958.jpg?v=1785216256', 10, TRUE, 60.00),
  ('ASB-VEG-002', 'Onions', 'تازہ پیاز', 'Piyaz', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9280522322178', '47322505052418', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-shaddam-hossain-3417842-38088072.jpg?v=1784807033', 20, TRUE, 300.00),
  ('ASB-V000049', 'Tomatoes', 'ٹماٹر', 'Tamatar', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418086220034', '47836668559618', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-vishnu-gopal-646199292-29479888.jpg?v=1784807397', 30, TRUE, 350.00),
  ('ASB-VEG-004', 'Ginger', 'ادرک', 'Adrak', 'sabziyaan', 'g', 250.000, 250.000, TRUE, '9418086252802', '47836668592386', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-ian-panelo-20234958.jpg?v=1785136059', 40, TRUE, 150.00),
  ('ASB-VEG-005', 'Garlic', 'لہسن', 'Lehsan', 'sabziyaan', 'g', 250.000, 250.000, TRUE, '9418087137538', '47849618473218', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/IMG_20260130_172717.jpg?v=1779712045', 50, TRUE, 120.00),
  ('ASB-VEG-006', 'Coriander', 'ہرا دھنیا', 'Hara Dhaniya', 'sabziyaan', 'bundle', 1.000, 1.000, FALSE, '9418087203074', '47836675408130', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-deepak-kumar-419901784-15097308.jpg?v=1785131692', 60, TRUE, 25.00),
  ('ASB-VEG-007', 'Mint', 'پودینہ', 'Podina', 'sabziyaan', 'bundle', 1.000, 1.000, FALSE, '9418087268610', '47836675473666', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-brahim-laksir-619363668-32756463.jpg?v=1785131343', 70, TRUE, 30.00),
  ('ASB-VEG-008', 'Lemons', 'لیموں', 'Limu', 'sabziyaan', 'g', 250.000, 250.000, TRUE, '9418087334146', '47836675539202', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-ibtassim2022-35986546.jpg?v=1782013292', 80, TRUE, 95.00),
  ('ASB-VEG-009', 'Fresh Cucumber', 'تازہ کھیرا', 'Kheera', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418087399682', '47836675604738', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-victorino-36938978.jpg?v=1784989945', 90, TRUE, 230.00),
  ('ASB-VEG-010', 'Fresh Carrots', 'تازہ گاجر', 'Gajar', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418135732482', '47836777906434', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/daniel-dan-WJCt0edtQgI-unsplash.jpg?v=1779712318', 100, TRUE, 200.00),
  ('ASB-VEG-011', 'Fresh Spinach', 'تازہ پالک', 'Palak', 'sabziyaan', 'g', 500.000, 500.000, TRUE, '9418136649986', '47836779774210', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-enginakyurt-38571502.jpg?v=1784988896', 110, TRUE, 100.00),
  ('ASB-VEG-012', 'Fresh Cabbage', 'تازہ بند گوبھی', 'Band Gobhi', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418137043202', '47836780527874', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-arina-krasnikova-6316537.jpg?v=1784988356', 120, TRUE, 140.00),
  ('ASB-VEG-013', 'Fresh Cauliflower', 'تازہ پھول گوبھی', 'Phool Gobhi', 'sabziyaan', 'g', 500.000, 500.000, TRUE, '9418137501954', '47836781445378', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/rn-image_picker_lib_temp_6809bd85-20e9-4782-91ef-a733e9cd3215.jpg?v=1779717552', 130, TRUE, 100.00),
  ('ASB-VEG-014', 'Fresh Green Capsicum', 'تازہ ہری شملہ مرچ', 'Hari Shimla Mirch', 'sabziyaan', 'g', 250.000, 250.000, TRUE, '9418137895170', '47836782199042', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-victorino-36935461_1.jpg?v=1782008904', 140, TRUE, 115.00),
  ('ASB-VEG-015', 'Fresh Okra', 'تازہ بھنڈی', 'Bhindi', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418138255618', '47836782919938', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/rn-image_picker_lib_temp_eeea3dac-a8aa-4f87-94c0-fa6267d9d4f6.jpg?v=1779716633', 150, TRUE, 200.00),
  ('ASB-VEG-016', 'Fresh Eggplant', 'تازہ بینگن', 'Baingan', 'sabziyaan', 'g', 500.000, 500.000, TRUE, '9418138648834', '47836783771906', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/rn-image_picker_lib_temp_a59d4b7a-5724-4dfb-9a76-ba7bbf39fea1.jpg?v=1779720735', 160, TRUE, 95.00),
  ('ASB-VEG-017', 'Fresh Bitter Gourd', 'تازہ کریلے', 'Karela', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418139140354', '47836784689410', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-utpal-38387295-28909474.jpg?v=1784808259', 170, TRUE, 220.00),
  ('ASB-VEG-018', 'Fresh Ridge Gourd', 'تازہ توری', 'Tori', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418139631874', '47836786524418', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-shaddam-hossain-3417842-38365259.jpg?v=1784988232', 180, TRUE, 140.00),
  ('ASB-VEG-019', 'Fresh Bottle Gourd', 'تازہ لوکی', 'Lauki', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418140057858', '47836787409154', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-abdus-salam-1835604653-33211277.jpg?v=1784984629', 190, TRUE, 200.00),
  ('ASB-VEG-020', 'Green Beans', 'پھلیاں', 'Phaliyan', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418140418306', '47836788064514', NULL, 200, FALSE, NULL),
  ('ASB-VEG-021', 'Fresh Pumpkin', 'تازہ کدو', 'Kaddu', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418140778754', '47836788818178', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-momo-s-189553245-28881582.jpg?v=1784810678', 210, TRUE, 150.00),
  ('ASB-VEG-022', 'Fresh Apple Gourd', 'تازہ ٹنڈے', 'Tinday', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418141237506', '47836789866754', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-vurzie-kim-325095862-37223737.jpg?v=1785149872', 220, TRUE, 160.00),
  ('ASB-VEG-023', 'Fresh Taro Root', 'تازہ اروی', 'Arvi', 'sabziyaan', 'g', 500.000, 500.000, TRUE, '9418141630722', '47836790587650', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/buymeacoffee-taro-6850893_1920.jpg?v=1784807759', 230, TRUE, 95.00),
  ('ASB-VEG-024', 'Peas', 'مٹر', 'Matar', 'sabziyaan', 'g', 500.000, 500.000, TRUE, '9418142384386', '47836792127746', NULL, 240, TRUE, 200.00),
  ('ASB-VEG-025', 'Fresh Spring Onion', 'تازہ ہری پیاز', 'Hari Piyaz', 'sabziyaan', 'g', 250.000, 250.000, TRUE, '9418142941442', '47836793241858', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-ivan-drazic-20457695-15865838.jpg?v=1784959580', 250, TRUE, 90.00),
  ('ASB-VEG-026', 'Mushroom', 'کھمبی', 'Khumbi', 'sabziyaan', 'packet', 1.000, 1.000, FALSE, '9418143793410', '47836795011330', NULL, 260, FALSE, NULL),
  ('ASB-VEG-027', 'Fresh Sweet Potato', 'تازہ شکرقندی', 'Shakarqandi', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418144186626', '47836795830530', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-nc-farm-bureau-mark-2797395.jpg?v=1784805864', 270, TRUE, 250.00),
  ('ASB-VEG-028', 'Turnip', 'شلجم', 'Shaljam', 'sabziyaan', 'kg', 1.000, 1.000, TRUE, '9418144612610', '47836796616962', NULL, 280, FALSE, NULL),
  ('ASB-V000002', 'Yellow Capsicum', 'پیلی شملہ مرچ', 'Peeli Shimla Mirch', 'sabziyaan', 'g', 250.000, 250.000, TRUE, '9468174696706', '48028810608898', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-planka-28768295.jpg?v=1782010274', 290, TRUE, 350.00),
  ('ASB-FRT-001', 'Chaunsa Mango', 'چونسہ آم', 'Chaunsa Aam', 'phal', 'kg', 1.000, 1.000, TRUE, '9418145202434', '47836797862146', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-praveen-dandin-2148634378-37816783_2.jpg?v=1784805046', 300, TRUE, 350.00),
  ('ASB-FRT-002', 'Fresh Banana', 'تازہ کیلے', 'Kela', 'phal', 'dozen', 1.000, 1.000, FALSE, '9418145235202', '47836797894914', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-robber-rb-659106006-30873714.jpg?v=1784803361', 310, TRUE, 190.00),
  ('ASB-FRT-003', 'Fresh Green Apple', 'تازہ سبز سیب', 'Sabz Saib', 'phal', 'kg', 1.000, 1.000, TRUE, '9418145333506', '47836798157058', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-aruna-dunusinghe-2152908721-38550400.jpg?v=1784800838', 320, TRUE, 290.00),
  ('ASB-FRT-004', 'Kinnow', 'کینو', 'Kinnow', 'phal', 'dozen', 1.000, 1.000, FALSE, '9418145431810', '47836798353666', NULL, 330, FALSE, NULL),
  ('ASB-FRT-005', 'Pomegranate', 'انار', 'Anar', 'phal', 'kg', 1.000, 1.000, TRUE, '9418145497346', '47836798484738', NULL, 340, FALSE, NULL),
  ('ASB-FRT-006', 'Fresh Grapes', 'تازہ انگور', 'Angoor', 'phal', 'g', 500.000, 500.000, TRUE, '9418145562882', '47836798583042', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/couleur-grapes-2656259_1920.jpg?v=1784800427', 350, TRUE, 320.00),
  ('ASB-FRT-007', 'Watermelon', 'تربوز', 'Tarbooz', 'phal', 'pcs', 1.000, 1.000, FALSE, '9418145595650', '47836798615810', NULL, 360, FALSE, NULL),
  ('ASB-FRT-008', 'Melon', 'خربوزہ', 'Kharbooza', 'phal', 'pcs', 1.000, 1.000, FALSE, '9418145661186', '47836798746882', NULL, 370, FALSE, NULL),
  ('ASB-FRT-009', 'Pineapple', 'انناس', 'Ananas', 'phal', 'pcs', 1.000, 1.000, FALSE, '9418145759490', '47836798877954', NULL, 380, FALSE, NULL),
  ('ASB-FRT-010', 'Fresh Papaya', 'تازہ پپیتہ', 'Papita', 'phal', 'pcs', 1.000, 1.000, FALSE, '9418145890562', '47836799041794', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/rn-image_picker_lib_temp_7d0a8558-ea6d-4784-b381-fe83dc91af2b.jpg?v=1779714753', 390, TRUE, 250.00),
  ('ASB-FRT-011', 'Fresh Plum', 'تازہ آلو بخارہ', 'Aloo Bukhara', 'phal', 'kg', 1.000, 1.000, TRUE, '9418146087170', '47836799303938', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-lorete-m-511517246-17964695_1.jpg?v=1784797265', 400, TRUE, 320.00),
  ('ASB-FRT-012', 'Fresh Apricot', 'تازہ خوبانی', 'Khubani', 'phal', 'g', 500.000, 500.000, TRUE, '9418146152706', '47836799402242', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-melek-38471344.jpg?v=1784796235', 410, TRUE, 260.00),
  ('ASB-FRT-013', 'Fresh Peach', 'تازہ آڑو', 'Aaru', 'phal', 'kg', 1.000, 1.000, TRUE, '9418146218242', '47836799500546', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-andromeda99-11063842.jpg?v=1784795231', 420, TRUE, 350.00),
  ('ASB-FRT-014', 'Guava', 'امرود', 'Amrood', 'phal', 'kg', 1.000, 1.000, TRUE, '9418146251010', '47836799533314', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/apna-sasta-bazaar-fresh-guava-amrood-close-up-jpg.jpg?v=1785247560', 430, FALSE, NULL),
  ('ASB-FRT-015', 'Fresh Falsa', 'فالسہ', 'Falsa', 'phal', 'g', 250.000, 250.000, TRUE, '9418146316546', '47836799664386', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/falsaspecial.jpg?v=1782014715', 440, FALSE, NULL),
  ('ASB-FRT-016', 'Java Plum', 'جامن', 'Jamun', 'phal', 'g', 250.000, 250.000, TRUE, '9418146349314', '47836799697154', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-aboodi-17975551.jpg?v=1782014218', 450, TRUE, 100.00),
  ('ASB-FRT-017', 'Lychee', 'لیچی', 'Lychee', 'phal', 'kg', 1.000, 1.000, TRUE, '9418146382082', '47836799729922', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-jubersahel-37652213.jpg?v=1785221266', 460, TRUE, 1300.00),
  ('ASB-FRT-018', 'Pear', 'ناشپاتی', 'Nashpati', 'phal', 'kg', 1.000, 1.000, TRUE, '9418146414850', '47836799762690', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-fera-263453090-36991620.jpg?v=1785219624', 470, TRUE, 300.00),
  ('ASB-FRT-019', 'Premium Dates Box', 'کھجور', 'Khajoor', 'phal', 'g', 500.000, 500.000, FALSE, '9418146480386', '47836799893762', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/pexels-freestockpro-12944736.jpg?v=1784793669', 480, TRUE, 800.00),
  ('ASB-KIT-001', 'Ready to Cook Kit — Aloo Gosht (500g Gosht)', 'آلو گوشت کٹ', 'Aloo Gosht Kit', 'kit', 'packet', 1.000, 1.000, FALSE, '9508075438338', '48153378226434', 'https://cdn.shopify.com/s/files/1/0801/0124/5186/files/image.png?v=1784569257', 490, TRUE, 1850.00)
ON CONFLICT (shopify_variant_id) DO UPDATE SET
  -- Repair a stub sku; never clobber a real one.
  sku                = CASE WHEN products.sku LIKE 'SHOPIFY-%'
                            THEN EXCLUDED.sku ELSE products.sku END,
  name_en            = EXCLUDED.name_en,
  name_ur            = EXCLUDED.name_ur,
  name_roman         = EXCLUDED.name_roman,
  category           = EXCLUDED.category,
  unit               = EXCLUDED.unit,
  step_qty           = EXCLUDED.step_qty,
  min_qty            = EXCLUDED.min_qty,
  is_weighed         = EXCLUDED.is_weighed,
  shopify_product_id = EXCLUDED.shopify_product_id,
  image_url          = EXCLUDED.image_url,
  sort_order         = EXCLUDED.sort_order,
  is_active          = EXCLUDED.is_active,
  -- The bazaar rate moves; re-running this file is how it gets refreshed.
  market_price       = EXCLUDED.market_price;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY 1 — nothing should be left as a stub
-- ---------------------------------------------------------------------------
-- SELECT sku, name_en, shopify_variant_id
--   FROM products WHERE sku LIKE 'SHOPIFY-%' ORDER BY sku;
--
-- VERIFY 2 — what got imported, by category
-- ---------------------------------------------------------------------------
-- SELECT category, count(*) FILTER (WHERE is_active) AS active,
--        count(*) FILTER (WHERE NOT is_active)      AS out_of_season
--   FROM products GROUP BY category ORDER BY category;
--
-- VERIFY 3 — existing order lines now resolve to a real product
-- ---------------------------------------------------------------------------
-- SELECT oi.id, p.sku, p.name_en, p.name_ur, oi.unit, oi.qty_ordered
--   FROM order_items oi JOIN products p ON p.id = oi.product_id
--  ORDER BY oi.id DESC LIMIT 20;

-- ---------------------------------------------------------------------------
-- PACK SIZE: two rows are a GUESS, not read from Shopify
--
-- Shopify's title states the pack size for every product except these. The
-- two below are on sale right now, so their guess affects a live bill:
--
--   ASB-VEG-001  Potato آلو     PKR 50   -> 1 kg    CONFIRMED by Waqas 2026-09-24
--   ASB-VEG-024  Peas مٹر       PKR 160  -> 500 g   CORRECTED by Waqas 2026-09-24
--
-- The other size-less titles are all out-of-season rows imported inactive, so
-- their guess cannot reach a customer yet: Green Beans, Mushroom, Turnip,
-- Kinnow, Pomegranate, Watermelon, Melon, Pineapple, Guava.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- SHOPIFY PRICES AT IMPORT (2026-09-24) — for building cycle_prices next.
-- These are Shopify's shelf prices, which act as the CEILING promise.
-- ---------------------------------------------------------------------------
--   ASB-VEG-001   Potato                         1 kg      PKR    50.00
--   ASB-VEG-002   Onions                         1 kg      PKR   210.00
--   ASB-V000049   Tomatoes                       1 kg      PKR   290.00
--   ASB-VEG-004   Ginger                         250 g     PKR   110.00
--   ASB-VEG-005   Garlic                         250 g     PKR    80.00
--   ASB-VEG-006   Coriander                      1 bundle  PKR    15.00
--   ASB-VEG-007   Mint                           1 bundle  PKR    22.00
--   ASB-VEG-008   Lemons                         250 g     PKR    50.00
--   ASB-VEG-009   Fresh Cucumber                 1 kg      PKR   190.00
--   ASB-VEG-010   Fresh Carrots                  1 kg      PKR   140.00
--   ASB-VEG-011   Fresh Spinach                  500 g     PKR    50.00
--   ASB-VEG-012   Fresh Cabbage                  1 kg      PKR   120.00
--   ASB-VEG-013   Fresh Cauliflower              500 g     PKR    60.00
--   ASB-VEG-014   Fresh Green Capsicum           250 g     PKR    80.00
--   ASB-VEG-015   Fresh Okra                     1 kg      PKR   160.00
--   ASB-VEG-016   Fresh Eggplant                 500 g     PKR    70.00
--   ASB-VEG-017   Fresh Bitter Gourd             1 kg      PKR   170.00
--   ASB-VEG-018   Fresh Ridge Gourd              1 kg      PKR   100.00
--   ASB-VEG-019   Fresh Bottle Gourd             1 kg      PKR   140.00
--   ASB-VEG-020   Green Beans                    1 kg      PKR     0.00   (out of season)
--   ASB-VEG-021   Fresh Pumpkin                  1 kg      PKR   110.00
--   ASB-VEG-022   Fresh Apple Gourd              1 kg      PKR   120.00
--   ASB-VEG-023   Fresh Taro Root                500 g     PKR    70.00
--   ASB-VEG-024   Peas                           500 g     PKR   160.00
--   ASB-VEG-025   Fresh Spring Onion             250 g     PKR    50.00
--   ASB-VEG-026   Mushroom                       1 packet  PKR     0.00   (out of season)
--   ASB-VEG-027   Fresh Sweet Potato             1 kg      PKR   180.00
--   ASB-VEG-028   Turnip                         1 kg      PKR     0.00   (out of season)
--   ASB-V000002   Yellow Capsicum                250 g     PKR   220.00
--   ASB-FRT-001   Chaunsa Mango                  1 kg      PKR   250.00
--   ASB-FRT-002   Fresh Banana                   1 dozen   PKR   170.00
--   ASB-FRT-003   Fresh Green Apple              1 kg      PKR   210.00
--   ASB-FRT-004   Kinnow                         1 dozen   PKR     0.00   (out of season)
--   ASB-FRT-005   Pomegranate                    1 kg      PKR     0.00   (out of season)
--   ASB-FRT-006   Fresh Grapes                   500 g     PKR   200.00
--   ASB-FRT-007   Watermelon                     1 pcs     PKR     0.00   (out of season)
--   ASB-FRT-008   Melon                          1 pcs     PKR     0.00   (out of season)
--   ASB-FRT-009   Pineapple                      1 pcs     PKR     0.00   (out of season)
--   ASB-FRT-010   Fresh Papaya                   1 pcs     PKR   180.00
--   ASB-FRT-011   Fresh Plum                     1 kg      PKR   210.00
--   ASB-FRT-012   Fresh Apricot                  500 g     PKR   220.00
--   ASB-FRT-013   Fresh Peach                    1 kg      PKR   250.00
--   ASB-FRT-014   Guava                          1 kg      PKR     0.00   (out of season)
--   ASB-FRT-015   Fresh Falsa                    250 g     PKR     0.00   (out of season)
--   ASB-FRT-016   Java Plum                      250 g     PKR    70.00
--   ASB-FRT-017   Lychee                         1 kg      PKR   900.00
--   ASB-FRT-018   Pear                           1 kg      PKR   240.00
--   ASB-FRT-019   Premium Dates Box              500 g     PKR   650.00
--   ASB-KIT-001   Ready to Cook Kit — Aloo Gosht (500g Gosht) 1 packet  PKR  1499.00
