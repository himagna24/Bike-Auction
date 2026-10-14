import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { BidError } from './bids.js';

export interface AuthUser { id: string; role: 'BUYER' | 'ADMIN' }
declare global { namespace Express { interface Request { user?: AuthUser } } }

export const hashPassword = (p: string) => argon2.hash(p, { type: argon2.argon2id });
export const verifyPassword = (hash: string, p: string) => argon2.verify(hash, p);
export const signToken = (u: AuthUser) =>
  jwt.sign({ role: u.role }, config.jwtSecret, { subject: u.id, expiresIn: config.jwtTtl as any });

export function verifyToken(token: string): AuthUser {
  const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  return { id: p.sub as string, role: p.role };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.header('authorization');
  if (!h?.startsWith('Bearer ')) return next(new BidError('UNAUTHENTICATED', 'Login required', 401));
  try { req.user = verifyToken(h.slice(7)); next(); }
  catch { next(new BidError('UNAUTHENTICATED', 'Invalid or expired token', 401)); }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') return next(new BidError('FORBIDDEN', 'Admin only', 403));
  next();
}
