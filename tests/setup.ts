// Set required env vars before any module import validates them
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_chatbox';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 'test').toString('base64');
process.env.META_APP_SECRET = 'test-app-secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'test-verify-token-must-be-at-least-32-chars!!';
process.env.ADMIN_API_KEY = 'test-admin-key-must-be-at-least-32-chars-long!!';
process.env.JWT_SECRET = 'test-jwt-secret-minimum-length-for-testing-ok-32+';
process.env.JWT_ISSUER = 'chatbox-api';
process.env.JWT_AUDIENCE = 'chatbox-clients';
process.env.META_API_VERSION = 'v21.0';
process.env.POLICY_VERSION = '1.0';
process.env.PHONE_HASH_SECRET = 'test-phone-hash-secret-must-be-32-chars-longxxx';
process.env.NODE_ENV = 'test';
