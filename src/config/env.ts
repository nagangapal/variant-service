/**
 * Environment configuration.
 *
 * Parsed and validated once at boot. A service that crashes on a bad env var at
 * startup is dramatically better than one that boots and then fails 500s on every
 * request, because the failure is caught by the deploy rather than by a customer.
 */

import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  // Direct (non-pooled) connection, used only by the LISTEN session.
  //
  // Neon's pooled endpoint is PgBouncer in transaction mode, which cannot hold a
  // session, so LISTEN/NOTIFY silently never fires behind it -- invalidation
  // degrades to TTL-only with no error. The query pool is fine on the pooled URL,
  // so the right setup is pooled DATABASE_URL + direct DATABASE_URL_UNPOOLED,
  // which is also the variable name `neon env pull` writes.
  //
  // Optional: falls back to DATABASE_URL, so a single-URL deployment (or local
  // Postgres) keeps working unchanged.
  DATABASE_URL_UNPOOLED: z.string().url().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(2000),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(3000),

  // Config cache. See services/configCache.ts for the reasoning behind these.
  CONFIG_TTL_MS: z.coerce.number().int().min(100).default(5_000),
  // How long we keep serving a stale snapshot after refreshes start failing.
  // Deliberately long: serving a slightly stale split beats breaking customer pages.
  CONFIG_MAX_STALE_MS: z.coerce.number().int().min(1000).default(3_600_000),

  // Whole-request budget for the assignment endpoint, including the first config load.
  ASSIGNMENT_DEADLINE_MS: z.coerce.number().int().min(1).default(150),
  // Time the tracking endpoint will wait for a durable write before giving up and
  // queueing the event in memory for a later retry.
  TRACK_WRITE_TIMEOUT_MS: z.coerce.number().int().min(1).default(750),
  TRACK_QUEUE_MAX: z.coerce.number().int().min(1).default(50_000),
  TRACK_RETRY_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),

  // Control-plane auth. Empty in development only; production refuses to boot without it.
  ADMIN_TOKEN: z.string().default(''),

  LLM_PROVIDER: z.enum(['none', 'anthropic', 'openai', 'ollama']).default('none'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default(''),
  LLM_BASE_URL: z.string().default(''),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(100).default(20_000),
  LLM_MAX_CANDIDATES: z.coerce.number().int().min(1).max(20).default(3),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_BASE_URL: z.string().default(''),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Load a local .env file if one exists, then validate the environment.
 *
 * Uses Node's built-in loader, so there is no dotenv dependency. In production there
 * is no .env file and the platform injects real environment variables, so the missing
 * file is not an error.
 */
export function bootstrapEnv(explicitPath?: string): Env {
  if (explicitPath) {
    process.loadEnvFile(explicitPath);
  } else {
    try {
      process.loadEnvFile();
    } catch {
      // No .env present. Expected in production, where the platform supplies the env.
    }
  }
  return loadEnv();
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production' && !env.ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN is required in production');
  }
  if (env.LLM_PROVIDER !== 'none' && !env.LLM_API_KEY && env.LLM_PROVIDER !== 'ollama') {
    throw new Error(`LLM_API_KEY is required when LLM_PROVIDER=${env.LLM_PROVIDER}`);
  }

  cached = env;
  return env;
}

/** Test seam: allows injecting a pre-built env without touching process.env. */
export function setEnv(env: Env): void {
  cached = env;
}

export function getEnv(): Env {
  if (!cached) return loadEnv();
  return cached;
}
