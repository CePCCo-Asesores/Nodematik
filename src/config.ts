import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  FIELD_ENCRYPTION_KEY: z.string().min(1),
  SAFETY_PROVIDER_API_KEY: z.string().optional(),
  META_APP_SECRET: z.string().min(1),
  META_API_VERSION: z.string().default('v21.0'),
  WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  ADMIN_API_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  META_APP_ID: z.string().optional(), // required only for Embedded Signup
  POLICY_VERSION: z.string().default('1.0'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

function loadConfig() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map(i => i.path.join('.')).join(', ');
    throw new Error(`Missing or invalid environment variables: ${missing}`);
  }
  return result.data;
}

export const config = loadConfig();
