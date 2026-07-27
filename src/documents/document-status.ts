export type DocumentLifecycleStatus = 'ACTIVE' | 'REVOKED' | 'SUPERSEDED';

const documentLifecycleStatuses: Readonly<
  Record<number, DocumentLifecycleStatus>
> = {
  1: 'ACTIVE',
  2: 'REVOKED',
  3: 'SUPERSEDED',
};

export function documentLifecycleStatus(
  value: number,
): DocumentLifecycleStatus | null {
  return documentLifecycleStatuses[value] ?? null;
}

export function requireDocumentLifecycleStatus(
  value: number,
): DocumentLifecycleStatus {
  const status = documentLifecycleStatus(value);
  if (!status) {
    throw new Error(`Contract returned invalid document status ${value}`);
  }
  return status;
}
