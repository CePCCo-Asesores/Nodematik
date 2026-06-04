import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface TokenPayload {
  sub: string;   // OrgUser.id
  orgId: string;
  role: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, config.JWT_SECRET);
  if (typeof decoded !== 'object' || decoded === null) throw new Error('Invalid token');
  return decoded as TokenPayload;
}
