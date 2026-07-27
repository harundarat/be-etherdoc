export const PINATA_RETRIEVAL_MAX_BYTES = 5 * 1024 * 1024;
export const PINATA_JSON_RESPONSE_MAX_BYTES = 1024 * 1024;

export class ResponseBodyTooLargeError extends Error {
  constructor(
    readonly maximumBytes: number,
    readonly observedBytes: number,
  ) {
    super(`Response body exceeds the ${maximumBytes} byte limit`);
    this.name = 'ResponseBodyTooLargeError';
  }
}

export class InvalidJsonResponseError extends Error {
  constructor(options?: ErrorOptions) {
    super('Response body is not valid UTF-8 JSON', options);
    this.name = 'InvalidJsonResponseError';
  }
}

export async function cancelResponseBody(
  response: Response,
  reason?: unknown,
): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch {
    // Cancellation is best-effort and must not replace the primary error.
  }
}

export async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
      await cancelResponseBody(response);
      throw new ResponseBodyTooLargeError(maximumBytes, declaredBytes);
    }
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let observedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      observedBytes += value.byteLength;
      if (observedBytes > maximumBytes) {
        throw new ResponseBodyTooLargeError(maximumBytes, observedBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Cancellation is best-effort and must not replace the primary error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(observedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes = PINATA_JSON_RESPONSE_MAX_BYTES,
): Promise<unknown> {
  const body = await readBoundedResponseBody(response, maximumBytes);
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new InvalidJsonResponseError({ cause: error });
  }
}
