import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'GABC...XYZ' })
  @IsString() @IsNotEmpty()
  stellarAddress: string;

  @ApiProperty()
  @IsString() @IsNotEmpty()
  signedNonce: string;

  @ApiProperty()
  @IsString() @IsNotEmpty()
  signature: string;
}
