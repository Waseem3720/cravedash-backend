-- Rollback deliveryman_requests and deliveryman_reviews tables (CD-CON-050 / BACKEND-006)

DROP TABLE IF EXISTS deliveryman_reviews CASCADE;
DROP TABLE IF EXISTS deliveryman_requests CASCADE;
