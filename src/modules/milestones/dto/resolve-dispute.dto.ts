import { IsBoolean, IsNotEmpty } from 'class-validator';

export class ResolveDisputeDto {
  @IsBoolean()
  @IsNotEmpty()
  approved: boolean;
}
