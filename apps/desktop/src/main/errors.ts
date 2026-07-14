export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function publicError(error: unknown): Error {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return new AppError('INTERNAL_ERROR', error.message.slice(0, 500));
  return new AppError('INTERNAL_ERROR', 'Unexpected application error');
}

