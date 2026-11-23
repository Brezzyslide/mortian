/** Minimal slice of node-postgres, so this package does not depend on a driver. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}
export interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

export async function inTransaction<T>(pool: PoolLike, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
