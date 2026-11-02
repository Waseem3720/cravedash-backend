# CraveDash EPOS Terminal & Floor Operations — API Specification & Contract

This document is the official, complete API specification and contract for the **CraveDash EPOS Terminal & Floor Operations Interface**. It provides frontend, POS, and QA application engineers with exact endpoint routes, HTTP methods, authentication headers, request bodies, query parameters, data types, exact seeded credentials, and JSON response shapes.

Every endpoint documented below is validated against the active backend services and database schema. All foreign keys and referenced entities exist out-of-the-box in the seeded environment.

---

## Architecture & General Guidelines

- **Base URL (Production default):** `https://cravedash.keydevs.net`
- **Base URL (Local development):** `http://127.0.0.1:4000` (API Gateway)
- **API Prefix:** `/api/v1`
- **Multi-Tenancy & Restaurant Scope:**  
  All EPOS requests are restaurant-scoped. In single-store deployments (e.g., Porto Piri Piri `r1`), the API Gateway and backend automatically resolve the tenant. When managing multiple branches or tills, include the optional header:  
  `X-Restaurant-Id: r1`
- **Two-Role Authentication System:**
  1. **Manager / EPOS Terminal Device** (`role: "epos"`): Used by the physical till workstation to authenticate the device, bind till sessions, process orders, run cash drawer counts, print dockets, and record clock punches.
  2. **Restaurant Admin / Supervisor** (`role: "restaurant"`): Used by restaurant managers for storewide administration, catalog management, supervisor overrides, and end-of-day Z reconciliations.
  *(Note: Deliveryman/rider, kitchen chef, and customer accounts are separate interfaces and do not sign into the EPOS till).*
- **Dual-Token Security Model:**
  - **Device / Terminal Token (`Authorization: Bearer <device_jwt>`):** Obtained from `POST /api/v1/auth/login`. This identifies the physical hardware terminal and authorizes it against the backend.
  - **Staff Operator Token (`X-Epos-Staff-Token: <staff_token>`):** Obtained from `POST /api/v1/epos/pin/verify` when a cashier, server, or manager enters their 4–8 digit PIN. Sensitive operations (such as voids, discounts, shifts, and catalog edits) pass this header to audit which staff member performed the action.
- **Idempotency Header:**
  - For financial transactions, order creation, and sync pushes, always supply a unique UUID in the `Idempotency-Key` header:  
    `Idempotency-Key: <unique-uuid-v4>`

---

## Seeded Out-of-the-Box Credentials & Test Entities

All credentials and records below are seeded by `scripts/seed-full.js` and `scripts/init-db.sql`. You can run every endpoint in Postman without creating pre-requisite records.

### 1. User & Terminal Sign-In Credentials
| Role | Email / Login | Password | Restaurant ID | Till ID | Notes |
|------|---------------|----------|---------------|---------|-------|
| **EPOS Terminal** | `till1@portopiripiri.example` | `demo12345` | `r1` | `till-1` | Live server & local primary till workstation login |
| **EPOS Terminal (Alias)** | `till@portopiripiri.example` / `till1@cravedash.com` | `demo12345` | `r1` | `till-1` | Storefront till login / local alias |
| **Restaurant Supervisor** | `owner@portopiripiri.example` | `demo12345` | `r1` | *Unbound* | Live server & local restaurant manager / backoffice |
| **Restaurant Admin (Alias)**| `admin@cravedash.com` | `demo12345` | `r1` | *Unbound* | Store admin account / local alias |

### 2. EPOS Till Staff & PIN Keypad
| Staff ID | Full Name | Numeric PIN | Role | Till Binding | Manager Approver |
|----------|-----------|-------------|------|--------------|------------------|
| `ts1` (or `stf_alex_01`) | Alex Khan | `1234` | `manager` | `till-1` | Yes (`can_approve: true`) |
| `ts2` | Sarah Johnson | `2345` | `supervisor` | `till-1` | Yes (`can_approve: true`) |
| `ts3` | Maria Clarke | `3456` | `cashier` | `till-1` | No |
| `ts4` | Omar Ali | `4567` | `cashier` | `till-1` | No |

### 3. Seeded Entities Ready for Testing
- **Restaurant:** `r1` (Porto Piri Piri, Currency: GBP `£`, VAT: 20%)
- **Tills:** `till-1` ("Till 1 - Front Counter"), `till_01`, `till_main_01`
- **Dining Tables:** `T1` to `T15` (e.g. `T1` = Table 1 in Main Hall)
- **Menu Categories:** `cat1` ("Burger"), `cat2` ("Wraps"), etc. Deletable test category: `cat_demo_delete`
- **Menu Products:** `p1` ("Classic Burger", £8.99). Deletable test product: `p_demo_delete`
- **Addons:** `ad1` ("Extra Cheese", £0.60)
- **Sample Order:** `10041` (Status: `pending`, Dine-in, Table `T1`, Total: £21.00)
- **Held Cart Tab:** `hold_m29bk14` (Label: "Window Table 7 - Sarah", Total: £17.98)
- **Customer CRM:** `cust_1002` ("Alex Johnson", Phone: `+447123456789`). Deletable test customer: `cust_demo_delete`

---

## Standard Response & Error Envelopes

### Success Envelope
All successful backend endpoints return HTTP 200 or 201 with the standard response wrapper:

```json
{
  "success": true,
  "data": { ... }
}
```

> **Frontend Implementation Tip:** If your HTTP client (e.g., Axios or TanStack Query) intercepts responses, unwrap `response.data.data` (or `response.data`) to access the payload.

### Error Envelope
On failure, endpoints return appropriate HTTP status codes (400, 401, 403, 404, 429, 500) with a structured error object:

```json
{
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Human-readable description of what went wrong"
  }
}
```

Common error codes:
- `UNAUTHORIZED`: Missing or invalid Bearer JWT or Staff PIN.
- `FORBIDDEN`: Insufficient permissions (e.g., cashier attempting manager Z-count without supervisor rights).
- `NOT_FOUND`: Resource (order, product, customer, till) does not exist in the tenant scope.
- `INVALID_PIN`: Incorrect PIN entered or account locked after repeated failures.
- `BAD_REQUEST`: Missing required body parameters.

---

## Postman Quick-Start & Step-by-Step Testing Sequence

To execute all 32 endpoints in Postman sequentially with zero errors:

1. **Set Environment Variables in Postman:**
   - `baseUrl`: `http://127.0.0.1:4000/api/v1`
   - `restaurantId`: `r1`
   - `tillId`: `till-1`

2. **Step 1: Terminal Device Sign-In (Endpoint 1)**
   - Call `POST {{baseUrl}}/auth/login` with `till1@cravedash.com` / `demo12345`.
   - In Tests tab: `pm.environment.set("device_jwt", pm.response.json().data.token);`
   - Set Header for all subsequent requests: `Authorization: Bearer {{device_jwt}}`.

3. **Step 2: Staff PIN Verification (Endpoint 2)**
   - Call `POST {{baseUrl}}/epos/pin/verify` with `pin: "1234"` and `staff_id: "ts1"`.
   - In Tests tab: `pm.environment.set("staff_token", pm.response.json().data.staff_token);`
   - Set Header for sensitive EPOS requests: `X-Epos-Staff-Token: {{staff_token}}`.

4. **Step 3: Till Check-In (Endpoint 15)**
   - Call `POST {{baseUrl}}/epos/check-in` with `till_id: "till-1"`, `staff_id: "ts1"`, `opening_float: 150`.
   - In Tests tab: `pm.environment.set("checkin_id", pm.response.json().data.id);`

5. **Step 4: Execute Any of the Remaining 29 Endpoints in Any Order**
   - Live orders, catalog queries, offline sync, caller ID, CRM customer management, held carts, and hardware calls all operate smoothly against the pre-seeded records.

---

## 1. Summary of Required Endpoints (32 Endpoints)

| # | Method | Path | Service | Auth / Headers | Summary / Capability |
|---|--------|------|---------|----------------|----------------------|
| 1 | `POST` | `/api/v1/auth/login` | `auth-service` | Public | Terminal / Manager device login |
| 2 | `POST` | `/api/v1/epos/pin/verify` | `epos-service` | Bearer | Staff PIN entry & JWT issuance |
| 3 | `GET` | `/api/v1/epos/staff` | `epos-service` | Bearer | Retrieve active restaurant till staff |
| 4 | `POST` | `/api/v1/sync/push` | `epos-service` | Bearer + Staff Token | Flush offline queued orders & events |
| 5 | `GET` | `/api/v1/sync/pull` | `epos-service` | Bearer | Fetch delta updates since timestamp |
| 6 | `GET` | `/api/v1/catalog` | `catalog-service` | Bearer / API Key | Full menu catalog bundle |
| 7 | `GET` | `/api/v1/orders` | `order-service` | Bearer + Staff Token | Live orders list with filter & search |
| 8 | `POST` | `/api/v1/orders` | `order-service` | Bearer + Staff Token | Create & submit an EPOS order |
| 9 | `PUT` | `/api/v1/orders/{id}` | `order-service` | Bearer + Staff Token | Modify / amend an existing order |
| 10 | `POST` | `/api/v1/orders/{id}/status` | `order-service` | Bearer + Staff Token | Transition order status |
| 11 | `POST` | `/api/v1/orders/{id}/accept` | `order-service` | Bearer + Staff Token | Accept incoming order with prep time |
| 12 | `POST` | `/api/v1/orders/{id}/reject` | `order-service` | Bearer + Staff Token | Reject incoming order with reason |
| 13 | `POST` | `/api/v1/epos/held-orders` | `epos-service` | Bearer + Staff Token | Park / hold a cart tab |
| 14 | `DELETE` | `/api/v1/epos/held-orders/{id}` | `epos-service` | Bearer + Staff Token | Recall / unpark / discard held cart |
| 15 | `POST` | `/api/v1/epos/check-in` | `epos-service` | Bearer + Staff Token | Open till shift with opening float |
| 16 | `POST` | `/api/v1/epos/check-out` | `epos-service` | Bearer + Staff Token | Close till shift with closing count |
| 17 | `POST` | `/api/v1/epos/counts/x` | `epos-service` | Bearer + Staff Token | Mid-shift X-read cash count |
| 18 | `POST` | `/api/v1/epos/counts/z` | `epos-service` | Bearer + Staff Token | End-of-day Z-report reconciliation |
| 19 | `POST` | `/api/v1/engines/terminals/charge` | `restaurant-service` | Bearer | Initiate smart card terminal payment |
| 20 | `POST` | `/api/v1/print/jobs` | `restaurant-service` | Bearer | Queue receipt / kitchen ticket print job |
| 21 | `GET` | `/api/v1/callerid/live` | `restaurant-service` | Bearer | Poll live incoming telephone calls |
| 22 | `POST` | `/api/v1/epos/timeclock` | `epos-service` | Bearer + Staff Token | Staff clock-in, clock-out & breaks |
| 23 | `POST` | `/api/v1/products` | `catalog-service` | Bearer + Staff Token | Create a new food product / item |
| 24 | `PUT` | `/api/v1/products/{id}` | `catalog-service` | Bearer + Staff Token | Update product details / pricing |
| 25 | `DELETE` | `/api/v1/products/{id}` | `catalog-service` | Bearer + Staff Token | Delete / archive a menu product |
| 26 | `POST` | `/api/v1/categories` | `catalog-service` | Bearer + Staff Token | Create a new menu category |
| 27 | `PUT` | `/api/v1/categories/{id}` | `catalog-service` | Bearer + Staff Token | Update category name / sort / colour |
| 28 | `DELETE` | `/api/v1/categories/{id}` | `catalog-service` | Bearer + Staff Token | Delete a menu category |
| 29 | `GET` | `/api/v1/customers` | `restaurant-service` | Bearer + Staff Token | Search & list customer CRM records |
| 30 | `POST` | `/api/v1/customers` | `restaurant-service` | Bearer + Staff Token | Create a new customer profile |
| 31 | `PUT` | `/api/v1/customers/{id}` | `restaurant-service` | Bearer + Staff Token | Update customer profile & notes |
| 32 | `DELETE` | `/api/v1/customers/{id}` | `restaurant-service` | Bearer + Staff Token | Remove / anonymize customer record |

---

## 2. Detailed Endpoint Specifications

### Section 1: Authentication & Staff PIN Sessions

---

#### 1. POST `/api/v1/auth/login`
Authenticates the terminal workstation device or a restaurant supervisor account. Yields a long-lived device JWT that is stored locally in the POS application storage.

- **Service:** `auth-service`
- **Authentication:** Public (Rate limited: 30 requests per 15 minutes per IP)
- **Headers:**  
  `Content-Type: application/json`  
  `X-Restaurant-Id: r1` *(optional)*

##### Request Body (Terminal / EPOS Role)
```json
{
  "email": "till1@portopiripiri.example",
  "password": "demo12345",
  "role": "epos"
}
```
*(Note: `till1@portopiripiri.example` is active on both the live server `https://cravedash.keydevs.net` and local instances. Local environments also support `till1@cravedash.com`).*

##### Request Body (Restaurant Admin / Supervisor Role)
```json
{
  "email": "owner@portopiripiri.example",
  "password": "demo12345",
  "role": "restaurant"
}
```
*(Note: `owner@portopiripiri.example` is active on both the live server and local instances. Local environments also support `admin@cravedash.com`).*

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1X2Vwb3NfY3JhdmVkYXNoIiwicm9sZSI6ImVwb3MiLCJyZXN0YXVyYW50X2lkIjoicjEiLCJ0aWxsX2lkIjoidGlsbC0xIn0...",
    "user": {
      "id": "u_epos_cravedash",
      "email": "till1@cravedash.com",
      "role": "epos",
      "restaurant_id": "r1",
      "name": "Till 1 - Front Counter",
      "till_id": "till-1",
      "branch_id": "main"
    }
  }
}
```

---

#### 2. POST `/api/v1/epos/pin/verify`
Authenticates a staff member on the EPOS lock screen using their numeric PIN (4–8 digits). When successful, yields an audited `staff_token` containing the operator's identity, role, and till binding.

- **Service:** `epos-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`

##### Request Body (Staff PIN Entry)
```json
{
  "pin": "4826",
  "till_id": "till-1",
  "staff_id": "ts_manager"
}
```
*(Note: Active staff on the server are: `ts_manager` with PIN **`4826`** (Manager), `ts_supervisor` with PIN **`8392`** (Supervisor), and `ts_cashier` with PIN **`9512`** (Cashier). If `staff_id` is omitted on a quick manager-override PIN pad, the backend automatically scans active approver staff matching the PIN).*

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "verified": true,
    "staff": {
      "id": "ts_manager",
      "name": "Alex Manager",
      "role": "manager",
      "till_id": "till-1"
    },
    "staff_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdGFmZl9pZCI6InRzX21hbmFnZXIiLCJzdGFmZl9uYW1lIjoiQWxleCBNYW5hZ2VyIiwic3RhZmZfcm9sZSI6Im1hbmFnZXIiLCJyZXN0YXVyYW50X2lkIjoicjEiLCJ0aWxsX2lkIjoidGlsbC0xIn0..."
  }
}
```

---

#### 3. GET `/api/v1/epos/staff`
Retrieves all active staff members configured for the restaurant till. Used to populate the cashier switch dropdown, avatar selection list, or fast-punch PIN pad.

- **Service:** `epos-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Authorization: Bearer <device_jwt>`

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": [
    {
      "id": "ts1",
      "restaurant_id": "r1",
      "name": "Alex Khan",
      "role": "manager",
      "status": true,
      "till_id": "till-1",
      "data": {
        "can_approve": true
      }
    },
    {
      "id": "ts2",
      "restaurant_id": "r1",
      "name": "Sarah Johnson",
      "role": "supervisor",
      "status": true,
      "till_id": "till-1",
      "data": {
        "can_approve": true
      }
    },
    {
      "id": "ts3",
      "restaurant_id": "r1",
      "name": "Maria Clarke",
      "role": "cashier",
      "status": true,
      "till_id": "till-1",
      "data": {
        "can_approve": false
      }
    },
    {
      "id": "ts4",
      "restaurant_id": "r1",
      "name": "Omar Ali",
      "role": "cashier",
      "status": true,
      "till_id": "till-1",
      "data": {
        "can_approve": false
      }
    }
  ]
}
```

---

### Section 2: Offline Synchronization & Data Caching

---

#### 4. POST `/api/v1/sync/push`
Transfers queued offline transactions, sales, or held orders stored locally in the POS outbox database (e.g. IndexedDB or SQLite) to the server. The backend processes entries sequentially and records an idempotency key to prevent double charging or duplicate sales. Supports both itemized and batch syntax.

- **Service:** `epos-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*

##### Request Body
```json
{
  "items": [
    {
      "idempotency_key": "sync_batch_item_1001",
      "entity": "order",
      "op": "create",
      "client_id": "ord_local_98765",
      "payload": {
        "order_type": "dine_in",
        "table_id": "T1",
        "payment_method": "cash",
        "subtotal": 21.00,
        "total": 21.00,
        "items": [
          {
            "id": "p1",
            "name": "Classic Burger",
            "qty": 2,
            "price": 8.99,
            "addons": []
          },
          {
            "id": "ad1",
            "name": "Extra Cheese",
            "qty": 2,
            "price": 0.60
          }
        ],
        "customer": {
          "name": "Walk-in Guest",
          "phone": ""
        }
      }
    }
  ]
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "results": [
      {
        "key": "sync_batch_item_1001",
        "status": "acked",
        "server_id": "100201",
        "client_id": "ord_local_98765",
        "result": {
          "created": true
        }
      }
    ]
  }
}
```

---

#### 5. GET `/api/v1/sync/pull`
Pulls incremental catalog modifications, menu updates, active tables, staff, and held orders updated on the server since a specific timestamp cursor.

- **Service:** `epos-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Authorization: Bearer <device_jwt>`
- **Query Parameters:**
  - `since` *(string, optional)*: ISO-8601 timestamp cursor (e.g., `2026-11-01T00:00:00.000Z`).

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "server_time": "2026-11-02T11:00:00.000Z",
    "categories": [
      { "id": "cat1", "num": 1, "name": "Burger", "colour": "#0b84f3", "priority": 1 }
    ],
    "products": [
      { "id": "p1", "name": "Classic Burger", "price": 8.99, "status": true }
    ],
    "addons": [
      { "id": "ad1", "name": "Extra Cheese", "price": 0.60, "status": true }
    ],
    "tables": [
      { "id": "T1", "number": 1, "area_id": "area1", "shape": "square", "seats": 2 }
    ],
    "staff": [
      { "id": "ts1", "name": "Alex Khan", "role": "manager", "till_id": "till-1" }
    ],
    "held_orders": [
      { "id": "hold_m29bk14", "label": "Window Table 7 - Sarah" }
    ],
    "orders": []
  }
}
```

---

### Section 3: Menu & Food Catalog

---

#### 6. GET `/api/v1/catalog`
Fetches the complete food menu bundle for the restaurant, including categories, products with variations, and standalone add-ons. Used during initial till boot to seed the local catalog cache.

- **Service:** `catalog-service`
- **Authentication:** `Authorization: Bearer <device_jwt>` or `X-API-KEY: <api_key>`
- **Headers:**  
  `Authorization: Bearer <device_jwt>`

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "categories": [
      {
        "id": 1,
        "name": "Burger",
        "image": ""
      }
    ],
    "products": [
      {
        "id": 1,
        "name": "Classic Burger",
        "category_id": 1,
        "price": 8.99,
        "from_price": 8.99,
        "status": true,
        "visible": true,
        "description": "",
        "variations": [],
        "addons": []
      }
    ],
    "addons": [
      {
        "id": "ad1",
        "name": "Extra Cheese",
        "price": 0.60
      }
    ],
    "deals": []
  }
}
```

---

### Section 4: Till Shift Management & Reconciliations

---

#### 15. POST `/api/v1/epos/check-in`
Opens a new cashier till shift with an opening cash float amount. Initialises report counters for the shift.

- **Service:** `epos-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*

##### Request Body
```json
{
  "till_id": "till-1",
  "staff_id": "ts1",
  "opening_float": 150.00
}
```

##### Success Response (201 Created)
```json
{
  "success": true,
  "data": {
    "id": "ci_m29a8f10",
    "restaurant_id": "r1",
    "till_id": "till-1",
    "staff_id": "ts1",
    "opening_float": "150.00",
    "checked_in_at": "2026-11-02T08:00:00.000Z",
    "checked_out_at": null,
    "data": {}
  }
}
```

---

#### 16. POST `/api/v1/epos/check-out`
Closes an open till shift session. Accepts `checkin_id` (or `session_id`) and records closing cash drawer counts.

- **Service:** `epos-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*

##### Request Body
```json
{
  "checkin_id": "ci_m29a8f10",
  "closing_counts": {
    "cash": 485.50,
    "card": 1250.00
  }
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": "ci_m29a8f10",
    "restaurant_id": "r1",
    "till_id": "till-1",
    "staff_id": "ts1",
    "opening_float": "150.00",
    "checked_in_at": "2026-11-02T08:00:00.000Z",
    "checked_out_at": "2026-11-02T16:30:00.000Z",
    "data": {
      "closing_counts": {
        "cash": 485.50,
        "card": 1250.00
      }
    }
  }
}
```

---

#### 17. POST `/api/v1/epos/counts/x`
Executes an interim mid-shift reading (X-Read). Increments the `x_counter` without resetting daily revenue or sales counters.

- **Service:** `epos-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*

##### Request Body
```json
{
  "by": "Alex Khan"
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "xCounter": 483,
    "zCounter": 1041,
    "periodStart": "2026-11-02T00:00:00.000Z",
    "openingFloat": 150,
    "lastX": {
      "x_no": 483,
      "at": "2026-11-02T13:00:00.000Z",
      "by": "Alex Khan"
    }
  }
}
```

---

#### 18. POST `/api/v1/epos/counts/z`
Executes an end-of-day final reconciliation (Z-Report). Resets shift cash movement buckets, logs the reconciliation entry, and increments the restaurant Z-counter.

- **Service:** `epos-service`
- **Authentication:** `Authorization: Bearer <device_jwt>` (or Supervisor/Manager Session)
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <supervisor_staff_token>`

##### Request Body
```json
{
  "till_id": "till-1",
  "by": "Alex Khan",
  "counted_cash": 760.50,
  "variance": 0.00,
  "opening_float": 150.00
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "xCounter": 483,
    "zCounter": 1042,
    "periodStart": "2026-11-02T22:00:00.000Z",
    "openingFloat": 150,
    "history": [
      {
        "z_no": 1041,
        "generated_at": "2026-11-02T22:00:00.000Z",
        "by": "Alex Khan",
        "terminal": "Terminal 1",
        "till_id": "till-1",
        "counted_cash": 760.50,
        "variance": 0.00
      }
    ]
  }
}
```

---

### Section 5: Order Creation & Order Lifecycle

---

#### 7. GET `/api/v1/orders`
Retrieves live orders for the till station, with support for status filtering, pagination, date bounding, and audio alert polling.

- **Service:** `order-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*
- **Query Parameters:**
  - `status` *(string, optional)*: Filter by status (`pending`, `confirmed`, `cooking`, `ready_for_serve`, `completed`, `canceled`).
  - `limit` *(integer, optional, default: 100)*: Max records.

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": [
    {
      "id": 10041,
      "restaurant_id": "r1",
      "order_type": "dine_in",
      "table_id": "T1",
      "status": "pending",
      "payment_status": "unpaid",
      "payment_method": "cash",
      "subtotal": 19.18,
      "total": 21.00,
      "items": [
        {
          "id": "p1",
          "name": "Classic Burger",
          "quantity": 2,
          "price": 8.99,
          "total": 17.98
        },
        {
          "id": "ad1",
          "name": "Extra Cheese",
          "quantity": 2,
          "price": 0.60,
          "total": 1.20
        }
      ],
      "customer": {
        "name": "Walk-in Customer",
        "phone": "+447123456789"
      },
      "created_at": "2026-11-02T10:00:00.000Z"
    }
  ]
}
```

---

#### 8. POST `/api/v1/orders`
Submits a new order placed directly at the till. Supports `dine_in`, `takeaway`, or direct phone `delivery`.

- **Service:** `order-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*  
  `Idempotency-Key: <unique-uuid-v4>`

##### Request Body
```json
{
  "client_id": "epos_cli_order_1001",
  "order_type": "dine_in",
  "table_id": "T1",
  "payment_method": "cash",
  "payment_status": "paid",
  "subtotal": 21.00,
  "discount": 0.00,
  "delivery_charge": 0.00,
  "service_charge": 0.00,
  "total": 21.00,
  "items": [
    {
      "id": "p1",
      "name": "Classic Burger",
      "quantity": 2,
      "price": 8.99,
      "addons": []
    },
    {
      "id": "ad1",
      "name": "Extra Cheese",
      "quantity": 2,
      "price": 0.60
    }
  ],
  "customer": {
    "name": "Walk-in Guest",
    "phone": "+447123456789"
  },
  "note": "Extra napkins please"
}
```

##### Success Response (201 Created)
```json
{
  "success": true,
  "data": {
    "id": 100202,
    "restaurant_id": "r1",
    "order_type": "dine_in",
    "status": "pending",
    "payment_status": "paid",
    "payment_method": "cash",
    "total": 21.00,
    "table_id": "T1",
    "created_at": "2026-11-02T11:05:00.000Z"
  }
}
```

---

#### 9. PUT `/api/v1/orders/{id}`
Modifies an existing open order (e.g., table guest orders an extra drink, or updates order item choices). Use seeded order `10041`.

- **Service:** `order-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*
- **Path Parameters:**
  - `id` *(string / integer, required)*: The order ID (e.g. `10041`).

##### Request Body
```json
{
  "order_type": "dine_in",
  "table_id": "T1",
  "items": [
    {
      "id": "p1",
      "name": "Classic Burger",
      "quantity": 2,
      "price": 8.99
    },
    {
      "id": "ad1",
      "name": "Extra Cheese",
      "quantity": 2,
      "price": 0.60
    }
  ],
  "note": "Table 1 - Updated with extra sauce"
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": 10041,
    "restaurant_id": "r1",
    "status": "pending",
    "total": 21.00,
    "note": "Table 1 - Updated with extra sauce",
    "updated_at": "2026-11-02T11:08:00.000Z"
  }
}
```

---

#### 10. POST `/api/v1/orders/{id}/status`
Transitions an order to a new state in the restaurant fulfillment cycle. Valid statuses: `pending`, `confirmed`, `cooking`, `ready_for_serve`, `completed`, `canceled`. Use seeded order `10041`.

- **Service:** `order-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*
- **Path Parameters:**
  - `id` *(string / integer, required)*: The order identifier (e.g. `10041`).

##### Request Body
```json
{
  "status": "confirmed",
  "note": "Order confirmed by front counter"
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": 10041,
    "status": "confirmed",
    "updated_at": "2026-11-02T11:10:00.000Z"
  }
}
```

---

#### 11. POST `/api/v1/orders/{id}/accept`
Accepts an incoming web, app, or aggregator order onto the kitchen line and communicates estimated preparation time. Order must be in `pending` status. Use seeded order `10041`.

- **Service:** `order-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*
- **Path Parameters:**
  - `id` *(string / integer, required)*: The order identifier (e.g. `10041`).

##### Request Body
```json
{
  "prep_time": 20,
  "note": "Accepted by kitchen staff"
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": 10041,
    "status": "confirmed",
    "acknowledged": true,
    "data": {
      "prep_time": 20,
      "cook_time_minutes": 20,
      "station": "Kitchen Main",
      "accept_note": "Accepted by kitchen staff"
    },
    "updated_at": "2026-11-02T11:12:00.000Z"
  }
}
```

---

#### 12. POST `/api/v1/orders/{id}/reject`
Rejects an incoming order when the kitchen is busy, an item is out of stock, or customer requested cancellation. Valid for orders in `pending` or `confirmed` status. Use seeded order `10041`.

- **Service:** `order-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*
- **Path Parameters:**
  - `id` *(string / integer, required)*: The order identifier (e.g. `10041`).

##### Request Body
```json
{
  "reason": "Kitchen at peak capacity during lunch rush",
  "note": "Kitchen at peak capacity during lunch rush"
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": 10041,
    "status": "cancelled",
    "acknowledged": true,
    "note": "Kitchen at peak capacity during lunch rush",
    "data": {
      "cancel_reason": "Kitchen at peak capacity during lunch rush",
      "rejection_reason": "Kitchen at peak capacity during lunch rush"
    },
    "updated_at": "2026-11-02T11:14:00.000Z"
  }
}
```

---

### Section 6: Held / Parked Carts

---

#### 13. POST `/api/v1/epos/held-orders`
Parks an uncompleted transaction basket so the cashier can serve the next customer in queue, and later resume the held tab.

- **Service:** `epos-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*

##### Request Body
```json
{
  "id": "hold_sample_02",
  "till_id": "till-1",
  "label": "Counter Tab - Peter",
  "cart": [
    {
      "id": "p1",
      "name": "Classic Burger",
      "qty": 1,
      "price": 8.99
    }
  ]
}
```

##### Success Response (201 Created)
```json
{
  "success": true,
  "data": {
    "id": "hold_sample_02",
    "restaurant_id": "r1",
    "till_id": "till-1",
    "label": "Counter Tab - Peter",
    "payload": {
      "id": "hold_sample_02",
      "till_id": "till-1",
      "label": "Counter Tab - Peter",
      "cart": [
        {
          "id": "p1",
          "name": "Classic Burger",
          "qty": 1,
          "price": 8.99
        }
      ]
    },
    "created_at": "2026-11-02T11:16:00.000Z"
  }
}
```

---

#### 14. DELETE `/api/v1/epos/held-orders/{id}`
Recalls and removes a parked order from the server held tab database once it has been resumed and paid, or discarded. Use seeded held order `hold_m29bk14`.

- **Service:** `epos-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*
- **Path Parameters:**
  - `id` *(string, required)*: The held order ID (e.g. `hold_m29bk14`).

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": "hold_m29bk14",
    "removed": true
  }
}
```

---

### Section 7: Hardware & Peripheral Integrations

---

#### 19. POST `/api/v1/engines/terminals/charge`
Sends a payment prompt to a smart card terminal (e.g., Stripe Terminal, WisePOS E) connected to the till station.

- **Service:** `restaurant-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `Idempotency-Key: <unique-uuid-v4>`

##### Request Body
```json
{
  "order_id": "10041",
  "amount": 21.00,
  "currency": "gbp",
  "reader_id": "tmr_counter_pos_1",
  "channel": "pos"
}
```

> **Environment Note:** When running in test environments without live Stripe credentials configured, returns HTTP 400 (`"Stripe secret key is not configured"`), validating request validation, fee calculation, and order association. When Stripe test keys are present in `.env`, yields standard `payment_intent` prompt data.

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "status": "requires_payment_method",
    "payment_intent_id": "pi_3MtwL2LkdIwHu7ix28a3tqPa",
    "reader_id": "tmr_counter_pos_1",
    "amount": 21.00,
    "currency": "gbp",
    "message": "Prompt presented on reader display"
  }
}
```

---

#### 20. POST `/api/v1/print/jobs`
Dispatches a print job to an ESC/POS network thermal printer, kitchen ticket printer, or print queue. Queues to `restaurant_blobs` if no physical hardware agent is connected.

- **Service:** `restaurant-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`

##### Request Body
```json
{
  "printer_id": "pr-receipt-1",
  "title": "Kitchen Docket - Table 1",
  "html": "<h3>TABLE 1 - DINE IN</h3><p>2x Classic Burger (£8.99)</p><p>2x Extra Cheese (£0.60)</p>",
  "copies": 1,
  "drawer": false
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "ok": true,
    "via": "queue",
    "job_id": "pj_m29cp40",
    "printer_id": "pr-receipt-1"
  }
}
```

---

#### 21. GET `/api/v1/callerid/live`
Polls live incoming phone calls detected by the restaurant's Caller-ID hardware modem or VoIP SIP trunk. When an incoming call matches a customer, the EPOS screen displays the customer's previous order history.

- **Service:** `restaurant-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Authorization: Bearer <device_jwt>`

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": [
    {
      "id": "call_184920",
      "phone": "+447123456789",
      "customer_name": "Alex Johnson",
      "line": "Line 1",
      "at": "2026-11-02T11:20:00.000Z",
      "status": "ringing"
    }
  ]
}
```

---

#### 22. POST `/api/v1/epos/timeclock`
Records staff attendance time punches (clock in, clock out, break start, break end). Supports both short verbs (`in`, `out`, `break`, `end_break`) and compound verbs (`clock_in`, `clock_out`).

- **Service:** `epos-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*

##### Request Body
```json
{
  "staff_id": "ts1",
  "action": "in"
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "staff_id": "ts1",
    "status": "in",
    "since": "2026-11-02T08:00:00.000Z",
    "recorded_at": "2026-11-02T08:00:00.000Z"
  }
}
```

---

### Section 8: Floor Catalog Quick Modifications

---

#### 23. POST `/api/v1/products`
Allows an EPOS Manager or Restaurant Supervisor to quickly add an item or daily special to the menu directly from the till interface.

- **Service:** `catalog-service`
- **Authentication:** `Authorization: Bearer <device_jwt>` + Staff Token
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>`  
  `Idempotency-Key: <unique-uuid-v4>`

##### Request Body
```json
{
  "name": "Spicy Peri Wings (6 Pcs)",
  "price": 6.95,
  "category_id": "cat1",
  "status": true,
  "visible": true,
  "description": "Grilled wings glazed in spicy sauce"
}
```

##### Success Response (201 Created)
```json
{
  "success": true,
  "data": {
    "id": "pro_m29cp40",
    "restaurant_id": "r1",
    "name": "Spicy Peri Wings (6 Pcs)",
    "price": 6.95,
    "category_id": "cat1",
    "status": true,
    "visible": true,
    "created_at": "2026-11-02T11:22:00.000Z"
  }
}
```

---

#### 24. PUT `/api/v1/products/{id}`
Updates details, price, or availability status of an existing food item. Use seeded product `p1` or created product `pro_m29cp40`.

- **Service:** `catalog-service`
- **Authentication:** `Authorization: Bearer <device_jwt>` + Staff Token
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>`
- **Path Parameters:**
  - `id` *(string, required)*: The product ID (e.g. `p1`).

##### Request Body
```json
{
  "name": "Classic Burger",
  "price": 9.49,
  "status": true
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": "p1",
    "name": "Classic Burger",
    "price": 9.49,
    "status": true,
    "updated_at": "2026-11-02T11:24:00.000Z"
  }
}
```

---

#### 25. DELETE `/api/v1/products/{id}`
Removes or archives a product from the restaurant menu. Use seeded deletable product `p_demo_delete`.

- **Service:** `catalog-service`
- **Authentication:** `Authorization: Bearer <device_jwt>` + Staff Token
- **Headers:**  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>`
- **Path Parameters:**
  - `id` *(string, required)*: Product ID (e.g. `p_demo_delete`).

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": "p_demo_delete",
    "removed": true
  }
}
```

---

#### 26. POST `/api/v1/categories`
Creates a new menu category tile for the EPOS ordering grid.

- **Service:** `catalog-service`
- **Authentication:** `Authorization: Bearer <device_jwt>` + Staff Token
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>`

##### Request Body
```json
{
  "name": "Desserts & Shakes",
  "priority": 5,
  "colour": "#9C27B0",
  "text_colour": "#ffffff",
  "status": true
}
```

##### Success Response (201 Created)
```json
{
  "success": true,
  "data": {
    "id": "cat_m29dq82",
    "restaurant_id": "r1",
    "name": "Desserts & Shakes",
    "priority": 5,
    "colour": "#9C27B0",
    "status": true,
    "created_at": "2026-11-02T11:26:00.000Z"
  }
}
```

---

#### 27. PUT `/api/v1/categories/{id}`
Updates category label, tile display colour, or priority sorting sequence. Use seeded category `cat1` or created category `cat_m29dq82`.

- **Service:** `catalog-service`
- **Authentication:** `Authorization: Bearer <device_jwt>` + Staff Token
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>`
- **Path Parameters:**
  - `id` *(string, required)*: Category ID (e.g. `cat1`).

##### Request Body
```json
{
  "name": "Gourmet Burgers",
  "priority": 1,
  "colour": "#0b84f3"
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": "cat1",
    "name": "Gourmet Burgers",
    "priority": 1,
    "colour": "#0b84f3",
    "updated_at": "2026-11-02T11:28:00.000Z"
  }
}
```

---

#### 28. DELETE `/api/v1/categories/{id}`
Deletes an empty menu category. Use seeded deletable category `cat_demo_delete`.

- **Service:** `catalog-service`
- **Authentication:** `Authorization: Bearer <device_jwt>` + Staff Token
- **Headers:**  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>`
- **Path Parameters:**
  - `id` *(string, required)*: Category ID (e.g. `cat_demo_delete`).

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": "cat_demo_delete",
    "removed": true
  }
}
```

---

### Section 9: Customer Directory & CRM

---

#### 29. GET `/api/v1/customers`
Searches or browses customer CRM records. Filter by telephone number or name substring during phone orders or counter checkout.

- **Service:** `restaurant-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*
- **Query Parameters:**
  - `search` *(string, optional)*: Search query string across name, phone, or email (e.g. `?search=Alex`).
  - `phone` *(string, optional)*: Exact telephone filter (e.g. `?phone=+447123456789`).
  - `limit` *(integer, optional, default: 50)*: Number of records.

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": [
    {
      "id": "cust_1002",
      "restaurant_id": "r1",
      "name": "Alex Johnson",
      "phone": "+447123456789",
      "email": "alex.j@example.com",
      "address": "12 High Street",
      "postcode": "SW1A 1AA",
      "notes": "Door code #4321",
      "rating": 5,
      "status": true,
      "wallet_balance": "15.00",
      "loyalty_points": 120,
      "created_at": "2026-11-02T10:00:00.000Z"
    }
  ]
}
```

---

#### 30. POST `/api/v1/customers`
Creates a new customer profile directly from the EPOS checkout screen. Automatically stores extended CRM fields (`postcode`, `notes`, `rating`) in customer metadata.

- **Service:** `restaurant-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*

##### Request Body
```json
{
  "name": "Jane Doe",
  "phone": "07123456780",
  "email": "jane.doe@example.com",
  "address": "24 Market Road",
  "postcode": "SW1A 2BB",
  "notes": "Allergic to nuts and sesame",
  "rating": 5
}
```

##### Success Response (201 Created)
```json
{
  "success": true,
  "data": {
    "id": "cust_m29ex91",
    "restaurant_id": "r1",
    "name": "Jane Doe",
    "phone": "07123456780",
    "email": "jane.doe@example.com",
    "address": "24 Market Road",
    "postcode": "SW1A 2BB",
    "notes": "Allergic to nuts and sesame",
    "rating": 5,
    "status": true,
    "created_at": "2026-11-02T11:30:00.000Z"
  }
}
```

---

#### 31. PUT `/api/v1/customers/{id}`
Updates contact details, delivery address, or staff notes for an existing customer. Use seeded customer `cust_1002`.

- **Service:** `restaurant-service`
- **Authentication:** `Authorization: Bearer <device_jwt>`
- **Headers:**  
  `Content-Type: application/json`  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>` *(optional)*
- **Path Parameters:**
  - `id` *(string, required)*: The customer identifier (e.g. `cust_1002`).

##### Request Body
```json
{
  "name": "Alex Johnson",
  "phone": "+447123456789",
  "address": "14 High Street, Flat 2B",
  "postcode": "SW1A 1AA",
  "notes": "Door code #4321, ring bell twice",
  "rating": 5
}
```

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": "cust_1002",
    "name": "Alex Johnson",
    "phone": "+447123456789",
    "address": "14 High Street, Flat 2B",
    "postcode": "SW1A 1AA",
    "notes": "Door code #4321, ring bell twice",
    "rating": 5,
    "updated_at": "2026-11-02T11:32:00.000Z"
  }
}
```

---

#### 32. DELETE `/api/v1/customers/{id}`
Removes / anonymizes a customer record from the restaurant CRM directory in compliance with GDPR regulations. Use seeded deletable customer `cust_demo_delete`.

- **Service:** `restaurant-service`
- **Authentication:** `Authorization: Bearer <device_jwt>` + Staff Token
- **Headers:**  
  `Authorization: Bearer <device_jwt>`  
  `X-Epos-Staff-Token: <staff_token>`
- **Path Parameters:**
  - `id` *(string, required)*: Customer ID (e.g. `cust_demo_delete`).

##### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "id": "cust_demo_delete",
    "removed": true
  }
}
```

---

## Appendix: Frontend Engineering Implementation Recommendations

### 1. Offline-First Resilience Workflow
1. **Local Outbox Storage:**  
   When offline, queue newly taken orders into local browser storage (IndexedDB or LocalForage). Generate a local `client_id` (e.g. `ord_loc_<timestamp>`) and unique UUID for the `idempotency_key`.
2. **Pushing on Reconnect:**  
   When the network connection is restored, transmit batch items via `POST /api/v1/sync/push`. If the response returns `status: "acked"`, mark the local record as synchronized and store the returned `server_id`.
3. **Pulling Catalog Deltas:**  
   Store `server_time` from `GET /api/v1/sync/pull`. Poll or refresh every 5–10 minutes using `GET /api/v1/sync/pull?since=<last_server_time>`.

### 2. Dual-Token Management Pattern
- Store the device token (`Authorization: Bearer <device_jwt>`) in persistent storage (e.g. LocalStorage or SecureStore). It remains valid across operator shifts.
- Store the operator staff token (`X-Epos-Staff-Token: <staff_token>`) in session or memory storage. When a cashier locks the screen or is idle for 5 minutes, clear the `X-Epos-Staff-Token` and return to the PIN keypad screen.

### 3. Live Order Polling & Sound Notifications
- Poll `GET /api/v1/orders?status=pending` every 10–15 seconds to receive incoming online orders.
- When an order with `status === "pending"` appears, trigger an audible bell chime on the EPOS terminal audio output until an operator clicks **Accept** (`POST /api/v1/orders/{id}/accept`) or **Reject** (`POST /api/v1/orders/{id}/reject`).
