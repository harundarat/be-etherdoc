class MessageObjectDto {
  address: string;
  message: string;
  nonce: string;
}

export class NonceResponseDto {
  messageObject: MessageObjectDto;
  messageString: string;
}
