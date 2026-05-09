import { createHash, randomBytes } from 'node:crypto';

export function sha256(input: string) {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

