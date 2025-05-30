export class UploadFileDataDto {
  id: string;
  name: string;
  cid: string;
  created_at: string;
  size: number;
  number_of_files: number;
  mime_type: string;
  user_id: string;
  group_id: string;
  is_duplicate: boolean;
}

export class UploadFileResponseDto {
  data: UploadFileDataDto;
}
