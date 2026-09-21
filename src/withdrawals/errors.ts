export class WithdrawalError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus: number) {
    super(message);
    this.name = 'WithdrawalError';
  }
}
