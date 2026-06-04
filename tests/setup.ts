// Set required env vars before any module import validates them
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_chatbox';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 'test').toString('base64');
process.env.META_APP_SECRET = 'test-app-secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'test-verify-token';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.JWT_SECRET = 'test-jwt-secret-minimum-length-for-testing-ok';
process.env.META_API_VERSION = 'v21.0';
process.env.POLICY_VERSION = '1.0';
process.env.NODE_ENV = 'test';
