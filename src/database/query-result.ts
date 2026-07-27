export function requireQueryRow<T>(rows: readonly T[], operation: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Database returned no row for ${operation}`);
  }
  return row;
}
