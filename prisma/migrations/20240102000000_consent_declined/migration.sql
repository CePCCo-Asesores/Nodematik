-- AlterTable: add consent_declined to track declined users separately from admin-paused
ALTER TABLE "end_users" ADD COLUMN "consent_declined" BOOLEAN NOT NULL DEFAULT false;
