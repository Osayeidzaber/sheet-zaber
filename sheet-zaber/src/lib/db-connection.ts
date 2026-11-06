/*
 * The one definition of how this app connects to Postgres, shared by the server and the deploy
 * scripts. TLS is always verified for a remote host. `sslmode` and friends are removed from the URL
 * because `pg` lets them override the `ssl` option: `sslmode=require` would silently turn
 * certificate verification off.
 */

const SSL_URL_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]

export type PgConnectionConfig = {
  connectionString: string
  ssl?: { rejectUnauthorized: true; ca?: string }
}

export function isLocalDatabaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
  } catch {
    return false
  }
}

/** `caCert` is PEM; a literal `\n` is accepted because many env editors take one line only. */
export function pgConnectionConfig(databaseUrl: string, caCert?: string): PgConnectionConfig {
  if (isLocalDatabaseUrl(databaseUrl)) return { connectionString: databaseUrl }

  const url = new URL(databaseUrl)
  for (const param of SSL_URL_PARAMS) url.searchParams.delete(param)
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(caCert ? { ca: caCert.replace(/\\n/g, "\n") } : {}) },
  }
}
