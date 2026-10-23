import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { ApiError } from '../links/errors.js';
import { EmailAlreadyRegisteredError, type UserRepository } from './repository.js';
import type { AuthenticatedUser } from './types.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const dummyHash = argon2.hash(randomBytes(32));
const REGISTRATION_ERROR = {
  code: 'REGISTRATION_FAILED',
  message: 'Could not create an account with those details.',
};

export class AuthenticationService {
  constructor(private readonly users: UserRepository) {}

  async register(emailValue: unknown, passwordValue: unknown): Promise<AuthenticatedUser> {
    const email = this.validateEmail(emailValue);
    const password = this.validatePassword(passwordValue);
    try {
      const user = await this.users.create(
        email,
        await argon2.hash(password, { type: argon2.argon2id }),
      );
      return { id: user.id, email: user.email };
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        throw new ApiError(400, REGISTRATION_ERROR.code, REGISTRATION_ERROR.message);
      }
      throw error;
    }
  }

  async login(emailValue: unknown, passwordValue: unknown): Promise<AuthenticatedUser> {
    if (typeof emailValue !== 'string' || typeof passwordValue !== 'string') {
      throw new ApiError(401, 'AUTHENTICATION_FAILED', 'Email or password is incorrect.');
    }
    const email = emailValue.trim().toLowerCase();
    const user = EMAIL_PATTERN.test(email) ? await this.users.findByEmail(email) : undefined;
    const hash = user?.passwordHash ?? (await dummyHash);
    const matches = await argon2.verify(hash, passwordValue).catch(() => false);
    if (!user || !matches) {
      throw new ApiError(401, 'AUTHENTICATION_FAILED', 'Email or password is incorrect.');
    }
    return { id: user.id, email: user.email };
  }

  async findUser(id: string): Promise<AuthenticatedUser | undefined> {
    const user = await this.users.findById(id);
    return user ? { id: user.id, email: user.email } : undefined;
  }

  private validateEmail(value: unknown): string {
    if (typeof value !== 'string' || value.length > 254 || !EMAIL_PATTERN.test(value.trim())) {
      throw new ApiError(400, REGISTRATION_ERROR.code, REGISTRATION_ERROR.message);
    }
    return value.trim().toLowerCase();
  }

  private validatePassword(value: unknown): string {
    if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
      throw new ApiError(400, REGISTRATION_ERROR.code, REGISTRATION_ERROR.message);
    }
    return value;
  }
}
