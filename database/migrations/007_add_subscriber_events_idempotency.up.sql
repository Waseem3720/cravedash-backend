-- 007_add_subscriber_events_idempotency.up.sql
-- Adds unique index for subscriber_events idempotency within tenant scope

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriber_events_idempotency 
ON subscriber_events (restaurant_id, idempotency_key) 
WHERE idempotency_key IS NOT NULL;
