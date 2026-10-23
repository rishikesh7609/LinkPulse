export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ShortCodeConflictError extends Error {
  constructor() {
    super('The short code is already in use.');
    this.name = 'ShortCodeConflictError';
  }
}
