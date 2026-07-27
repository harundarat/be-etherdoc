import { FileValidator } from '@nestjs/common';

export const PDF_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

export class PdfMagicBytesValidator extends FileValidator {
  constructor() {
    super({});
  }

  isValid(file?: unknown): boolean {
    if (
      !file ||
      typeof file !== 'object' ||
      !('buffer' in file) ||
      !Buffer.isBuffer(file.buffer)
    ) {
      return false;
    }
    const header = file.buffer.subarray(0, 1024).toString('latin1');
    return /(?:^|[\r\n])%PDF-\d\.\d/.test(header);
  }

  buildErrorMessage(): string {
    return 'Validation failed (file content is not a PDF)';
  }
}

export const PDF_UPLOAD_MULTER_OPTIONS = {
  limits: {
    fieldNameSize: 64,
    fieldSize: 16 * 1024,
    fields: 8,
    // Busboy reports LIMIT_FILE_SIZE once this threshold is reached, so use
    // one byte above the inclusive public limit.
    fileSize: PDF_UPLOAD_MAX_BYTES + 1,
    files: 1,
    parts: 9,
  },
} as const;
