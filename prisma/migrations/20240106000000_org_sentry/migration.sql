-- Per-tenant Sentry DSN for error tracking, encrypted at rest.
-- NULL means the tenant has not configured a Sentry project.
ALTER TABLE "organizations" ADD COLUMN "sentry_dsn_enc" BYTEA;
