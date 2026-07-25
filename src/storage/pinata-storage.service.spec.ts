import { ConfigService } from '@nestjs/config';
import { UnprocessableEntityException } from '@nestjs/common';
import type { RuntimeConfig } from '../config/runtime-config';
import {
  CID_CODEC_RAW,
  canonicalizeMetadata,
  encodeCanonicalCid,
  sha256Digest,
} from '../documents/canonical-document';
import { PinataStorageService } from './pinata-storage.service';

function service(): PinataStorageService {
  const runtime = {
    blockchain: { requestTimeoutMs: 1_000 },
    pinata: {
      gatewayUrl: 'https://gateway.example',
      jwt: 'token',
      uploadUrl: 'https://upload.example',
    },
  } as RuntimeConfig;
  return new PinataStorageService(new ConfigService({ runtime }));
}

function file(bytes = Buffer.from('exact bytes')): Express.Multer.File {
  return {
    buffer: bytes,
    destination: '',
    encoding: '7bit',
    fieldname: 'file',
    filename: '',
    mimetype: 'application/pdf',
    originalname: 'document.pdf',
    path: '',
    size: bytes.length,
    stream: null as never,
  };
}

function metadata(byteLength: number) {
  return canonicalizeMetadata({
    byteLength,
    mimeType: 'application/pdf',
    storageNetwork: 'private',
  });
}

describe('PinataStorageService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the actual Pinata CID and verifies retrieved exact bytes', async () => {
    const upload = file();
    const digest = sha256Digest(upload.buffer);
    const cid = encodeCanonicalCid(CID_CODEC_RAW, digest);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { cid, id: 'pin-1' } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(upload.buffer, { status: 200 }));

    await expect(
      service().pinAndVerify(upload, 'private', metadata(upload.buffer.length)),
    ).resolves.toMatchObject({
      cid,
      cidCodec: CID_CODEC_RAW,
      cidDigest: digest,
      contentDigest: digest,
      providerId: 'pin-1',
      retrievedBytes: upload.buffer.length,
      storageFilename: 'document.pdf',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://gateway.example/ipfs/${cid}`,
      expect.any(Object),
    );
  });

  it('rejects a fetch-back digest mismatch before creating an intent', async () => {
    const upload = file();
    const cid = encodeCanonicalCid(CID_CODEC_RAW, sha256Digest(upload.buffer));
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { cid } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('tampered bytes'), { status: 200 }),
      );

    await expect(
      service().pinAndVerify(upload, 'private', metadata(upload.buffer.length)),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects a non-canonical CID returned by storage', async () => {
    const upload = file();
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { cid: 'not-a-cid' } }), {
        status: 200,
      }),
    );

    await expect(
      service().pinAndVerify(upload, 'private', metadata(upload.buffer.length)),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('reports availability without treating it as authenticity', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(
      service().checkAvailability('available-cid'),
    ).resolves.toMatchObject({
      available: true,
      status: 'AVAILABLE',
    });
    await expect(
      service().checkAvailability('missing-cid'),
    ).resolves.toMatchObject({
      available: false,
      status: 'NOT_FOUND',
    });
  });
});
