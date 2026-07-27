export function redactSensitiveText(
  value: string | null | undefined,
  maximumLength = 2_048,
): string | null {
  if (!value) {
    return null;
  }
  return value
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/\S+/gi, '[redacted-url]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)=\S+/gi, '$1=[redacted]')
    .slice(0, maximumLength);
}
