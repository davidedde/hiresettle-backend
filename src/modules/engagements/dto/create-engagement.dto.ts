import {
  IsString, IsNotEmpty, IsArray, ValidateNested,
  IsInt, Min, Max, IsOptional, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class MilestoneInputDto {
  @ApiProperty({ example: 'Candidate Placed' })
  @IsString() @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 30 })
  @IsInt() @Min(1) @Max(100)
  paymentPercent: number;

  @ApiProperty({ example: 'PLACEMENT', enum: ['PLACEMENT', 'RETENTION'] })
  @IsIn(['PLACEMENT', 'RETENTION'])
  kind: 'PLACEMENT' | 'RETENTION';
}

export class CreateEngagementDto {
  @ApiProperty({ example: 'ENG-2026-001' })
  @IsString() @IsNotEmpty()
  engagementId: string;

  @ApiProperty({ example: 'GABC...company' })
  @IsString() @IsNotEmpty()
  companyAddress: string;

  @ApiProperty({ example: 'GABC...recruiter' })
  @IsString() @IsNotEmpty()
  recruiterAddress: string;

  @ApiProperty({ example: 'GABC...arbiter' })
  @IsString() @IsNotEmpty()
  arbiterAddress: string;

  @ApiProperty({ example: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA' })
  @IsString() @IsNotEmpty()
  tokenAddress: string;

  @ApiProperty({ example: '5000000000', description: 'Total recruiter fee in stroops' })
  @IsString() @IsNotEmpty()
  totalAmount: string;

  @ApiProperty({ example: 'Senior Software Engineer' })
  @IsString() @IsNotEmpty()
  jobTitle: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  jobDescription?: string;

  @ApiProperty({ required: false, example: '$120k - $160k' })
  @IsOptional() @IsString()
  salaryRange?: string;

  @ApiProperty({ required: false, example: 'Remote' })
  @IsOptional() @IsString()
  location?: string;

  @ApiProperty({ type: [MilestoneInputDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MilestoneInputDto)
  milestones: MilestoneInputDto[];

  @ApiProperty({
    required: false,
    type: [Number],
    example: [30, 90],
    description: 'One retention window (days) per RETENTION milestone, in order',
  })
  @IsOptional()
  @IsArray()
  retentionDays?: number[];

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  txHash?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsInt()
  createdLedger?: number;
}
