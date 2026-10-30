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
  return o;
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
    const unitPrice = dealPreview.total_price;
    const lineTotal = Math.round(unitPrice * qty * 100) / 100;
    dealsSubtotal += lineTotal;

    calculatedDeals.push({
      id: dealPreview.deal_id,
      deal_id: dealPreview.deal_id,
      is_deal: true,
      name: dealPreview.name,
      price: unitPrice,
      unit_price: unitPrice,
      subtotal: lineTotal,
      base_price: dealPreview.base_price,
      extra_charges: dealPreview.extra_charges,
      quantity: qty,
      item_total: lineTotal,
      slots: dealPreview.slots,
      items: dealPreview.items,
      summary: dealPreview.summary,
      notes: dealIt.notes || dealIt.instruction || '',
    });
  }

  // 2. Process standard products
  let productsSubtotal = 0;
  let calculatedProducts = [];
  if (productItems.length > 0) {
    const productIds = productItems.map((it) => String(it.id || it.product_id || '')).filter(Boolean);
    if (productIds.length === 0) {
      throw badRequest('Cart items must contain valid product IDs');
    }

    const { rows: products } = await clientOrPool.query(
      `SELECT id, name, price, status, data FROM products WHERE restaurant_id = $1 AND id = ANY($2)`,
      [rid, productIds],
    );
    const prodMap = new Map(products.map((p) => [String(p.id), p]));

    const allAddonIds = [];
    productItems.forEach((it) => {
      if (Array.isArray(it.addons)) {
        it.addons.forEach((a) => {
          const aId = a && (a.id || a.addon_id);
          if (aId) allAddonIds.push(String(aId));
        });
      }
    });

    const addonMap = new Map();
    if (allAddonIds.length > 0) {
      const { rows: addons } = await clientOrPool.query(
        `SELECT id, name, price FROM addons WHERE restaurant_id = $1 AND id = ANY($2)`,
        [rid, allAddonIds],
      );
      addons.forEach((a) => addonMap.set(String(a.id), a));
    }

    calculatedProducts = productItems.map((it) => {
      const pId = String(it.id || it.product_id || '');
      const prod = prodMap.get(pId);
      if (!prod) {
        throw badRequest(`Product "${it.name || pId}" is not available in this restaurant`);
      }
      if (prod.status === false) {
        throw badRequest(`Product "${prod.name || pId}" is currently disabled`);
      }

      const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
      const unitPrice = Number(prod.price) || 0;

      let addonTotal = 0;
      const validatedAddons = [];
      if (Array.isArray(it.addons)) {
        it.addons.forEach((a) => {
          const aId = String(a && (a.id || a.addon_id || ''));
          const addonDb = addonMap.get(aId);
          if (addonDb) {
            const addonPrice = Number(addonDb.price) || 0;
            addonTotal += addonPrice;
            validatedAddons.push({
              id: addonDb.id,
              name: addonDb.name,
              price: addonPrice,
            });
          }
        });
      }

      const lineTotal = Math.round((unitPrice + addonTotal) * qty * 100) / 100;
      productsSubtotal += lineTotal;

      return {
        id: prod.id,
        product_id: prod.id,
        name: prod.name,
        price: unitPrice,
        unit_price: unitPrice,
        subtotal: lineTotal,
        quantity: qty,
        addons: validatedAddons,
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
 * Authoritatively compute delivery charge based on branch config and subtotal.
 */
async function calculateAuthoritativeDeliveryCharge(clientOrPool, rid, branchId, orderType, subtotal) {
  if (orderType !== 'delivery') {
    return 0;
  }

  let deliveryCharge = 2.50; // standard fallback
  let freeDeliveryThreshold = 0;
  let minOrderAmount = 0;

  if (branchId) {
    const { rows: branches } = await clientOrPool.query(
      `SELECT id, name, data FROM branches WHERE restaurant_id = $1 AND id = $2`,
      [rid, String(branchId)],
    );
    if (branches[0]) {
      const bData = branches[0].data || {};
      if (bData.delivery_charge != null) deliveryCharge = Number(bData.delivery_charge);
      if (bData.min_order_amount != null) minOrderAmount = Number(bData.min_order_amount);
      if (bData.free_delivery_over != null) freeDeliveryThreshold = Number(bData.free_delivery_over);
    }
  }

  if (minOrderAmount > 0 && subtotal < minOrderAmount) {
    throw badRequest(`Minimum order amount for delivery is £${minOrderAmount.toFixed(2)}`);
  }

  if (freeDeliveryThreshold > 0 && subtotal >= freeDeliveryThreshold) {
    deliveryCharge = 0;
  }

  return Math.round(Math.max(0, deliveryCharge) * 100) / 100;
}

/**
 * POST /api/v1/customer/order/deal-preview
 * Authoritative deal combo selection calculation for storefront.
 */
router.post('/deal-preview', optionalAuth, asyncHandler(async (req, res) => {
  const result = await calculateDealPreview(restaurantId(req), req.body || {});
  ok(res, { success: true, deal_preview: result });
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
  const { subtotal, calculatedItems } = await calculateAuthoritativeCart(pool, rid, rawItems);

  // 2. Authoritative coupon evaluation
  let discount = 0;
  let couponDetails = null;
  const couponCode = String(body.coupon_code || '').trim();
  if (couponCode) {
    const { rows: coupons } = await pool.query(
      `SELECT * FROM coupons WHERE restaurant_id = $1 AND LOWER(code) = LOWER($2)`,
      [rid, couponCode],
    );
    if (!coupons[0]) {
      throw badRequest('Invalid coupon code');
    }
    const coupon = coupons[0];
    if (coupon.status === false) {
      throw badRequest('Coupon is inactive');
    }
    if (coupon.expire_at && new Date(coupon.expire_at) < new Date()) {
      throw badRequest('Coupon has expired');
    }
    if (coupon.start_at && new Date(coupon.start_at) > new Date()) {
      throw badRequest('Coupon is not active yet');
    }
    if (coupon.usage_limit > 0 && coupon.used >= coupon.usage_limit) {
      throw badRequest('Coupon usage limit reached');
    }
    const minPurchase = Number(coupon.min_purchase || 0);
    if (minPurchase > 0 && subtotal < minPurchase) {
      throw badRequest(`Minimum purchase for coupon ${coupon.code} is £${minPurchase.toFixed(2)}`);
    }

    const discountVal = Number(coupon.discount || 0);
    if (coupon.discount_type === 'percent') {
      discount = Math.round((subtotal * (discountVal / 100)) * 100) / 100;
      const maxDiscount = Number(coupon.max_discount || 0);
      if (maxDiscount > 0 && discount > maxDiscount) {
        discount = maxDiscount;
      }
    } else {
      discount = Math.min(subtotal, discountVal);
    }
    couponDetails = {
      code: coupon.code,
      discount_type: coupon.discount_type,
      discount_value: discountVal,
    };
  }

  // 3. Authoritative delivery charge
  const deliveryCharge = await calculateAuthoritativeDeliveryCharge(pool, rid, branchId, orderType, subtotal);

  // 4. Tip and authoritative total
  const tip = Math.max(0, Math.round((Number(body.tip) || 0) * 100) / 100);
  const total = Math.round(Math.max(0, subtotal - discount + deliveryCharge + tip) * 100) / 100;

  ok(res, {
    order_type: orderType,
    branch_id: branchId,
    subtotal,
    discount,
    coupon_discount: discount,
    delivery_charge: deliveryCharge,
    tip,
    total,
    items: calculatedItems,
    coupon: couponDetails,
    engine_v2: true,
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
      return ok(res, {
        order_id: Number(prior[0].id),
        message: 'Order already placed (idempotent replay)',
        order: parseOrder(prior[0]),
      });
    }
  }

  const rawItems = Array.isArray(body.cart) ? body.cart : (Array.isArray(body.items) ? body.items : []);
  const orderType = body.order_type || 'delivery';
  const branchId = body.branch_id || 'main';

  // Validate delivery address ownership
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
        address: addrRows[0].address || addrRows[0].line1,
        line1: addrRows[0].line1,
        line2: addrRows[0].line2,
        city: addrRows[0].city,
        postcode: addrRows[0].postcode,
        contact_person_name: addrRows[0].contact_person_name,
        contact_person_number: addrRows[0].contact_person_number,
      };
    } else if (body.address || body.delivery_address) {
      const addr = body.delivery_address || body.address;
      deliveryAddress = typeof addr === 'object'
        ? { ...addr, postcode: addr.postcode || body.postcode || '' }
        : { address: String(addr), postcode: body.postcode || '' };
    } else {
      throw badRequest('Delivery address required for delivery order');
    }
  }

  // Execute order placement in a transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Authoritative item calculation inside transaction
    const { subtotal, calculatedItems } = await calculateAuthoritativeCart(client, rid, rawItems);

    // 2. Authoritative coupon lock and increment inside transaction
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

    // 3. Authoritative delivery charge
    const deliveryCharge = await calculateAuthoritativeDeliveryCharge(client, rid, branchId, orderType, subtotal);

    // 4. Tip and authoritative total
    const tip = Math.max(0, Math.round((Number(body.tip) || 0) * 100) / 100);
    const total = Math.round(Math.max(0, subtotal - discount + deliveryCharge + tip) * 100) / 100;

    // 5. Sequence generation for order ID
    const { rows: seqRows } = await client.query("SELECT nextval('orders_id_seq') AS id");
    const orderId = Number(seqRows[0].id);

    // 6. Customer record lookup
    let customerSnapshot = null;
    if (req.user?.sub || req.user?.id) {
      const { rows: custRows } = await client.query(
        `SELECT id, name, email, phone FROM customers WHERE id = $1 AND restaurant_id = $2`,
        [customerId, rid],
      );
      customerSnapshot = custRows[0];
    }
    if (!customerSnapshot) {
      customerSnapshot = {
        id: customerId,
        name: body.customer?.name || deliveryAddress?.contact_person_name || req.user?.name || 'Guest Customer',
        email: body.customer?.email || req.user?.email || '',
        phone: body.customer?.phone || deliveryAddress?.contact_person_number || req.user?.phone || '',
      };
    }

    // 7. Assemble order object
    const history = [{ status: 'pending', at: new Date().toISOString(), by: 'Customer' }];
    const orderData = {
      ...(body.data && typeof body.data === 'object' ? body.data : {}),
      ...(idempotencyKey ? { idempotency_key: String(idempotencyKey), sync_key: String(idempotencyKey) } : {}),
      note: body.order_note || body.note || '',
    };

    // Customer checkout is always unpaid until payment gateway confirms webhook or COD is paid at till
    const paymentStatus = 'unpaid';
    const paymentMethod = body.payment_method || 'cash_on_delivery';

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
        customerId, deliveryAddressId, JSON.stringify(deliveryAddress),
      ],
    );

    await client.query('COMMIT');
    const createdOrder = parseOrder(inserted[0]);
    created(res, {
      order_id: String(createdOrder.id),
      id: createdOrder.id,
      status: createdOrder.status,
      created_at: createdOrder.created_at,
      order_type: createdOrder.order_type,
      payment_method: createdOrder.payment_method,
      payment_status: createdOrder.payment_status,
      subtotal: createdOrder.subtotal,
      discount: createdOrder.discount,
      delivery_charge: createdOrder.delivery_charge,
      total: createdOrder.total,
      message: 'Order placed successfully',
      order: createdOrder,
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
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [rid, customerId, limit, skip],
  );

  ok(res, {
    total_size: totalSize,
    limit,
    offset,
    orders: rows.map(parseOrder),
  });
}));

/**
 * GET /api/v1/customer/order/details
 * Returns full details of an order owned by the authenticated customer.
 */
router.get('/details', requireAuth, asyncHandler(async (req, res) => {
  const rid = restaurantId(req);
  const customerId = req.user.sub || req.user.id;
  const orderId = req.query.order_id || req.query.id;
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

  ok(res, parseOrder(rows[0]));
}));

/**
 * GET /api/v1/customer/order/track
 * Safe customer order tracking projection that does not leak internal data or other customers.
 */
router.get('/track', optionalAuth, asyncHandler(async (req, res) => {
  const orderId = req.query.order_id || req.query.id;
  if (!orderId) {
    throw badRequest('order_id is required');
  }

  const { rows } = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
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
        throw forbidden('Access denied to this order tracking');
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
      throw forbidden('Verification required to track this order');
    }
  }

  // Safe tracking projection — internal ledger/till tokens and profit margins are omitted
  ok(res, {
    order_id: Number(order.id),
    status: order.status,
    order_type: order.order_type,
    payment_status: order.payment_status,
    payment_method: order.payment_method,
    created_at: order.created_at,
    history: order.history || [],
    delivery_address: order.delivery_address || null,
    driver_distance_km: order.driver_distance_km != null ? Number(order.driver_distance_km) : null,
    delivery_man_assigned: !!order.delivery_man_id,
    items_count: Array.isArray(order.items) ? order.items.length : 0,
  });
}));

/**
 * PUT /api/v1/customer/order/cancel
 * Allows a customer to cancel a pending order before preparation starts.
 */
router.put('/cancel', requireAuth, asyncHandler(async (req, res) => {
  const rid = restaurantId(req);
  const customerId = req.user.sub || req.user.id;
  const orderId = req.body && (req.body.order_id || req.body.id);
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
  if (order.status !== 'pending') {
    throw badRequest(`Cannot cancel order in "${order.status}" status`);
  }

  const history = Array.isArray(order.history) ? [...order.history] : [];
  history.push({ status: 'canceled', at: new Date().toISOString(), by: 'Customer' });

  const { rows: updated } = await pool.query(
    `UPDATE orders
     SET status = 'canceled', history = $3, updated_at = NOW()
     WHERE id = $1 AND restaurant_id = $2
     RETURNING *`,
    [orderId, rid, JSON.stringify(history)],
  );

  ok(res, {
    message: 'Order canceled successfully',
    order: parseOrder(updated[0]),
  });
}));

router.calculateAuthoritativeCart = calculateAuthoritativeCart;

module.exports = router;

