import { TEST_DB_URL_KEY, migrateTestDb, startTestDb, stopTestDb } from "../helpers/db"

/*
 * Vitest global setup: boot ONE embedded Postgres for the whole integration run (in the
 * main process, so worker processes only open connections) and apply the committed
 * `drizzle/` migrations once. The URL travels through provide/inject; `getTestPool()`
 * picks it up. Teardown stops the instance, which also deletes its temp data dir.
 */

export default async function setup({
  provide,
}: {
  provide: (key: typeof TEST_DB_URL_KEY, value: string) => void
}): Promise<() => Promise<void>> {
  const url = await startTestDb()
  await migrateTestDb()
  provide(TEST_DB_URL_KEY, url)

  return async () => {
    await stopTestDb()
  }
}
