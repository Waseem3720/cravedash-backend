# CraveDash Backend CI/CD

## 1. Run Locally

### Prerequisites
- Node.js 20+ and npm

### 1. Configure Environment
```bash
cp .env.example .env
```
Default values in `.env.example` point to local PostgreSQL on port `5432` (`postgres://cravedash:cravedash@localhost:5432/cravedash`).

### 2. Install Dependencies
```bash
npm install
```

### 3. Initialize Database & Run Migrations
Run the automated setup (starts embedded PostgreSQL in the background, executes canonical migrations, and seeds demo data):
```bash
npm run setup
```
*(Alternatively, if using an existing PostgreSQL instance: `npm run migrate` followed by `npm run seed`)*

### 4. Start Backend Services
Start all microservices with health monitoring and auto-restart:
```bash
npm run dev
```
The API Gateway will be available at `http://127.0.0.1:4000` (health probe: `http://127.0.0.1:4000/health`).

---

## 2. Deploy on Linux Server

### 1. Production Environment Setup
In the deployment directory on the Linux host (e.g. `/opt/cravedash-node`):
```bash
cp .env.example .env
```
Configure `.env` with production parameters:
- `NODE_ENV=production`
- `PGPASSWORD`: Set secure database password (`NEEDS CONFIGURATION`)
- `JWT_SECRET`: Set strong random secret (`NEEDS CONFIGURATION`)
- `INTEGRATIONS_SECRET_KEY`: Set encryption secret (min 16 chars) for integration credentials at rest (`NEEDS CONFIGURATION`)
- `CORS_ORIGIN`: Explicit comma-separated origins without wildcards, e.g. `https://admin.yourdomain.com,https://app.yourdomain.com` (`NEEDS CONFIGURATION` — wildcards or unset values trigger fatal exit in production)
- `GATEWAY_JWT_VERIFY=optional` (or `strict`; must not be `off` in production)
- `STRIPE_SECRET_KEY`: Optional platform Stripe secret key (`NEEDS CONFIGURATION` if Stripe billing is used)
- `STRIPE_WEBHOOK_SECRET`: Optional Stripe webhook signing secret (`NEEDS CONFIGURATION` if Stripe webhooks are used)

### 2. Deploy Stack with Docker Compose
Build images, initialize PostgreSQL, apply migrations, and start all services in detached mode:
```bash
docker compose -f docker-compose.prod.yml up -d --build
```

*(Optional) Seed initial demo/platform data if needed:*
```bash
docker compose -f docker-compose.prod.yml --profile seed up seed
```

### 3. Basic Verification
Verify container status and health checks:
```bash
docker compose -f docker-compose.prod.yml ps
```

Verify API Gateway response on the published loopback port `4100` (the stack publishes `127.0.0.1:4100:4000` for reverse proxying):
```bash
curl -i http://127.0.0.1:4100/health
curl -i http://127.0.0.1:4100/
```

Inspect service and gateway logs:
```bash
docker compose -f docker-compose.prod.yml logs -f gateway
```
