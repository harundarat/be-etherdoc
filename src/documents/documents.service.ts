import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadFileDto, UploadFileResponseDto } from './dto';
import { of as predictCIDFromBuffer } from 'ipfs-only-hash';
import { createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia, holesky } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { etherdocSenderAbi } from 'src/contracts/abis';
import { etherdocReceiverAbi } from 'src/contracts/abis/EtherdocReceiver.abi';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(private configService: ConfigService) {}

  async getDocumentByFile(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const pinataApiUrl =
      this.configService.getOrThrow<string>('PINATA_API_URL');
    const pinataJwtToken =
      this.configService.getOrThrow<string>('PINATA_JWT_TOKEN');
    const holeskyRpcUrl =
      this.configService.getOrThrow<string>('HOLESKY_RPC_URL');
    const baseSepoliaRpcUrl = this.configService.getOrThrow<string>(
      'BASE_SEPOLIA_RPC_URL',
    );
    const sourceContractAddress = '0x50D1672685E594B27F298Ac5bFACa4F3488AAA9c';
    const destinationContractAddress =
      '0xf9532930b61c0ddfed3b758582cb21c1cd8c2fd1';

    try {
      const documentCID = await predictCIDFromBuffer(file.buffer, {
        cidVersion: 1,
        rawLeaves: true,
      });

      console.info(`documentCID: ${documentCID}`);

      // Check CID on the blockchain
      const publicClientHolesky = createPublicClient({
        chain: holesky,
        transport: http(holeskyRpcUrl),
      });

      const publicClientBaseSepolia = createPublicClient({
        chain: baseSepolia,
        transport: http(baseSepoliaRpcUrl),
      });

      const isCIDExistHolesky = await publicClientHolesky.readContract({
        address: sourceContractAddress,
        abi: etherdocSenderAbi,
        functionName: 'documentExists',
        args: [documentCID],
      });

      const isCIDExistBaseSepolia = await publicClientBaseSepolia.readContract({
        address: destinationContractAddress,
        abi: etherdocReceiverAbi,
        functionName: 'documentExists',
        args: [documentCID],
      });

      // Only check CID existence on the main network
      if (!isCIDExistHolesky) {
        throw new NotFoundException(
          `Document with CID: ${documentCID} is not found.`,
        );
      }

      // Get the document from IPFS
      const response = await fetch(
        `${pinataApiUrl}/files/private?cid=${documentCID}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${pinataJwtToken}`,
          },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Pinata upload error: ${response.status} - ${errorText}`,
        );
        throw new HttpException(
          'Error uploading file to Pinata',
          response.status,
        );
      }

      const data = await response.json();
      const responseData = data.data.files[0];

      return {
        ...responseData,
        isExistEthereum: isCIDExistHolesky,
        isExistBase: isCIDExistBaseSepolia,
      };
    } catch (error) {
      this.logger.error('Failed to upload file', error.stack);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new InternalServerErrorException(
        'Could not upload file due to an unexpected error.',
      );
    }
    const isCIDExistBaseSepolia = await publicClientBaseSepolia.readContract({
      address: destinationContractAddress,
      abi: etherdocReceiverAbi,
      functionName: 'documentExists',
      args: [documentCID],
    });
  }

  async uploadDocument(
    file: Express.Multer.File,
    uploadFileDto: UploadFileDto,
  ): Promise<UploadFileResponseDto> {
    // Check if file exists
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const pinataUploadUrl =
      this.configService.getOrThrow<string>('PINATA_UPLOAD_URL');
    const pinataJwtToken =
      this.configService.getOrThrow<string>('PINATA_JWT_TOKEN');
    const evmPrivateKey =
      this.configService.getOrThrow<string>('EVM_PRIVATE_KEY');
    const account = privateKeyToAccount(`0x${evmPrivateKey}`);
    const rpcUrl = this.configService.getOrThrow<string>('RPC_URL');
    const walletClient = createWalletClient({
      account,
      chain: holesky,
      transport: http(rpcUrl),
    });
    const baseSepoliaChainSelector = 10344971235874465080n;
    const sourceContractAddress = '0x50D1672685E594B27F298Ac5bFACa4F3488AAA9c';
    const destinationContractAddress =
      '0xf9532930b61c0ddfed3b758582cb21c1cd8c2fd1';

    try {
      // Create form for Pinata upload
      const formData = new FormData();
      const blob = new Blob([file.buffer], { type: file.mimetype });
      formData.append('file', blob, file.originalname);
      formData.append('network', uploadFileDto.network);
      if (uploadFileDto.name) {
        formData.append('name', uploadFileDto.name);
      }
      if (uploadFileDto.group_id) {
        formData.append('group_id', uploadFileDto.group_id);
      }
      if (uploadFileDto.keyvalues) {
        formData.append('keyvalues', JSON.stringify(uploadFileDto.keyvalues));
      }

      // Start Pinata upload
      const pinataUploadPromise = fetch(pinataUploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pinataJwtToken}`,
        },
        body: formData,
      }).then(async (response) => {
        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(
            `Pinata upload error: ${response.status} - ${errorText}`,
          );
          throw new HttpException(
            'Error uploading file to Pinata',
            response.status,
          );
        }
        return response.json();
      });

      // Predict CID and start blockchain transaction
      const documentCIDPromise = predictCIDFromBuffer(file.buffer, {
        cidVersion: 1,
        rawLeaves: true,
      });

      const writeContractPromise = documentCIDPromise.then((documentCID) => {
        return walletClient.writeContract({
          address: sourceContractAddress,
          abi: etherdocSenderAbi,
          functionName: 'addDocument',
          args: [
            baseSepoliaChainSelector,
            destinationContractAddress,
            documentCID,
          ],
        });
      });

      // Wait for both operation to complete
      const [pinataResponseData, txHash] = await Promise.all([
        pinataUploadPromise,
        writeContractPromise,
      ]);

      return pinataResponseData;
    } catch (error) {
      this.logger.error('Failed to upload file', error.stack);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new InternalServerErrorException(
        'Could not upload file due to an unexpected error.',
      );
    }
  }

  async createGroup(network: string, groupName: string) {
    const pinataApiUrl =
      this.configService.getOrThrow<string>('PINATA_API_URL');
    const pinataJwtToken =
      this.configService.getOrThrow<string>('PINATA_JWT_TOKEN');

    try {
      const options = {
        method: 'POST',
        headers: { Authorization: `Bearer ${pinataJwtToken}` },
        'Content-Type': 'application/json',
        body: `{"name":"${groupName}"}`,
      };

      const rawResponse = await fetch(
        `${pinataApiUrl}/groups/${network}`,
        options,
      );

      if (!rawResponse.ok) {
        this.logger.error(`Pinata API error: ${rawResponse.status}`);
        throw new HttpException(
          'Error create a new group to pinata',
          rawResponse.status,
        );
      }

      const response = rawResponse.json();

      return response;
    } catch (error) {
      this.logger.error(
        `Failed to get list of files for network ${network}: `,
        error.stack,
      );

      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException(
        'Could not create a new group due to an unexpected error.',
      );
    }
  }

  async getDocumentByCid(network: string, documentCID: string) {
    const pinataApiUrl =
      this.configService.getOrThrow<string>('PINATA_API_URL');
    const pinataJwtToken =
      this.configService.getOrThrow<string>('PINATA_JWT_TOKEN');
    const holeskyRpcUrl =
      this.configService.getOrThrow<string>('HOLESKY_RPC_URL');
    const baseSepoliaRpcUrl = this.configService.getOrThrow<string>(
      'BASE_SEPOLIA_RPC_URL',
    );
    const sourceContractAddress = '0x50D1672685E594B27F298Ac5bFACa4F3488AAA9c';
    const destinationContractAddress =
      '0xf9532930b61c0ddfed3b758582cb21c1cd8c2fd1';

    try {
      const publicClientHolesky = createPublicClient({
        chain: holesky,
        transport: http(holeskyRpcUrl),
      });

      const publicClientBaseSepolia = createPublicClient({
        chain: baseSepolia,
        transport: http(baseSepoliaRpcUrl),
      });

      const isCIDExistHolesky = await publicClientHolesky.readContract({
        address: sourceContractAddress,
        abi: etherdocSenderAbi,
        functionName: 'documentExists',
        args: [documentCID],
      });

      const isCIDExistBaseSepolia = await publicClientBaseSepolia.readContract({
        address: destinationContractAddress,
        abi: etherdocReceiverAbi,
        functionName: 'documentExists',
        args: [documentCID],
      });

      // Only check CID existence on the main network
      if (!isCIDExistHolesky) {
        throw new NotFoundException(
          `Document with CID: ${documentCID} is not found.`,
        );
      }

      // Get the document from IPFS
      const response = await fetch(
        `${pinataApiUrl}/files/private?cid=${documentCID}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${pinataJwtToken}`,
          },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Pinata upload error: ${response.status} - ${errorText}`,
        );
        throw new HttpException(
          'Error uploading file to Pinata',
          response.status,
        );
      }

      const data = await response.json();
      const responseData = data.data.files[0];

      return {
        ...responseData,
        isExistEthereum: isCIDExistHolesky,
        isExistBase: isCIDExistBaseSepolia,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get document for network ${network}: `,
        error.stack,
      );
      if (error instanceof HttpException) {
        throw error;
      }
      throw new InternalServerErrorException(
        'Could not retrieve document due to an unexpected error.',
      );
    }
  }

  async getListFiles(network: string, groupId?: string) {
    const pinataApiUrl =
      this.configService.getOrThrow<string>('PINATA_API_URL');
    const pinataJwtToken =
      this.configService.getOrThrow<string>('PINATA_JWT_TOKEN');

    try {
      const options = {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${pinataJwtToken}`,
        },
      };

      const baseUrl = `${pinataApiUrl}/files/${network}`;
      const url = new URL(baseUrl);

      if (groupId) {
        url.searchParams.append('group', groupId);
      }

      const rawResponse = await fetch(url.toString(), options);

      if (!rawResponse.ok) {
        this.logger.error(`Pinata API error: ${rawResponse.status}`);
        throw new HttpException(
          'Error fetching files from pinata',
          rawResponse.status,
        );
      }

      const response = rawResponse.json();
      return response;
    } catch (error) {
      this.logger.error(
        `Failed to get list of files for network ${network}: `,
        error.stack,
      );

      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException(
        'Could not retrieve file list due to an unexpected error.',
      );
    }
  }

  async getListGroups(network: string) {
    const pinataApiUrl =
      this.configService.getOrThrow<string>('PINATA_API_URL');
    const pinataJwtToken =
      this.configService.getOrThrow<string>('PINATA_JWT_TOKEN');

    try {
      const options = {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${pinataJwtToken}`,
        },
      };

      const rawResponse = await fetch(
        `${pinataApiUrl}/groups/${network}`,
        options,
      );

      if (!rawResponse.ok) {
        this.logger.error(`Pinata API error: ${rawResponse.status}`);
        throw new HttpException(
          'Error fetching groups from pinata',
          rawResponse.status,
        );
      }

      const response = rawResponse.json();

      return response;
    } catch (error) {
      this.logger.error(
        `Failed to get list of groups for network ${network}: `,
        error.stack,
      );

      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException(
        'Could not retrieve group list due to an unexpected error.',
      );
    }
  }
}
