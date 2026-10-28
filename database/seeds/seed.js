#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== '1') {
  console.error('[seed] Refusing to run in production (sets known demo passwords/PINs).');
  console.error('[seed] For a controlled seed set ALLOW_DEMO_SEED=1 (never on a live customer DB).');
  process.exit(1);
}

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://cravedash:cravedash@localhost:5432/cravedash';

const RESTAURANT_ID = 'r1';
const DEMO_PASSWORD = 'demo12345';

const ALLERGENS = [
  'celery', 'gluten', 'crustaceans', 'eggs', 'fish', 'lupin', 'milk', 'molluscs',
  'mustard', 'peanuts', 'sesame', 'soy', 'sulphites', 'tree_nuts',
];

const UNIFORM_CAT = { colour: '#0b84f3', text_colour: '#ffffff' };

const EMOJI = {
  Burger: '🍔', 'Beef Burger': '🍔', Wraps: '🌯', 'Piri Piri Chicken': '🍗',
  'PORTO FAVOURITES': '⭐', 'RICE BOX': '🍚', 'BOX MEALS': '🍱', 'PORTO KEBABS': '🥙',
  QUESADILLA: '🌮', SIDES: '🍟', DRINKS: '🥤', BURRITO: '🌯', PLATTERS: '🍗', DIPS: '🥣',
  'KIDS MEAL': '🧒', DESSERTS: '🍩', MILKSHAKES: '🥤', 'ICE CREAM': '🍨', Pakoras: '🧅', Extras: '🧀',
};

function loadPortoSeed() {
  const candidates = [
    path.join(__dirname, 'porto-seed.js'),
    path.join(__dirname, '../../../cravedash-hostinger-v18/assets/js/seed-porto.js'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) throw new Error('porto-seed.js archive not found');
  const src = fs.readFileSync(file, 'utf8');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  if (!sandbox.window.PORTO_SEED) throw new Error('PORTO_SEED missing in porto-seed.js');
  return sandbox.window.PORTO_SEED;
}

function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(r, arr) {
  return arr[Math.floor(r() * arr.length)];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function effectivePrice(p) {
  if (p.price > 0) return p.price;
  const g = (p.variations || []).find(
    (v) => v.type === 'single' && v.values.some((x) => x.price > 0),
  );
  return g
    ? Math.min(...g.values.map((x) => x.price).filter((x) => x > 0))
    : 0;
}

function buildCatalogue(S) {
  const r = rng(4242);
  const categories = S.categories.map((c, i) => ({
    id: 'cat' + (i + 1),
    num: i + 1,
    name: c.name,
    image: c.image,
    colour: UNIFORM_CAT.colour,
    text_colour: UNIFORM_CAT.text_colour,
    priority: i + 1,
    status: true,
  }));
  const subcategories = S.subcategories.map((s, i) => {
    const parent = categories.find((c) => c.name === s[0]);
    return {
      id: 'sub' + (i + 1),
      parent_id: parent.id,
      name: s[1],
      colour: parent.colour,
      inherit_colour: true,
      status: true,
    };
  });
  const products = S.products.map((p) => {
    const cat = categories.find((c) => c.name === p.category) || categories[0];
    const subs = subcategories.filter((s) => s.parent_id === cat.id);
    const allergens = {};
    ALLERGENS.forEach((a) => {
      allergens[a] = '';
    });
    if (r() < 0.05) ALLERGENS.forEach((a) => { allergens[a] = 'free'; });
    return {
      id: p.id,
      live_id: p.live_id,
      name: p.name,
      description: p.description,
      category_id: cat.id,
      sub_category_id:
        subs.length && /Double/.test(p.name)
          ? subs[0].id
          : subs.length && cat.name === 'Burger'
            ? subs[1].id
            : null,
      price: p.price,
      from_price: effectivePrice(p),
      img: EMOJI[cat.name] || '🍽️',
      image: p.image,
      has_image: true,
      variations: p.variations,
      addon_ids: p.addons,
      item_type: /Box|Platter|Meal/.test(p.name) ? 'set_menu' : 'product',
      product_type: p.veg ? 'veg' : 'nonveg',
      halal: true,
      age_restricted: /Energy|Monster/.test(p.name),
      discount_type: 'percent',
      discount: 0,
      tax_type: 'percent',
      tax: 0,
      tax_class: /DRINKS/.test(cat.name)
        ? 'SOFT_DRINK'
        : /MILKSHAKES/.test(cat.name)
          ? 'COLD_FOOD'
          : /ICE CREAM|DESSERTS/.test(cat.name)
            ? 'ICE_CREAM'
            : 'HOT_FOOD',
      served_hot: /DRINKS|MILKSHAKES|ICE CREAM|DIPS/.test(cat.name) ? 'no' : 'yes',
      allergens,
      stock_type: 'unlimited',
      product_stock: 0,
      stock: true,
      status: true,
      visible: true,
      available_from: '11:00',
      available_till: '23:30',
      tags: [],
      recommended: r() < 0.15,
      cuisines: ['Fast Food'],
      total_sale: Math.floor(r() * 40),
      rating: +(3.5 + r() * 1.5).toFixed(1),
    };
  });
  const cuisines = S.cuisines.map((c, i) => ({
    id: 'cu' + (i + 1),
    name: c,
    sub_title: '',
    status: i < 1,
    priority: i + 1,
  }));
  return { categories, subcategories, products, addons: S.addons, cuisines };
}

function seedFloor() {
  const areas = [
    { id: 'area1', name: 'Main Hall' },
    { id: 'area2', name: 'Patio' },
    { id: 'area3', name: 'Window' },
  ];
  const t = [
    [1, 'area1', 'square', 2, 1, 1], [2, 'area1', 'square', 2, 3, 1], [3, 'area1', 'round', 4, 5, 1],
    [4, 'area1', 'rect', 6, 7, 1], [5, 'area1', 'round', 4, 1, 3], [6, 'area1', 'rect', 6, 3, 3],
    [7, 'area1', 'square', 4, 6, 3], [8, 'area1', 'rect', 8, 8, 3], [9, 'area2', 'round', 2, 1, 1],
    [10, 'area2', 'round', 2, 3, 1], [11, 'area2', 'square', 4, 5, 1], [12, 'area2', 'rect', 6, 2, 3],
    [13, 'area3', 'square', 2, 1, 1], [14, 'area3', 'square', 2, 1, 3], [15, 'area3', 'square', 2, 1, 5],
  ];
  const tables = t.map((row) => ({
    id: 'T' + row[0],
    number: row[0],
    area_id: row[1],
    shape: row[2],
    seats: row[3],
    pos_x: row[4],
    pos_y: row[5],
    active: true,
    reserved: false,
  }));
  tables[6].reserved = true;
  return { areas, tables };
}

function platformPlans() {
  const plan = (id, name, type, price, maxOrders, desc, features, extra = {}) => ({
    id,
    name,
    plan_type: type,
    description: desc,
    price_monthly: price,
    price_yearly: round2(price * 10),
    duration_days: 30,
    max_orders: maxOrders,
    sort_order: extra.sort_order || 0,
    currency: 'GBP',
    trial_days: 14,
    terminals: extra.terminals ?? 1,
    branches: extra.branches ?? 1,
    commission: extra.commission ?? 1.5,
    features,
    status: true,
    popular: !!extra.popular,
  });
  return [
    plan('plan_starter', 'Starter Plan', 'restaurant', 29.99, 100, 'Perfect for small restaurants getting started', ['EPOS (1 terminal)', 'Online ordering', 'X / Z reports'], { terminals: 1, commission: 2.5, sort_order: 1 }),
    plan('plan_pro', 'Professional Plan', 'restaurant', 79.99, 500, 'For growing restaurants with multiple locations', ['EPOS (3 terminals)', 'Online ordering', 'Table QR ordering', 'Floor plan', 'Full reports'], { terminals: 3, branches: 3, popular: true, sort_order: 2 }),
    plan('plan_enterprise', 'Enterprise Plan', 'restaurant', 199.99, null, 'Unlimited power for large restaurant chains', ['Unlimited orders', 'EPOS (10 terminals)', 'Delivery management', 'Multi-branch', 'Priority support'], { terminals: 10, branches: 10, commission: 1, sort_order: 3 }),
    plan('plan_branch1', 'Single Branch', 'branch', 19.99, 100, 'Add one additional branch to your restaurant', ['+1 branch'], { sort_order: 4 }),
    plan('plan_branch3', 'Branch Pack (3)', 'branch', 49.99, 300, 'Add 3 branches at a discounted rate', ['+3 branches'], { branches: 3, sort_order: 5 }),
    plan('plan_abdullah', 'Abdullah Abdullah', 'restaurant', 200, null, 'Subscription Plan', ['Custom plan'], { terminals: 10, branches: 10, sort_order: 6 }),
    plan('plan_basix', 'BASIX PLAN', 'restaurant', 25, 500, 'TESTING', ['Basic'], { sort_order: 7 }),
  ];
}

function platformRestaurants(now) {
  const names = [
    ['r1', 11, 'Porto Piri Piri', 'Faisal', 'plan_starter', 'active', '2026-05-04', 23, 10, '49 Kilmarnock Road, Shawlands, Glasgow G41 3YN'],
    ['r12', 12, 'Shotts Tandoori', 'Waseem', 'plan_enterprise', 'active', '2026-08-26', 19, 10, 'Shotts, North Lanarkshire'],
    ['r6', 6, 'ZEE GRILL', 'Zahid Mehmood', 'plan_enterprise', 'past_due', '2025-11-08', -2, 2, 'Glasgow'],
    ['r13', 13, 'Vinnies', 'Mr Sukhwinder Singh', 'plan_starter', 'inactive', '2026-09-09', 0, 10, ''],
    ['r14', 14, 'TKR', 'Tahir Khan', 'plan_starter', 'inactive', '2026-09-15', 0, 10, ''],
    ['r15', 15, 'DEMO', 'Waseem', 'plan_basix', 'cancelled', '2026-09-15', 17, 2, ''],
    ['r16', 16, 'Charsi Tikka', 'Tahir Khan', 'plan_starter', 'inactive', '2026-09-15', 0, 10, ''],
  ];
  const r = rng(77);
  return names.map((n, i) => {
    const slug = n[2].toLowerCase().replace(/[^a-z0-9]+/g, '');
    const st = n[5];
    const addDays = (d, days) => {
      const x = new Date(d);
      x.setDate(x.getDate() + days);
      return x;
    };
    return {
      id: n[0],
      live_id: n[1],
      name: n[2],
      slug,
      city: n[9] || 'United Kingdom',
      address: n[9],
      owner_name: n[3],
      email: 'owner@' + slug + '.example',
      phone: '0141 000 ' + String(1000 + i * 111).slice(0, 4),
      timezone: 'Europe/London',
      currency: 'GBP',
      vat_registered: n[0] === 'r1' ? 'yes' : 'no',
      vat_number: n[0] === 'r1' ? 'GB894220190' : '',
      plan_id: n[4],
      billing_cycle: 'monthly',
      sub_status: st === 'past_due' ? 'past_due' : st === 'active' ? 'active' : st === 'cancelled' ? 'canceled' : 'inactive',
      joined_at: new Date(n[6] + 'T12:00:00'),
      expires_at: n[7] ? addDays(now, n[7]) : null,
      branch_count: n[0] === 'r1' ? 1 : 0,
      max_branches: n[8],
      api_key: 'cd_live_' + Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14),
      api_key_status: true,
      status: true,
      next_charge: addDays(now, Math.max(1, n[7] || 30)),
      auto_deduct: st === 'active',
      card_last4: String(4000 + i * 137).slice(0, 4),
      card_brand: pick(r, ['Visa', 'Mastercard']),
      stripe_account: 'acct_1' + Math.random().toString(36).slice(2, 12).toUpperCase(),
      charges_enabled: st === 'active',
      payouts_enabled: st === 'active',
      stripe_balance: st === 'active' ? round2(r() * 2400) : 0,
      modules: {
        pos: st !== 'inactive',
        online: st === 'active' || st === 'past_due',
        table_qr: n[4] !== 'plan_starter' || n[0] === 'r1',
        reports: true,
        delivery: n[4] === 'plan_enterprise',
        multi_branch: n[4] === 'plan_enterprise',
      },
      access_level: st === 'past_due' ? 'restricted' : 'full',
      monthly_gmv: st === 'active' ? round2(6000 + r() * 22000) : 0,
      compliance: n[0] === 'r1'
        ? { vat: 'complete', tax_classes: 'complete', allergens: 'outstanding' }
        : { vat: 'outstanding', tax_classes: 'outstanding', allergens: 'outstanding' },
      branch_list: n[0] === 'r1'
        ? [{ id: 'b0', name: 'Main Branch', address: n[9], phone: '', email: 'owner@portopiripiri.example', type: 'Main', tills_need: 3, tills_give: 3 }]
        : [],
      machinery: {},
      tills_summary: n[0] === 'r1' ? { need: 3, give: 3 } : { need: 0, give: 0 },
      services: 'ALL',
      dash_widgets: 'ALL',
    };
  });
}

function sampleCoupons(now) {
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  return [
    { id: 'cp1', title: 'Summer Sale', code: 'SUMMER10', coupon_type: 'default', discount_type: 'percent', discount: 10, min_purchase: 10, max_discount: 15, usage_limit: 3, starts_at: addDays(now, -20), expires_at: addDays(now, 40), status: true, used_count: 64 },
    { id: 'cp2', title: 'Save a Fiver', code: 'SAVE5', coupon_type: 'default', discount_type: 'amount', discount: 5, min_purchase: 25, max_discount: 5, usage_limit: 1, starts_at: addDays(now, -10), expires_at: addDays(now, 20), status: true, used_count: 31 },
    { id: 'cp3', title: 'Welcome Offer', code: 'WELCOME15', coupon_type: 'first_order', discount_type: 'percent', discount: 15, min_purchase: 0, max_discount: 10, usage_limit: 1, starts_at: addDays(now, -60), expires_at: addDays(now, 120), status: true, used_count: 118 },
    { id: 'cp4', title: 'Free Delivery Friday', code: 'FREEDEL', coupon_type: 'free_delivery', discount_type: 'amount', discount: 0, min_purchase: 15, max_discount: 0, usage_limit: 5, starts_at: addDays(now, -5), expires_at: addDays(now, 60), status: false, used_count: 12 },
  ];
}

function sampleLiveOrders(cat, floor, now) {
  const r = rng(99);
  const live = [
    { source: 'website', type: 'delivery', status: 'pending', mins: 2, pay: 'stripe' },
    { source: 'table_qr', type: 'dine_in', status: 'pending', mins: 5, table: 'T11' },
    { source: 'pos', type: 'dine_in', status: 'cooking', mins: 16, table: 'T3' },
    { source: 'app', type: 'delivery', status: 'out_for_delivery', mins: 28, pay: 'stripe' },
  ];
  const orders = [];
  let id = 100500;
  live.forEach((L) => {
    const when = new Date(now.getTime() - L.mins * 60000);
    const p = pick(r, cat.products);
    const catName = cat.categories.find((c) => c.id === p.category_id)?.name || '';
    const subtotal = round2(p.from_price || p.price);
    const total = subtotal;
    orders.push({
      id: String(id++),
      created_at: when,
      source: L.source,
      order_type: L.type,
      status: L.status,
      payment_status: L.pay === 'stripe' ? 'paid' : 'unpaid',
      payment_method: L.pay || 'cash',
      table_id: L.table || null,
      guests: L.table ? 2 : 0,
      subtotal,
      discount: 0,
      total,
      items: [{
        id: 'oi_' + id,
        product_id: p.id,
        name: p.name,
        category: catName,
        qty: 1,
        price: subtotal,
        variation: null,
        addons: [],
      }],
      history: [
        { status: 'pending', at: when, by: L.source === 'pos' ? 'EPOS' : 'Customer' },
      ],
    });
  });
  return orders;
}

async function upsert(client, sql, params) {
  await client.query(sql, params);
}

async function main() {
  const porto = loadPortoSeed();
  const cat = buildCatalogue(porto);
  const floor = seedFloor();
  const now = new Date();
  const plans = platformPlans();
  const restaurants = platformRestaurants(now);
  const coupons = sampleCoupons(now);
  const orders = sampleLiveOrders(cat, floor, now);

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const pinHash = async (pin) => bcrypt.hash(pin, 10);

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');

    for (const p of plans) {
      await upsert(
        client,
        `INSERT INTO subscription_plans (
          id, name, plan_type, description, price_monthly, price_yearly, duration_days, max_orders,
          sort_order, currency, trial_days, terminals, branches, commission, features, status, popular
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, price_monthly=EXCLUDED.price_monthly`,
        [
          p.id, p.name, p.plan_type, p.description, p.price_monthly, p.price_yearly, p.duration_days,
          p.max_orders, p.sort_order, p.currency, p.trial_days, p.terminals, p.branches, p.commission,
          JSON.stringify(p.features), p.status, p.popular,
        ],
      );
    }

    for (const rs of restaurants) {
      await upsert(
        client,
        `INSERT INTO restaurants (
          id, live_id, name, slug, city, address, owner_name, email, phone, timezone, currency,
          vat_registered, vat_number, plan_id, billing_cycle, sub_status, joined_at, expires_at,
          branch_count, max_branches, api_key, api_key_status, status, next_charge, auto_deduct,
          card_last4, card_brand, stripe_account, charges_enabled, payouts_enabled, stripe_balance,
          modules, access_level, monthly_gmv, compliance, branch_list, machinery, tills_summary,
          services, dash_widgets
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
          $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40
        ) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, plan_id=EXCLUDED.plan_id, sub_status=EXCLUDED.sub_status`,
        [
          rs.id, rs.live_id, rs.name, rs.slug, rs.city, rs.address, rs.owner_name, rs.email, rs.phone,
          rs.timezone, rs.currency, rs.vat_registered, rs.vat_number, rs.plan_id, rs.billing_cycle,
          rs.sub_status, rs.joined_at, rs.expires_at, rs.branch_count, rs.max_branches, rs.api_key,
          rs.api_key_status, rs.status, rs.next_charge, rs.auto_deduct, rs.card_last4, rs.card_brand,
          rs.stripe_account, rs.charges_enabled, rs.payouts_enabled, rs.stripe_balance,
          JSON.stringify(rs.modules), rs.access_level, rs.monthly_gmv, JSON.stringify(rs.compliance),
          JSON.stringify(rs.branch_list), JSON.stringify(rs.machinery), JSON.stringify(rs.tills_summary),
          rs.services, rs.dash_widgets,
        ],
      );
    }

    const users = [
      { id: 'u_super', email: 'owner@cravedash.co.uk', name: 'Platform Owner', role: 'super_admin', restaurant_id: null, permissions: 'ALL' },
      { id: 'ra1', email: 'owner@portopiripiri.example', name: 'Faisal', role: 'restaurant_admin', restaurant_id: RESTAURANT_ID, permissions: 'ALL' },
      { id: 'ru2', email: 'manager@portopiripiri.example', name: 'Ayaan', role: 'employee', restaurant_id: RESTAURANT_ID, permissions: null },
    ];
    for (const u of users) {
      await upsert(
        client,
        `INSERT INTO users (id, email, password_hash, name, role, permissions, restaurant_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
         ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, name=EXCLUDED.name, role=EXCLUDED.role`,
        [
          u.id, u.email, passwordHash, u.name, u.role,
          u.permissions === 'ALL' ? JSON.stringify('ALL') : u.permissions ? JSON.stringify(u.permissions) : null,
          u.restaurant_id,
        ],
      );
    }

    await upsert(
      client,
      `INSERT INTO branches (id, restaurant_id, name, address, email, branch_type, tills_need, tills_give)
       VALUES ('b0', $1, 'Main Branch', '49 Kilmarnock Road, Shawlands, Glasgow G41 3YN', 'owner@portopiripiri.example', 'Main', 3, 3)
       ON CONFLICT (id) DO NOTHING`,
      [RESTAURANT_ID],
    );

    const tills = [
      { id: 'till-1', name: 'Till 1 — Front counter', calls: true },
      { id: 'till-2', name: 'Till 2 — Collection point', calls: true },
      { id: 'till-3', name: 'Till 3 — Kitchen pass', calls: false },
    ];
    for (const t of tills) {
      await upsert(
        client,
        `INSERT INTO tills (id, restaurant_id, branch_id, name, calls)
         VALUES ($1,$2,'b0',$3,$4) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
        [t.id, RESTAURANT_ID, t.name, t.calls],
      );
    }

    const staff = [
      { id: 's_alex', name: 'Alex Khan', role: 'Manager', pin: '1234', color: '#0b84f3', can_approve: true },
      { id: 's_sarah', name: 'Sarah Johnson', role: 'Supervisor', pin: '2345', color: '#1d4ed8', can_approve: true },
      { id: 's_maria', name: 'Maria Clarke', role: 'Server', pin: '3456', color: '#ea580c', can_approve: false },
      { id: 's_john', name: 'John Smith', role: 'Kitchen Staff', pin: '4567', color: '#7c3aed', can_approve: false },
    ];
    for (const s of staff) {
      await upsert(
        client,
        `INSERT INTO till_staff (id, restaurant_id, name, role, pin_hash, color, active, can_approve)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7)
         ON CONFLICT (id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash, name=EXCLUDED.name`,
        [s.id, RESTAURANT_ID, s.name, s.role, await pinHash(s.pin), s.color, s.can_approve],
      );
    }

    for (const a of floor.areas) {
      await upsert(
        client,
        `INSERT INTO areas (id, restaurant_id, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
        [a.id, RESTAURANT_ID, a.name],
      );
    }
    for (const tbl of floor.tables) {
      await upsert(
        client,
        `INSERT INTO restaurant_tables (id, restaurant_id, area_id, number, shape, seats, pos_x, pos_y, active, reserved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET reserved=EXCLUDED.reserved`,
        [tbl.id, RESTAURANT_ID, tbl.area_id, tbl.number, tbl.shape, tbl.seats, tbl.pos_x, tbl.pos_y, tbl.active, tbl.reserved],
      );
    }

    for (const c of cat.categories) {
      await upsert(
        client,
        `INSERT INTO categories (id, restaurant_id, num, name, image, colour, text_colour, priority, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
        [c.id, RESTAURANT_ID, c.num, c.name, c.image, c.colour, c.text_colour, c.priority, c.status],
      );
    }
    for (const s of cat.subcategories) {
      await upsert(
        client,
        `INSERT INTO subcategories (id, restaurant_id, parent_id, name, colour, inherit_colour, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [s.id, RESTAURANT_ID, s.parent_id, s.name, s.colour, s.inherit_colour, s.status],
      );
    }
    for (const a of cat.addons) {
      await upsert(
        client,
        `INSERT INTO addons (id, restaurant_id, name, price, tax, status)
         VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (id) DO NOTHING`,
        [a.id, RESTAURANT_ID, a.name, a.price, a.tax],
      );
    }
    for (const cu of cat.cuisines) {
      await upsert(
        client,
        `INSERT INTO cuisines (id, restaurant_id, name, sub_title, status, priority)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [cu.id, RESTAURANT_ID, cu.name, cu.sub_title, cu.status, cu.priority],
      );
    }
    for (const p of cat.products) {
      await upsert(
        client,
        `INSERT INTO products (
          id, restaurant_id, live_id, name, description, category_id, sub_category_id, price, from_price,
          img, image, has_image, variations, addon_ids, item_type, product_type, halal, age_restricted,
          discount_type, discount, tax_type, tax, tax_class, served_hot, allergens, stock_type, product_stock,
          stock, status, visible, available_from, available_till, tags, recommended, cuisines, total_sale, rating
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37
        ) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, price=EXCLUDED.price, variations=EXCLUDED.variations`,
        [
          p.id, RESTAURANT_ID, p.live_id, p.name, p.description, p.category_id, p.sub_category_id,
          p.price, p.from_price, p.img, p.image, p.has_image, JSON.stringify(p.variations),
          JSON.stringify(p.addon_ids), p.item_type, p.product_type, p.halal, p.age_restricted,
          p.discount_type, p.discount, p.tax_type, p.tax, p.tax_class, p.served_hot,
          JSON.stringify(p.allergens), p.stock_type, p.product_stock, p.stock, p.status, p.visible,
          p.available_from, p.available_till, JSON.stringify(p.tags), p.recommended,
          JSON.stringify(p.cuisines), p.total_sale, p.rating,
        ],
      );
    }

    for (const cp of coupons) {
      await upsert(
        client,
        `INSERT INTO coupons (
          id, restaurant_id, title, code, coupon_type, discount_type, discount, min_purchase, max_discount,
          usage_limit, used_count, starts_at, expires_at, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code`,
        [
          cp.id, RESTAURANT_ID, cp.title, cp.code, cp.coupon_type, cp.discount_type, cp.discount,
          cp.min_purchase, cp.max_discount, cp.usage_limit, cp.used_count, cp.starts_at, cp.expires_at, cp.status,
        ],
      );
    }

    await upsert(
      client,
      `INSERT INTO settings (restaurant_id, key, value) VALUES ($1,'general',$2)
       ON CONFLICT (restaurant_id, key) DO UPDATE SET value=EXCLUDED.value`,
      [
        RESTAURANT_ID,
        JSON.stringify({
          vat_rate: 20,
          vat_inclusive: true,
          currency: '£',
          restaurant_name: 'Porto Piri Piri',
          address: '49 Kilmarnock Road, Shawlands, Glasgow G41 3YN',
          vat_no: 'GB 894 220 19',
          auto_accept_pos: true,
          new_order_sound: true,
        }),
      ],
    );

    await upsert(
      client,
      `INSERT INTO menu_presentation (restaurant_id, config) VALUES ($1,$2)
       ON CONFLICT (restaurant_id) DO UPDATE SET config=EXCLUDED.config`,
      [
        RESTAURANT_ID,
        JSON.stringify({
          enabled: true,
          mode: 'image',
          missing_policy: 'text_card',
          density: 'comfortable',
          channels: { web: 'inherit', app: 'inherit', pos: 'inherit' },
          website_view: 'image',
          website_url: '',
          confirmed_image: true,
        }),
      ],
    );

    await upsert(
      client,
      `INSERT INTO platform_settings (id, stripe, access_policy, platform_terms)
       VALUES ('platform',$1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET stripe=EXCLUDED.stripe, access_policy=EXCLUDED.access_policy`,
      [
        JSON.stringify({ mode: 'test', app_fee_percent: 1.5, statement_descriptor: 'CRAVEDASH' }),
        JSON.stringify({
          grace_days: 3, restrict_after: 7, suspend_after: 21,
          restricted_modules: ['online', 'table_qr'], notify_owner: true, auto_retry: true, retry_days: [1, 3, 5],
        }),
        JSON.stringify({ version: '2.3', require_reaccept: true, allow_restaurant_terms: true }),
      ],
    );

    for (const o of orders) {
      await upsert(
        client,
        `INSERT INTO orders (
          id, restaurant_id, branch_name, source, order_type, status, payment_status, payment_method,
          table_id, guests, subtotal, discount, total, created_at
        ) VALUES ($1,$2,'Main Branch',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (id) DO NOTHING`,
        [
          o.id, RESTAURANT_ID, o.source, o.order_type, o.status, o.payment_status, o.payment_method,
          o.table_id, o.guests, o.subtotal, o.discount, o.total, o.created_at,
        ],
      );
      for (const it of o.items) {
        await upsert(
          client,
          `INSERT INTO order_items (id, order_id, product_id, name, category, qty, price, variation, addons)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [it.id, o.id, it.product_id, it.name, it.category, it.qty, it.price, it.variation, JSON.stringify(it.addons)],
        );
      }
      for (const h of o.history) {
        await client.query(
          `INSERT INTO order_history (order_id, status, changed_at, changed_by) VALUES ($1,$2,$3,$4)`,
          [o.id, h.status, h.at, h.by],
        );
      }
    }

    await client.query('COMMIT');
    console.log('Seed complete.');
    console.log('  Users: owner@cravedash.co.uk, owner@portopiripiri.example, manager@portopiripiri.example');
    console.log('  Password:', DEMO_PASSWORD);
    console.log('  Till PINs (hash stored): 1234, 2345, 3456, 4567');
    console.log('  Products:', cat.products.length, '| Tables:', floor.tables.length);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
