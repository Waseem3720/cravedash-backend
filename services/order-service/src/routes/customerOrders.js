const express = require('express');
const pool = require('@cravedash/shared/src/db');
const { ok, created } = require('@cravedash/shared/src/response');
const asyncHandler = require('@cravedash/shared/src/asyncHandler');
const { restaurantId, requireAuth, optionalAuth } = require('@cravedash/shared/src/authMiddleware');
const { badRequest, notFound, forbidden, unauthorized } = require('@cravedash/shared/src/errors');
const { calculateDealPreview } = require('@cravedash/shared/src/engines/deals');

const router = express.Router();

function parseOrder(row) {
  if (!row) return row;
  const o = { ...row };
  ['customer', 'items', 'history', 'data', 'delivery_address'].forEach((k) => {
    if (typeof o[k] === 'string') {
      try { o[k] = JSON.parse(o[k]); } catch { /* keep */ }
    }
  });
  o.id = Number(o.id);
  if (o.status === 'canceled') o.status = 'cancelled';
  if (Array.isArray(o.history)) {
    o.history = o.history.map((h) => ({
      ...h,
      status: h.status === 'canceled' ? 'cancelled' : h.status,
      time: h.time || h.at || h.timestamp || '',
      timestamp: h.timestamp || h.at || h.time || '',
    }));
  }
  return o;
}

/**
 * Authoritatively fetch restaurant ordering fees and limits.
 */
async function getOrderingFees(clientOrPool, rid, branchId) {
  const { rows: restRows } = await clientOrPool.query('SELECT data FROM restaurants WHERE id = $1', [rid]);
  const restData = restRows[0]?.data || {};
  let branchData = {};
  if (branchId) {
    const { rows: bRows } = await clientOrPool.query('SELECT data FROM branches WHERE restaurant_id = $1 AND id = $2', [rid, String(branchId)]);
    if (bRows[0]?.data) branchData = bRows[0].data;
  }
  const deliveryCharge = Number(branchData.delivery_charge != null ? branchData.delivery_charge : (restData.delivery_charge != null ? restData.delivery_charge : 2.50));
  const serviceFee = Number(restData.service_fee != null ? restData.service_fee : 0.50);
  const bagCharge = Number(restData.bag_charge != null ? restData.bag_charge : 0.20);
  const freeOver = Number(branchData.free_delivery_over != null ? branchData.free_delivery_over : (restData.free_delivery_over != null ? restData.free_delivery_over : 20.00));
  const minOrder = Number(branchData.min_order_amount != null ? branchData.min_order_amount : (branchData.min_order != null ? branchData.min_order : (restData.min_order != null ? restData.min_order : 10.00)));

  return {
    delivery_charge: deliveryCharge,
    service_fee: serviceFee,
    bag_charge: bagCharge,
    free_delivery_over: freeOver,
    min_order: minOrder,
  };
}

/**
 * Validates delivery postcode against registered delivery zones.
 */
async function validatePostcodeCoverage(clientOrPool, rid, postcode, branchId) {
  if (!postcode) throw badRequest('Postcode is required for delivery');
  const rawPostcode = String(postcode).trim();
  const normalized = rawPostcode.replace(/\s+/g, '').toUpperCase();
  const outwardMatch = rawPostcode.match(/^([A-Z]{1,2}\d[A-Z\d]?)/i);
  const outward = outwardMatch ? outwardMatch[1].toUpperCase() : normalized;

  const { rows } = await clientOrPool.query(
    `SELECT data FROM restaurant_blobs WHERE restaurant_id = $1 AND key = 'delivery_zones'`,
    [rid],
  ).catch(() => ({ rows: [] }));

  const rawZones = rows[0]?.data;
  const zones = Array.isArray(rawZones) ? rawZones : (rawZones && typeof rawZones === 'object' ? Object.values(rawZones) : []);
  if (zones.length > 0) {
    const matched = zones.find((z) => {
      if (branchId && z.branch_id && String(z.branch_id) !== String(branchId)) return false;
      const pcList = Array.isArray(z.postcodes) ? z.postcodes : (typeof z.postcodes === 'string' ? z.postcodes.split(/[,\s]+/) : []);
      const normList = pcList.map((p) => String(p).replace(/\s+/g, '').toUpperCase()).filter(Boolean);
      return normList.some((p) => p === normalized || p === outward || normalized.startsWith(p));
    });
    if (!matched) {
      throw badRequest(`Postcode "${rawPostcode}" is outside our delivery zone`);
    }
  }
}

/**
 * Authoritatively calculate item prices and addons from database records.
 * Client-submitted prices and totals are completely ignored.
 */
async function calculateAuthoritativeCart(clientOrPool, rid, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw badRequest('Cart items array cannot be empty');
  }

  // Separate standard product items and deal combo items
  const productItems = [];
  const dealItems = [];
  rawItems.forEach((it) => {
    if (it.deal_id || it.is_deal) {
      dealItems.push(it);
    } else {
      productItems.push(it);
    }
  });

  // 1. Process deal combo items authoritatively
  let dealsSubtotal = 0;
  const calculatedDeals = [];
  for (const dealIt of dealItems) {
    const qty = Math.max(1, parseInt(dealIt.quantity || dealIt.qty || 1, 10));
    const dealPreview = await calculateDealPreview(rid, dealIt, clientOrPool);
    const unitPrice = Number(dealPreview.price != null ? dealPreview.price : (dealPreview.total_price != null ? dealPreview.total_price : 0));
    const lineTotal = Math.round(unitPrice * qty * 100) / 100;
    dealsSubtotal += lineTotal;

    const chosenOptionNames = Array.isArray(dealPreview.selections)
      ? dealPreview.selections.map((s) => s.name || s.item_name || '').filter(Boolean)
      : [];
    const optionPath = chosenOptionNames.join(' · ');

    calculatedDeals.push({
      id: dealPreview.deal_id,
      deal_id: dealPreview.deal_id,
      product_id: null,
      is_deal: true,
      name: dealPreview.name,
      price: unitPrice,
      unit_price: unitPrice,
      subtotal: lineTotal,
      quantity: qty,
      addons: [],
      option_path: optionPath,
      item_total: lineTotal,
      slots: dealPreview.slots || [],
      items: dealPreview.items || [],
      selections: dealPreview.selections || [],
      notes: dealIt.notes || dealIt.instruction || '',
    });
  }

  // 2. Process standard products
  let productsSubtotal = 0;
  let calculatedProducts = [];
  if (productItems.length > 0) {
    const productKeys = [];
    productItems.forEach((it) => {
      const pId = String(it.id != null ? it.id : (it.product_id != null ? it.product_id : '')).trim();
      if (pId) {
        productKeys.push(pId);
        if (/^\d+$/.test(pId)) {
          productKeys.push('p' + pId);
        } else if (pId.startsWith('p')) {
          productKeys.push(pId.replace(/^p/, ''));
        }
      }
    });

    if (productKeys.length === 0) {
      throw badRequest('Cart items must contain valid product IDs');
    }

    const { rows: products } = await clientOrPool.query(
      `SELECT id, name, price, status, data FROM products WHERE restaurant_id = $1 AND id = ANY($2)`,
      [rid, productKeys],
    );
    const prodMap = new Map();
    products.forEach((p) => {
      prodMap.set(String(p.id), p);
      if (String(p.id).startsWith('p')) {
        prodMap.set(String(p.id).replace(/^p/, ''), p);
      }
    });

    // Collect addon IDs
    const allAddonIds = [];
    productItems.forEach((it) => {
      if (Array.isArray(it.addons)) {
        it.addons.forEach((a) => {
          const aId = typeof a === 'object' && a !== null ? (a.id || a.addon_id) : a;
          if (aId) allAddonIds.push(String(aId).trim());
        });
      }
    });

    const addonMap = new Map();
    if (allAddonIds.length > 0) {
      const { rows: addons } = await clientOrPool.query(
        `SELECT id, name, price, status FROM addons WHERE restaurant_id = $1 AND id = ANY($2)`,
        [rid, allAddonIds],
      );
      addons.forEach((a) => addonMap.set(String(a.id), a));
    }

    calculatedProducts = productItems.map((it) => {
      const rawId = String(it.id != null ? it.id : (it.product_id != null ? it.product_id : '')).trim();
      const prod = prodMap.get(rawId);
      if (!prod) {
        throw badRequest(`Product "${it.name || rawId}" is not available in this restaurant`);
      }
      if (prod.status === false) {
        throw badRequest(`Product "${prod.name || rawId}" is currently disabled`);
      }

      const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
      const unitPrice = Number(prod.price) || 0;

      let addonTotal = 0;
      const validatedAddonIds = [];
      const validatedAddonNames = [];
      if (Array.isArray(it.addons)) {
        for (const a of it.addons) {
          const aId = String(typeof a === 'object' && a !== null ? (a.id || a.addon_id || '') : (a || '')).trim();
          if (aId) {
            const addonDb = addonMap.get(aId);
            if (!addonDb) {
              throw badRequest(`Addon "${aId}" not found`);
            }
            if (addonDb.status === false) {
              throw badRequest(`Addon "${addonDb.name || aId}" is currently disabled`);
            }
            const addonPrice = Number(addonDb.price) || 0;
            addonTotal += addonPrice;
            validatedAddonIds.push(String(addonDb.id));
            validatedAddonNames.push(addonDb.name);
          }
        }
      }

      const lineTotal = Math.round((unitPrice + addonTotal) * qty * 100) / 100;
      productsSubtotal += lineTotal;

      const outputId = /^\d+$/.test(rawId) ? Number(rawId) : (/^p\d+$/.test(prod.id) ? Number(prod.id.replace(/^p/, '')) : prod.id);

      return {
        id: outputId,
        product_id: outputId,
        name: prod.name,
        price: unitPrice,
        unit_price: unitPrice,
        subtotal: lineTotal,
        quantity: qty,
        addons: validatedAddonIds,
        option_path: validatedAddonNames.join(' · '),
        item_total: lineTotal,
        notes: it.notes || it.instruction || '',
      };
    });
  }

  const subtotal = Math.round((dealsSubtotal + productsSubtotal) * 100) / 100;
  const calculatedItems = [...calculatedProducts, ...calculatedDeals];
  return {
    subtotal,
    calculatedItems,
    items: calculatedItems,
  };
}

/**
 * Authoritatively calculates coupon discount.
 */
async function calculateCouponDiscount(clientOrPool, rid, couponCode, subtotal) {
  if (!couponCode) return { discount: 0, couponDetails: null };
  const { rows: coupons } = await clientOrPool.query(
    `SELECT * FROM coupons WHERE restaurant_id = $1 AND LOWER(code) = LOWER($2)`,
    [rid, String(couponCode).trim()],
  );
  if (!coupons[0]) {
    throw badRequest('Invalid coupon code');
  }
  const coupon = coupons[0];
  if (coupon.status === false) throw badRequest('Coupon is inactive');
  if (coupon.expire_at && new Date(coupon.expire_at) < new Date()) throw badRequest('Coupon has expired');
  if (coupon.start_at && new Date(coupon.start_at) > new Date()) throw badRequest('Coupon is not active yet');
  if (coupon.usage_limit > 0 && coupon.used >= coupon.usage_limit) throw badRequest('Coupon usage limit reached');

  const minPurchase = Number(coupon.min_purchase || 0);
  if (minPurchase > 0 && subtotal < minPurchase) {
    throw badRequest(`Minimum purchase for coupon ${coupon.code} is £${minPurchase.toFixed(2)}`);
  }

  let discount = 0;
  const discountVal = Number(coupon.discount || 0);
  if (coupon.discount_type === 'percent') {
    discount = Math.round((subtotal * (discountVal / 100)) * 100) / 100;
    const maxDiscount = Number(coupon.max_discount || 0);
    if (maxDiscount > 0 && discount > maxDiscount) discount = maxDiscount;
  } else {
    discount = Math.min(subtotal, discountVal);
  }

  return {
    discount: Math.round(discount * 100) / 100,
    couponDetails: {
      code: coupon.code,
      discount_type: coupon.discount_type,
      discount_value: discountVal,
    },
    couponId: coupon.id,
  };
}

/**
 * POST /api/v1/customer/order/deal-preview
 * Authoritative deal combo selection calculation for storefront.
 */
router.post('/deal-preview', optionalAuth, asyncHandler(async (req, res) => {
  const result = await calculateDealPreview(restaurantId(req), req.body || {});
  ok(res, {
    deal_id: result.deal_id,
    price: result.price,
    savings: result.savings,
  });
}));

/**
 * POST /api/v1/customer/order/calculate
 * Computes authoritative prices, discounts, delivery charges, and totals.
 */
router.post('/calculate', optionalAuth, asyncHandler(async (req, res) => {
  const rid = restaurantId(req);
  const body = req.body || {};
  const rawItems = Array.isArray(body.cart) ? body.cart : (Array.isArray(body.items) ? body.items : []);
  const orderType = body.order_type || 'delivery';
  const branchId = body.branch_id || 'main';

  // 1. Authoritative cart line items & subtotal
  const { subtotal } = await calculateAuthoritativeCart(pool, rid, rawItems);

  // 2. Authoritative ordering fees
  const fees = await getOrderingFees(pool, rid, branchId);

  // 3. Authoritative coupon evaluation
  const couponCode = String(body.coupon_code || '').trim();
  const { discount, couponDetails } = await calculateCouponDiscount(pool, rid, couponCode, subtotal);

  // 4. Delivery charge: 0 for collection/takeaway or when subtotal >= free_delivery_over
  let deliveryCharge = 0;
  if (orderType === 'delivery') {
    if (fees.free_delivery_over > 0 && subtotal >= fees.free_delivery_over) {
      deliveryCharge = 0;
    } else {
      deliveryCharge = fees.delivery_charge;
    }
  }

  // 5. Tip and authoritative total
  const tip = Math.max(0, Math.round((Number(body.tip) || 0) * 100) / 100);
  const total = Math.round(Math.max(0, subtotal - discount + deliveryCharge + fees.service_fee + fees.bag_charge + tip) * 100) / 100;

  ok(res, {
    order_type: orderType,
    subtotal,
    discount,
    coupon_discount: discount,
    delivery_charge: deliveryCharge,
    service_fee: fees.service_fee,
    bag_charge: fees.bag_charge,
    tip,
    total,
    coupon: couponDetails,
  });
}));

/**
 * POST /api/v1/customer/order/place
 * Places an authoritative order linked to the authenticated customer.
 */
router.post('/place', optionalAuth, asyncHandler(async (req, res) => {
  const rid = restaurantId(req);
  const body = req.body || {};
  const customerId = req.user?.sub || req.user?.id || (body.customer && body.customer.id) || `guest_${Date.now().toString(36)}`;
  const branchId = body.branch_id || 'main';
  const orderType = body.order_type || 'delivery';

  // Validate payment method
  const validMethods = new Set(['cash', 'card', 'stripe', 'cod', 'cash_on_delivery', 'online', 'wallet']);
  const paymentMethod = String(body.payment_method || 'cash').toLowerCase();
  if (!validMethods.has(paymentMethod)) {
    throw badRequest(`Invalid payment method: ${body.payment_method}`);
  }

  // Validate delivery address ownership / input
  let deliveryAddressId = body.delivery_address_id ? String(body.delivery_address_id) : null;
  let deliveryAddress = null;

  if (orderType === 'delivery') {
    if (deliveryAddressId) {
      const { rows: addrRows } = await pool.query(
        `SELECT * FROM customer_addresses
         WHERE id = $1 AND customer_id = $2 AND (restaurant_id = $3 OR restaurant_id IS NULL)`,
        [deliveryAddressId, customerId, rid],
      );
      if (!addrRows[0]) {
        throw badRequest('Invalid or unauthorized delivery address');
      }
      deliveryAddress = {
        id: addrRows[0].id,
        address: addrRows[0].address || addrRows[0].line1 || '',
        line1: addrRows[0].line1 || '',
        line2: addrRows[0].line2 || '',
        city: addrRows[0].city || '',
        postcode: addrRows[0].postcode || '',
        contact_person_name: addrRows[0].contact_person_name || '',
        contact_person_number: addrRows[0].contact_person_number || '',
      };
    } else if (body.address || body.delivery_address) {
      const addr = body.delivery_address || body.address;
      deliveryAddress = typeof addr === 'object'
        ? {
          address: addr.address || addr.line1 || '',
          line1: addr.line1 || '',
          line2: addr.line2 || '',
          city: addr.city || '',
          postcode: addr.postcode || body.postcode || '',
          contact_person_name: addr.contact_person_name || body.contact_person_name || '',
          contact_person_number: addr.contact_person_number || body.contact_person_number || '',
        }
        : {
          address: String(addr),
          postcode: body.postcode || '',
          contact_person_name: body.contact_person_name || '',
          contact_person_number: body.contact_person_number || '',
        };
    } else {
      throw badRequest('Delivery address required for delivery order');
    }

    // Validate postcode within delivery zones
    await validatePostcodeCoverage(pool, rid, deliveryAddress.postcode, branchId);
  }

  const idempotencyKey = req.headers['idempotency-key'] || body.idempotency_key || null;

  // Idempotency check: if already placed with this key, return existing order
  if (idempotencyKey) {
    const { rows: prior } = await pool.query(
      `SELECT * FROM orders
       WHERE restaurant_id = $1
         AND (data->>'idempotency_key' = $2 OR data->>'sync_key' = $2)
       LIMIT 1`,
      [rid, String(idempotencyKey)],
    );
    if (prior[0]) {
      const o = parseOrder(prior[0]);
      return ok(res, {
        order_id: String(o.id),
        id: Number(o.id),
        status: o.status,
        order_type: o.order_type,
        payment_method: o.payment_method,
        payment_status: o.payment_status,
        subtotal: Number(o.subtotal),
        discount: Number(o.discount),
        delivery_charge: Number(o.delivery_charge),
        service_fee: Number(o.data?.service_fee || 0.50),
        bag_charge: Number(o.data?.bag_charge || 0.20),
        total: Number(o.total),
        created_at: o.created_at,
        message: 'Order placed successfully',
      });
    }
  }

  const rawItems = Array.isArray(body.cart) ? body.cart : (Array.isArray(body.items) ? body.items : []);

  // Execute order placement in a transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Authoritative item calculation inside transaction
    const { subtotal, calculatedItems } = await calculateAuthoritativeCart(client, rid, rawItems);

    // 2. Authoritative ordering fees
    const fees = await getOrderingFees(client, rid, branchId);

    // 3. Minimum order validation
    if (fees.min_order > 0 && subtotal < fees.min_order) {
      throw badRequest(`Minimum order amount is £${fees.min_order.toFixed(2)}`);
    }

    // 4. Authoritative coupon lock and increment inside transaction
    let discount = 0;
    const couponCode = String(body.coupon_code || '').trim();
    if (couponCode) {
      const { rows: coupons } = await client.query(
        `SELECT * FROM coupons WHERE restaurant_id = $1 AND LOWER(code) = LOWER($2) FOR UPDATE`,
        [rid, couponCode],
      );
      if (!coupons[0]) {
        throw badRequest('Invalid coupon code');
      }
      const coupon = coupons[0];
      if (coupon.status === false) throw badRequest('Coupon is inactive');
      if (coupon.expire_at && new Date(coupon.expire_at) < new Date()) throw badRequest('Coupon has expired');
      if (coupon.start_at && new Date(coupon.start_at) > new Date()) throw badRequest('Coupon is not active yet');
      if (coupon.usage_limit > 0 && coupon.used >= coupon.usage_limit) throw badRequest('Coupon usage limit reached');

      const minPurchase = Number(coupon.min_purchase || 0);
      if (minPurchase > 0 && subtotal < minPurchase) {
        throw badRequest(`Minimum purchase for coupon ${coupon.code} is £${minPurchase.toFixed(2)}`);
      }

      const discountVal = Number(coupon.discount || 0);
      if (coupon.discount_type === 'percent') {
        discount = Math.round((subtotal * (discountVal / 100)) * 100) / 100;
        const maxDiscount = Number(coupon.max_discount || 0);
        if (maxDiscount > 0 && discount > maxDiscount) discount = maxDiscount;
      } else {
        discount = Math.min(subtotal, discountVal);
      }

      await client.query(
        `UPDATE coupons SET used = used + 1, updated_at = NOW() WHERE id = $1`,
        [coupon.id],
      );
    }

    // 5. Authoritative delivery charge
    let deliveryCharge = 0;
    if (orderType === 'delivery') {
      if (fees.free_delivery_over > 0 && subtotal >= fees.free_delivery_over) {
        deliveryCharge = 0;
      } else {
        deliveryCharge = fees.delivery_charge;
      }
    }

    // 6. Tip and authoritative total
    const tip = Math.max(0, Math.round((Number(body.tip) || 0) * 100) / 100);
    const total = Math.round(Math.max(0, subtotal - discount + deliveryCharge + fees.service_fee + fees.bag_charge + tip) * 100) / 100;

    // 7. Sequence generation for order ID
    const { rows: seqRows } = await client.query("SELECT nextval('orders_id_seq') AS id");
    const orderId = Number(seqRows[0].id);

    // 8. Customer record lookup
    let customerSnapshot = null;
    let validCustomerId = null;
    if (req.user?.sub || req.user?.id) {
      const { rows: custRows } = await client.query(
        `SELECT id, name, email, phone FROM customers WHERE id = $1 AND restaurant_id = $2`,
        [customerId, rid],
      );
      if (custRows[0]) {
        customerSnapshot = custRows[0];
        validCustomerId = custRows[0].id;
      }
    }
    if (!customerSnapshot) {
      customerSnapshot = {
        id: customerId,
        name: body.customer?.name || deliveryAddress?.contact_person_name || req.user?.name || 'Guest Customer',
        email: body.customer?.email || req.user?.email || '',
        phone: body.customer?.phone || deliveryAddress?.contact_person_number || req.user?.phone || '',
      };
    }

    // 9. Assemble order history and data
    const nowIso = new Date().toISOString();
    const history = [{ status: 'pending', at: nowIso, time: nowIso, timestamp: nowIso, by: 'Customer' }];
    const orderData = {
      ...(body.data && typeof body.data === 'object' ? body.data : {}),
      ...(idempotencyKey ? { idempotency_key: String(idempotencyKey), sync_key: String(idempotencyKey) } : {}),
      service_fee: fees.service_fee,
      bag_charge: fees.bag_charge,
      schedule: body.schedule || null,
      note: body.order_note || body.note || '',
    };

    const paymentStatus = 'unpaid';

    const { rows: inserted } = await client.query(
      `INSERT INTO orders (
        id, restaurant_id, branch, branch_id, source, order_type, status,
        payment_status, payment_method, customer, table_id, guests, items,
        subtotal, discount, coupon_code, delivery_charge, service_charge, tip,
        total, note, history, acknowledged, data,
        customer_id, delivery_address_id, delivery_address
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
      ) RETURNING *`,
      [
        orderId, rid, body.branch || 'Main Branch', branchId, 'website', orderType, 'pending',
        paymentStatus, paymentMethod, JSON.stringify(customerSnapshot), null, 0,
        JSON.stringify(calculatedItems), subtotal, discount, couponCode || null,
        deliveryCharge, 0, tip, total, body.order_note || body.note || '',
        JSON.stringify(history), false, JSON.stringify(orderData),
        validCustomerId, deliveryAddressId, JSON.stringify(deliveryAddress),
      ],
    );

    await client.query('COMMIT');
    const createdOrder = parseOrder(inserted[0]);

    created(res, {
      order_id: String(createdOrder.id),
      id: Number(createdOrder.id),
      status: 'pending',
      order_type: createdOrder.order_type,
      payment_method: createdOrder.payment_method,
      payment_status: createdOrder.payment_status,
      subtotal: Number(createdOrder.subtotal),
      discount: Number(createdOrder.discount),
      delivery_charge: Number(createdOrder.delivery_charge),
      service_fee: fees.service_fee,
      bag_charge: fees.bag_charge,
      total: Number(createdOrder.total),
      created_at: createdOrder.created_at,
      message: 'Order placed successfully',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * GET /api/v1/customer/order/list
 * Returns paginated order history strictly for the authenticated customer.
 */
router.get('/list', requireAuth, asyncHandler(async (req, res) => {
  const rid = restaurantId(req);
  const customerId = req.user.sub || req.user.id;
  const offset = Math.max(1, parseInt(req.query.offset, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (offset - 1) * limit;

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS count FROM orders
     WHERE restaurant_id = $1 AND (customer_id = $2 OR customer->>'id' = $2)`,
    [rid, customerId],
  );
  const totalSize = countRes.rows[0]?.count || 0;

  const { rows } = await pool.query(
    `SELECT * FROM orders
     WHERE restaurant_id = $1 AND (customer_id = $2 OR customer->>'id' = $2)
     ORDER BY created_at DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [rid, customerId, limit, skip],
  );

  const orders = rows.map((r) => {
    const o = parseOrder(r);
    return {
      id: Number(o.id),
      order_id: String(o.id),
      status: o.status,
      order_type: o.order_type,
      payment_method: o.payment_method,
      payment_status: o.payment_status,
      subtotal: Number(o.subtotal),
      discount: Number(o.discount),
      delivery_charge: Number(o.delivery_charge),
      total: Number(o.total),
      created_at: o.created_at,
    };
  });

  ok(res, {
    total_size: totalSize,
    limit,
    offset,
    orders,
  });
}));

/**
 * GET /api/v1/customer/order/details
 * Returns full details of an order owned by the authenticated customer.
 */
router.get(['/details', '/details/:id'], requireAuth, asyncHandler(async (req, res) => {
  const rid = restaurantId(req);
  const customerId = req.user.sub || req.user.id;
  const orderId = req.params.id || req.query.order_id || req.query.id;
  if (!orderId) {
    throw badRequest('order_id is required');
  }

  const { rows } = await pool.query(
    `SELECT * FROM orders
     WHERE restaurant_id = $1 AND id = $2 AND (customer_id = $3 OR customer->>'id' = $3)`,
    [rid, orderId, customerId],
  );
  if (!rows[0]) {
    throw notFound('Order not found');
  }

  const order = parseOrder(rows[0]);
  const isDelivery = order.order_type === 'delivery';
  const custAddr = order.delivery_address || {};

  const mappedItems = (Array.isArray(order.items) ? order.items : []).map((it) => {
    let rawPId = it.product_id != null ? it.product_id : it.id;
    let numPId = null;
    if (rawPId != null) {
      if (/^\d+$/.test(String(rawPId))) numPId = Number(rawPId);
      else if (/^p\d+$/.test(String(rawPId))) numPId = Number(String(rawPId).replace(/^p/, ''));
      else numPId = rawPId;
    }

    let outputId = it.id != null ? (isNaN(Number(it.id)) ? it.id : Number(it.id)) : numPId;
    const addons = Array.isArray(it.addons)
      ? it.addons.map((a) => (typeof a === 'object' && a !== null ? (a.id || a.addon_id) : a)).filter(Boolean)
      : [];

    return {
      id: outputId,
      product_id: numPId,
      name: it.name || '',
      price: Number(it.price != null ? it.price : (it.unit_price || 0)),
      quantity: Number(it.quantity || 1),
      addons,
      option_path: it.option_path || '',
    };
  });

  const history = (Array.isArray(order.history) ? order.history : []).map((h) => ({
    status: h.status === 'canceled' ? 'cancelled' : h.status,
    at: h.at || h.timestamp || h.time || '',
    time: h.time || h.at || h.timestamp || '',
    by: h.by || 'System',
  }));

  ok(res, {
    id: Number(order.id),
    order_id: String(order.id),
    status: order.status,
    order_type: order.order_type,
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    subtotal: Number(order.subtotal),
    discount: Number(order.discount),
    delivery_charge: Number(order.delivery_charge),
    service_fee: Number(order.data?.service_fee || 0),
    bag_charge: Number(order.data?.bag_charge || 0),
    total: Number(order.total),
    created_at: order.created_at,
    customer: {
      name: order.customer?.name || custAddr.contact_person_name || '',
      phone: order.customer?.phone || custAddr.contact_person_number || '',
      email: order.customer?.email || '',
      address: isDelivery ? (custAddr.address || custAddr.line1 || '') : '',
      postcode: isDelivery ? (custAddr.postcode || '') : '',
    },
    delivery_address: order.delivery_address || null,
    items: mappedItems,
    history,
  });
}));

/**
 * GET /api/v1/customer/order/track
 * Safe customer order tracking projection that does not leak internal data or other customers.
 */
router.get(['/track', '/track/:id'], optionalAuth, asyncHandler(async (req, res) => {
  const orderId = req.params.id || req.query.order_id || req.query.id;
  if (!orderId) {
    throw badRequest('order_id is required');
  }

  const rid = (req.headers && req.headers['x-restaurant-id']) || process.env.DEFAULT_RESTAURANT_ID || 'r1';
  const { rows } = await pool.query(`SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2`, [orderId, rid]);
  if (!rows[0]) {
    throw notFound('Order not found');
  }
  const order = parseOrder(rows[0]);

  // Authorization check
  if (req.user) {
    const isCustomer = req.user.role === 'customer' || (!req.user.role && req.user.sub);
    if (isCustomer) {
      const userCustId = req.user.sub || req.user.id;
      if (String(order.customer_id) !== String(userCustId) && String(order.customer?.id) !== String(userCustId)) {
        throw notFound('Order not found');
      }
    }
  } else {
    // Unauthenticated tracking requires phone or email matching the order
    const phone = req.query.phone;
    const email = req.query.email;
    const orderPhone = order.customer?.phone || (order.delivery_address && order.delivery_address.contact_person_number);
    const orderEmail = order.customer?.email;

    const phoneMatch = phone && orderPhone && String(orderPhone).replace(/\D/g, '').endsWith(String(phone).replace(/\D/g, '').slice(-7));
    const emailMatch = email && orderEmail && String(orderEmail).toLowerCase() === String(email).toLowerCase();

    if (!phoneMatch && !emailMatch) {
      throw notFound('Order not found');
    }
  }

  const trackHistory = (Array.isArray(order.history) ? order.history : []).map((h) => ({
    status: h.status === 'canceled' ? 'cancelled' : h.status,
    at: h.at || h.timestamp || h.time || '',
    timestamp: h.timestamp || h.at || h.time || '',
  }));

  ok(res, {
    order_id: String(order.id),
    status: order.status,
    order_type: order.order_type,
    payment_status: order.payment_status,
    payment_method: order.payment_method,
    created_at: order.created_at,
    delivery_man_assigned: !!order.delivery_man_id,
    driver_distance_km: order.delivery_man_id && order.driver_distance_km != null ? Number(order.driver_distance_km) : null,
    history: trackHistory,
  });
}));

/**
 * PUT /api/v1/customer/order/cancel
 * Allows a customer to cancel a pending order before preparation starts.
 */
const cancelOrderHandler = asyncHandler(async (req, res) => {
  const rid = restaurantId(req);
  const customerId = req.user.sub || req.user.id;
  const orderId = req.params.id || (req.body && (req.body.order_id || req.body.id)) || req.query.order_id || req.query.id;
  if (!orderId) {
    throw badRequest('order_id is required');
  }

  const { rows } = await pool.query(
    `SELECT * FROM orders
     WHERE restaurant_id = $1 AND id = $2 AND (customer_id = $3 OR customer->>'id' = $3)`,
    [rid, orderId, customerId],
  );
  if (!rows[0]) {
    throw notFound('Order not found');
  }

  const order = parseOrder(rows[0]);
  if (order.status === 'cancelled' || order.status === 'canceled') {
    return ok(res, {
      order_id: String(order.id),
      status: 'cancelled',
      message: 'Order has been successfully cancelled',
      order: {
        id: Number(order.id),
        status: 'cancelled',
      },
    });
  }

  if (order.status !== 'pending') {
    throw badRequest(`Only pending orders can be cancelled`);
  }

  const nowIso = new Date().toISOString();
  const history = Array.isArray(order.history) ? [...order.history] : [];
  history.push({ status: 'cancelled', at: nowIso, time: nowIso, timestamp: nowIso, by: 'Customer' });

  const { rows: updated } = await pool.query(
    `UPDATE orders
     SET status = 'cancelled', history = $3, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *`,
    [orderId, rid, JSON.stringify(history)],
  );

  const updatedOrder = parseOrder(updated[0]);

  ok(res, {
    order_id: String(updatedOrder.id),
    status: 'cancelled',
    message: 'Order has been successfully cancelled',
    order: {
      id: Number(updatedOrder.id),
      status: 'cancelled',
    },
  });
});

router.put(['/cancel', '/cancel/:id'], requireAuth, cancelOrderHandler);
router.post(['/cancel', '/cancel/:id'], requireAuth, cancelOrderHandler);

router.calculateAuthoritativeCart = calculateAuthoritativeCart;

module.exports = router;
