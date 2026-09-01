import { Request } from 'express';

export interface AuthenticatedUser {
	sub: string;
	email: string;
}

export interface AuthenticatedRequest extends Request {
	user: AuthenticatedUser;
}
