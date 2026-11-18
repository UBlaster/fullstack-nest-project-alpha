import { Equals } from 'class-validator';

export class CreatePaymentDto {
	@Equals('WORKSPACE_DEMO')
	declare purpose: 'WORKSPACE_DEMO';
}
