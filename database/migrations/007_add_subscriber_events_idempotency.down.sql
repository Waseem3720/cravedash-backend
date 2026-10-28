-- 007_add_subscriber_events_idempotency.down.sql
-- Drops unique index for subscriber_events idempotency

DROP INDEX IF EXISTS uq_subscriber_events_idempotency;
