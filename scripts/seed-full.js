/**
 * Seed demo users (demo12345) + Porto Piri Piri catalogue into scripts/init-db schema.
 */
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const vm = require('vm');

require('dotenv').config({ path: process.env.DOTENV_PATH || path.join(__dirname, '../.env') });
const pool = require('../shared/src/db');

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== '1') {
  console.error('[seed-full] Refusing to run in production (known demo passwords). Set ALLOW_DEMO_SEED=1 to override.');
  process.exit(1);
}

const DEMO_PASSWORD = 'demo12345';
const HASH = null; // filled at runtime

function loadPortoSeed() {
  const candidates = [
    path.join(__dirname, '../database/seeds/porto-seed.js'),
    path.join(__dirname, '../../cravedash-hostinger-v18/assets/js/seed-porto.js'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) {
    console.warn('PORTO_SEED archive not found');
    return null;
  }
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.PORTO_SEED || sandbox.PORTO_SEED;
}

async function upsert(sql, params) {
  await pool.query(sql, params);
}

function defaultModules(planId, isR1 = false) {
  return {
    pos: true,
    online: true,
    table_qr: planId !== 'plan_starter' || isR1,
    reports: true,
    delivery: planId === 'plan_pro' || planId === 'plan_enterprise',
    multi_branch: planId === 'plan_pro' || planId === 'plan_enterprise',
  };
}

function restaurantDataJson(planId, subStatus, opts = {}) {
  const now = new Date();
  const next = new Date(now);
  next.setDate(next.getDate() + 30);
  const expires = new Date(now);
  expires.setDate(expires.getDate() + (opts.expiresDays ?? 23));
  const auto = subStatus === 'active' || subStatus === 'past_due';
  const pay_api =
    opts.pay_api !== undefined
      ? opts.pay_api
      : auto
        ? {
            provider: 'stripe',
            mode: 'test',
            account_id: opts.stripe_account || 'acct_1QPORTODEMO',
            pk: 'pk_test_51QdemoPublishable',
            sk: 'rk_test_51QdemoRestricted',
            connected_at: opts.joined_at || now.toISOString(),
          }
        : null;

  return {
    modules: defaultModules(planId, opts.id === 'r1'),
    access_level: subStatus === 'past_due' ? 'restricted' : subStatus === 'suspended' ? 'suspended' : 'full',
    auto_deduct: !!auto && !!pay_api,
    next_charge: (opts.next_charge || next).toISOString?.() || opts.next_charge || next.toISOString(),
    api_key: opts.api_key || `cd_live_${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 14)}`,
    api_key_status: true,
    billing_cycle: 'monthly',
    expires_at: expires.toISOString(),
    branches: opts.branches ?? (opts.id === 'r1' ? 1 : 0),
    max_branches: opts.max_branches ?? 10,
    pay_api,
    joined_at: opts.joined_at || now.toISOString(),
    card_brand: opts.card_brand || 'Visa',
    card_last4: opts.card_last4 || '4242',
    stripe_account: opts.stripe_account || 'acct_1QPORTODEMO',
    charges_enabled: subStatus === 'active',
    payouts_enabled: subStatus === 'active',
    stripe_balance: subStatus === 'active' ? 1200 : 0,
    monthly_gmv: subStatus === 'active' ? 8500 : 0,
    timezone: 'Europe/London',
    currency: 'GBP',
  };
}

async function seedRestaurantPlatformData() {
  console.log('Seeding restaurant platform data (modules, access, pay_api)…');
  const { rows } = await pool.query('SELECT id, plan_id, sub_status, data FROM restaurants');
  for (const row of rows) {
    const existing = row.data && typeof row.data === 'object' ? row.data : {};
    const merged = {
      ...restaurantDataJson(row.plan_id, row.sub_status, {
        id: row.id,
        joined_at: existing.joined_at,
        pay_api: row.id === 'r1' ? restaurantDataJson(row.plan_id, 'active', { id: 'r1' }).pay_api : existing.pay_api,
      }),
      ...existing,
      modules: { ...defaultModules(row.plan_id, row.id === 'r1'), ...(existing.modules || {}) },
    };
    if (row.id === 'r1') {
      merged.pay_api = restaurantDataJson('plan_starter', 'active', { id: 'r1' }).pay_api;
      merged.auto_deduct = true;
      merged.card_last4 = '4242';
      merged.card_brand = 'Visa';
    }
    await upsert(`UPDATE restaurants SET data = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(merged)]);
  }
}

async function main() {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const pinHash = await bcrypt.hash('1234', 10);
  const pin2345 = await bcrypt.hash('2345', 10);
  const pin3456 = await bcrypt.hash('3456', 10);
  const pin4567 = await bcrypt.hash('4567', 10);

  console.log('Seeding extra plans + restaurants…');
  for (const [id, name, price] of [
    ['plan_pro', 'Professional Plan', 79.99],
    ['plan_enterprise', 'Enterprise Plan', 199.99],
    ['plan_basix', 'BASIX PLAN', 25],
  ]) {
    await upsert(
      `INSERT INTO plans (id, name, plan_type, price_monthly, price_yearly, status)
       VALUES ($1,$2,'restaurant',$3,$4,TRUE)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, price_monthly = EXCLUDED.price_monthly`,
      [id, name, price, Math.round(price * 10 * 100) / 100],
    );
  }
  const extraRestaurants = [
    ['r12', 12, 'Shotts Tandoori', 'Waseem', 'plan_enterprise', 'active'],
    ['r6', 6, 'ZEE GRILL', 'Zahid Mehmood', 'plan_enterprise', 'past_due'],
    ['r13', 13, 'Vinnies', 'Mr Sukhwinder Singh', 'plan_starter', 'inactive'],
    ['r14', 14, 'TKR', 'Tahir Khan', 'plan_starter', 'inactive'],
    ['r15', 15, 'DEMO', 'Waseem', 'plan_basix', 'canceled'],
    ['r16', 16, 'Charsi Tikka', 'Tahir Khan', 'plan_starter', 'inactive'],
  ];
  for (const [id, liveId, name, owner, plan, st] of extraRestaurants) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const ownerEmail = `owner@${slug}.example`;
    await upsert(
      `INSERT INTO restaurants (id, live_id, name, owner, email, phone, address, city, plan_id, sub_status, status, data)
       VALUES ($1,$2,$3,$4,$5,$6,'',$7,$8,$9,TRUE,'{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, plan_id = EXCLUDED.plan_id, sub_status = EXCLUDED.sub_status`,
      [id, liveId, name, owner, ownerEmail, '0141 000 0000', 'United Kingdom', plan, st],
    );
    await upsert(
      `INSERT INTO users (id, email, password_hash, role, name, restaurant_id)
       VALUES ($1,$2,$3,'restaurant',$4,$5)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, restaurant_id = EXCLUDED.restaurant_id, role = 'restaurant'`,
      [`u_${id}`, ownerEmail, hash, owner, id],
    );
  }

  console.log('Seeding users…');
  await upsert(
    `INSERT INTO users (id, email, password_hash, role, name, restaurant_id, till_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
       name = EXCLUDED.name, restaurant_id = EXCLUDED.restaurant_id, till_id = EXCLUDED.till_id, status = TRUE`,
    ['u_super', 'owner@cravedash.co.uk', hash, 'super', 'Platform Owner', null, null],
  );
  await upsert(
    `INSERT INTO users (id, email, password_hash, role, name, restaurant_id)
     VALUES ($1,$2,$3,'restaurant',$4,'r1')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, restaurant_id = 'r1', role = 'restaurant'`,
    ['u_owner', 'owner@portopiripiri.example', hash, 'Faisal'],
  );
  await upsert(
    `INSERT INTO users (id, email, password_hash, role, name, restaurant_id, till_id)
     VALUES ($1,$2,$3,'epos',$4,'r1','till-1')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'epos', till_id = 'till-1'`,
    ['u_epos', 'till1@portopiripiri.example', hash, 'Till 1'],
  );
  // Keep legacy emails working
  await upsert(
    `INSERT INTO users (id, email, password_hash, role, name, restaurant_id)
     VALUES ($1,$2,$3,'super',$4,NULL)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    ['u_super_legacy', 'admin@cravedash.co.uk', hash, 'Master Admin'],
  );
  await upsert(
    `INSERT INTO users (id, email, password_hash, role, name, restaurant_id, till_id)
     VALUES ($1,$2,$3,'epos',$4,'r1','till-1')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    ['u_epos_legacy', 'till@portopiripiri.example', hash, 'Till User'],
  );

  console.log('Seeding remaining roles: rider, chef, and customer…');
  try {
    await upsert(
      `INSERT INTO deliverymen (id, restaurant_id, name, phone, email, vehicle, status, password_hash, data)
       VALUES ($1,'r1',$2,$3,$4,$5,'active',$6,$7::jsonb)
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = EXCLUDED.status, data = EXCLUDED.data`,
      ['dm_1', 'Dave Rider', '07700900111', 'rider@portopiripiri.example', 'motorcycle', hash, JSON.stringify({ password_hash: hash })],
    );
  } catch (e) {
    console.warn('Note: deliverymen table seed skipped or failed:', e.message);
  }
  try {
    await upsert(
      `INSERT INTO users (id, email, password_hash, role, name, restaurant_id)
       VALUES ($1,$2,$3,'rider',$4,'r1')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'rider'`,
      ['u_rider', 'rider@portopiripiri.example', hash, 'Dave Rider'],
    );
  } catch (e) {
    console.warn('Note: users rider seed skipped:', e.message);
  }

  try {
    await upsert(
      `INSERT INTO chefs (id, restaurant_id, name, email, phone, status, password_hash, data)
       VALUES ($1,'r1',$2,$3,$4,TRUE,$5,$6::jsonb)
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = EXCLUDED.status, data = EXCLUDED.data`,
      ['chef_1', 'Gordon Chef', 'chef@portopiripiri.example', '07700900222', hash, JSON.stringify({ password_hash: hash })],
    );
  } catch (e) {
    console.warn('Note: chefs table seed skipped or failed:', e.message);
  }
  try {
    await upsert(
      `INSERT INTO users (id, email, password_hash, role, name, restaurant_id)
       VALUES ($1,$2,$3,'chef',$4,'r1')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'chef'`,
      ['u_chef', 'chef@portopiripiri.example', hash, 'Gordon Chef'],
    );
  } catch (e) {
    console.warn('Note: users chef seed skipped:', e.message);
  }

  try {
    await upsert(
      `INSERT INTO customers (id, restaurant_id, name, email, phone, status, data)
       VALUES ($1,'r1',$2,$3,$4,TRUE,$5::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, status = EXCLUDED.status`,
      ['cust_1', 'Alice Customer', 'customer@cravedash.co.uk', '07700900333', JSON.stringify({ password_hash: hash, f_name: 'Alice', l_name: 'Customer' })],
    );
  } catch (e) {
    console.warn('Note: customers table seed skipped or failed:', e.message);
  }
  try {
    await upsert(
      `INSERT INTO users (id, email, password_hash, role, name, restaurant_id)
       VALUES ($1,$2,$3,'customer',$4,'r1')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'customer'`,
      ['u_customer', 'customer@cravedash.co.uk', hash, 'Alice Customer'],
    );
  } catch (e) {
    console.warn('Note: users customer seed skipped:', e.message);
  }

  console.log('Seeding till staff PINs…');
  const staff = [
    ['ts1', 'Alex Khan', pinHash, 'manager'],
    ['ts2', 'Sarah Johnson', pin2345, 'supervisor'],
    ['ts3', 'Maria Clarke', pin3456, 'cashier'],
    ['ts4', 'Omar Ali', pin4567, 'cashier'],
  ];
  for (const [id, name, ph, role] of staff) {
    await upsert(
      `INSERT INTO till_staff (id, restaurant_id, name, pin_hash, role, till_id)
       VALUES ($1,'r1',$2,$3,$4,'till-1')
       ON CONFLICT (id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, name = EXCLUDED.name, role = EXCLUDED.role`,
      [id, name, ph, role],
    );
  }

  const porto = loadPortoSeed();
  if (!porto) {
    console.warn('PORTO_SEED not found — skipping catalogue');
  } else {
    console.log('Seeding Porto catalogue…');
    const colour = '#0b84f3';
    const text = '#ffffff';
    const cats = porto.categories.map((c, i) => ({
      id: `cat${i + 1}`,
      num: i + 1,
      name: c.name,
      image: c.image || null,
      colour,
      text_colour: text,
      priority: i + 1,
    }));
    for (const c of cats) {
      await upsert(
        `INSERT INTO categories (id, restaurant_id, num, name, image, colour, text_colour, priority, status)
         VALUES ($1,'r1',$2,$3,$4,$5,$6,$7,TRUE)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, image = EXCLUDED.image, priority = EXCLUDED.priority`,
        [c.id, c.num, c.name, c.image, c.colour, c.text_colour, c.priority],
      );
    }

    const subs = (porto.subcategories || []).map((s, i) => {
      const parent = cats.find((c) => c.name === s[0]) || cats[0];
      return { id: `sub${i + 1}`, parent_id: parent.id, name: s[1] };
    });
    for (const s of subs) {
      await upsert(
        `INSERT INTO subcategories (id, restaurant_id, parent_id, name, status)
         VALUES ($1,'r1',$2,$3,TRUE)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id`,
        [s.id, s.parent_id, s.name],
      );
    }

    for (const a of porto.addons || []) {
      const id = typeof a === 'string' ? `ad_${a.replace(/\W+/g, '_').slice(0, 40)}` : a.id;
      const name = typeof a === 'string' ? a : a.name;
      const price = typeof a === 'object' ? Number(a.price || 0) : 0.6;
      await upsert(
        `INSERT INTO addons (id, restaurant_id, name, price, status)
         VALUES ($1,'r1',$2,$3,TRUE)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price`,
        [id, name, price],
      );
    }

    for (const [i, name] of (porto.cuisines || []).entries()) {
      await upsert(
        `INSERT INTO cuisines (id, restaurant_id, name, priority, status)
         VALUES ($1,'r1',$2,$3,TRUE)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [`cu${i + 1}`, name, i + 1],
      );
    }

    let n = 0;
    for (const p of porto.products || []) {
      const cat = cats.find((c) => c.name === p.category) || cats[0];
      const price = Number(p.price || 0);
      const data = {
        live_id: p.live_id,
        description: p.description || '',
        image: p.image || '',
        variations: p.variations || [],
        addons: p.addons || [],
        veg: !!p.veg,
        product_type: p.veg ? 'veg' : 'nonveg',
      };
      await upsert(
        `INSERT INTO products (id, restaurant_id, name, category_id, price, from_price, data, status, visible, description)
         VALUES ($1,'r1',$2,$3,$4,$5,$6::jsonb,TRUE,TRUE,$7)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category_id = EXCLUDED.category_id,
           price = EXCLUDED.price, from_price = EXCLUDED.from_price, data = EXCLUDED.data, description = EXCLUDED.description`,
        [p.id, p.name, cat.id, price, price, JSON.stringify(data), p.description || ''],
      );
      n++;
    }
    console.log(`  ${cats.length} categories, ${n} products`);
  }

  // Floor tables
  const tables = [
    [1, 'area1', 'square', 2, 1, 1], [2, 'area1', 'square', 2, 3, 1], [3, 'area1', 'round', 4, 5, 1],
    [4, 'area1', 'rect', 6, 7, 1], [5, 'area1', 'round', 4, 1, 3], [6, 'area1', 'rect', 6, 3, 3],
    [7, 'area1', 'square', 4, 6, 3], [8, 'area1', 'rect', 8, 8, 3],
    [9, 'area2', 'round', 2, 1, 1], [10, 'area2', 'round', 2, 3, 1],
    [11, 'area2', 'square', 4, 5, 1], [12, 'area2', 'rect', 6, 2, 3],
    [13, 'area3', 'square', 2, 1, 1], [14, 'area3', 'square', 2, 1, 3], [15, 'area3', 'square', 2, 1, 5],
  ];
  for (const [areaId, name] of [['area1', 'Main Hall'], ['area2', 'Patio'], ['area3', 'Window']]) {
    await upsert(
      `INSERT INTO areas (id, restaurant_id, name) VALUES ($1,'r1',$2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [areaId, name],
    );
  }
  for (const t of tables) {
    await upsert(
      `INSERT INTO dining_tables (id, restaurant_id, number, area_id, shape, seats, pos_x, pos_y, active)
       VALUES ($1,'r1',$2,$3,$4,$5,$6,$7,TRUE)
       ON CONFLICT (id) DO UPDATE SET area_id = EXCLUDED.area_id, shape = EXCLUDED.shape, seats = EXCLUDED.seats`,
      [`T${t[0]}`, t[0], t[1], t[2], t[3], t[4], t[5]],
    );
  }

  await seedRestaurantPlatformData();

  console.log('Done.');
  console.log('  Password for all users:', DEMO_PASSWORD);
  console.log('  Super: owner@cravedash.co.uk');
  console.log('  Restaurant: owner@portopiripiri.example');
  console.log('  EPOS: till1@portopiripiri.example');
  console.log('  Till PINs: 1234 / 2345 / 3456 / 4567');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
