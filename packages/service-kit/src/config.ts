import { z } from 'zod'

/** Empty env vars ("FOO=") count as unset. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional())

export const LogLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

/** Settings every service needs; each service extends it in its own config.ts. */
export const BaseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: LogLevelSchema.default('info'),
  JWKS_URL: z.url(),
  JWT_ISSUER: z.string().min(1).default('craftoria-identity'),
  JWT_AUDIENCE: z.string().min(1).default('craftoria'),
  INTERNAL_API_TOKEN: z.string().min(32),
  OTEL_EXPORTER_OTLP_ENDPOINT: optional(z.url()),
  SENTRY_DSN: optional(z.url()),
})
export type BaseConfig = z.infer<typeof BaseConfigSchema>

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
  constructor(readonly problems: { key: string; message: string }[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p.key}: ${p.message}`).join('\n')}`)
  }
}

/**
 * Validates env vars at boot and fails fast with every problem at once.
 * Messages name the key and the rule, never the value (values may be secrets).
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.output<S> {
  const result = schema.safeParse(env)
  if (result.success) return result.data
  const problems = result.error.issues.map((issue) => ({
    key: issue.path.join('.') || '(root)',
    message: issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : issue.message,
  }))
  throw new ConfigError(problems)
}
