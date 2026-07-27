export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PinataMetadataResponse {
  [key: string]: JsonValue;
}

export interface PinataUploadResponse {
  data?: {
    cid?: string;
    id?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown, path: string): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        jsonValue(entry, `${path}.${key}`),
      ]),
    );
  }
  throw new Error(`${path} contains a non-JSON value`);
}

export function parsePinataMetadataResponse(
  value: unknown,
): PinataMetadataResponse {
  const parsed = jsonValue(value, 'Pinata metadata response');
  if (Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') {
    throw new Error('Pinata metadata response must be an object');
  }
  return parsed;
}

export function parsePinataUploadResponse(
  value: unknown,
): PinataUploadResponse {
  if (!isRecord(value)) {
    throw new Error('Pinata upload response must be an object');
  }
  const dataValue = value.data;
  if (dataValue === undefined) {
    return {};
  }
  if (!isRecord(dataValue)) {
    throw new Error('Pinata upload response data must be an object');
  }
  const data = dataValue;
  if (data.cid !== undefined && typeof data.cid !== 'string') {
    throw new Error('Pinata upload response CID must be a string');
  }
  if (data.id !== undefined && typeof data.id !== 'string') {
    throw new Error('Pinata upload response ID must be a string');
  }
  return {
    data: {
      ...(typeof data.cid === 'string' ? { cid: data.cid } : {}),
      ...(typeof data.id === 'string' ? { id: data.id } : {}),
    },
  };
}
