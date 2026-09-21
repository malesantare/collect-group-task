import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { formatEther } from 'ethers';
import type { BalanceStore } from './balances/types.js';
import type { WithdrawalService } from './withdrawals/service.js';
import { WithdrawalError } from './withdrawals/errors.js';
import { WrongNetworkError } from './blockchain/balances.js';

export function createApp(
  store: Pick<BalanceStore, 'listWallets' | 'history'>,
  walletCount: number,
  withdrawals?: { service: Pick<WithdrawalService, 'withdraw'>; apiKey: string },
) {
  const app = express();
  app.disable('x-powered-by');

  if (withdrawals) {
    const authorize: RequestHandler = (request, response, next) => {
      const actual = Buffer.from(request.get('Authorization') ?? '');
      const expected = Buffer.from(`Bearer ${withdrawals.apiKey}`);
      response.set('Cache-Control', 'no-store');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        response.status(401).json({ error: 'UNAUTHORIZED', message: 'A valid bearer API key is required.' });
        return;
      }
      next();
    };
    app.post('/withdrawals', authorize, express.json({ limit: '8kb' }), async (request, response) => {
      const result = await withdrawals.service.withdraw(request.body, request.get('Idempotency-Key'));
      response.status(result.status === 'UNCERTAIN' ? 202 : result.status === 'BROADCAST' ? 201 : 200).json(result);
    });
  }

  app.get('/wallets', async (_request, response) => {
    const wallets = await store.listWallets(walletCount);
    response.set('Cache-Control', 'no-store');
    response.json(wallets.map((wallet) => ({
      ...wallet,
      balance: wallet.balanceWei === null ? null : formatEther(wallet.balanceWei),
      stale: wallet.checkedAt === null || Date.now() - wallet.checkedAt.getTime() > 600000,
    })));
  });

  app.get('/wallets/:index/history', async (request, response) => {
    const indexText = request.params.index;
    const limitText = request.query.limit ?? '50';
    const before = request.query.before;
    if (!/^\d+$/.test(indexText) || !Number.isSafeInteger(Number(indexText))) {
      response.status(400).json({ error: 'Invalid wallet index' });
      return;
    }
    const index = Number(indexText);
    if (index >= walletCount) {
      response.status(404).json({ error: 'Wallet not found' });
      return;
    }
    if (typeof limitText !== 'string' || !/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 100
      || (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,18}$/.test(before)
        || BigInt(before) > 9223372036854775807n))) {
      response.status(400).json({ error: 'Invalid history pagination' });
      return;
    }
    const limit = Number(limitText);
    const rows = await store.history(index, limit + 1, before);
    const items = rows.slice(0, limit);
    response.set('Cache-Control', 'no-store');
    response.json({ items, nextCursor: rows.length > limit ? items.at(-1)?.id : null });
  });

  // Liveness only; this does not assert database or RPC connectivity.
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof WithdrawalError) {
      response.status(error.httpStatus).json({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof WrongNetworkError) {
      response.status(422).json({ error: 'WRONG_NETWORK', message: 'RPC must connect to Sepolia (11155111).' });
      return;
    }
    const type = (error as { type?: string } | null)?.type;
    if (type === 'entity.parse.failed' || type === 'entity.too.large') {
      response.status(type === 'entity.too.large' ? 413 : 400).json({ error: 'INVALID_JSON_BODY' });
      return;
    }
    console.error('API operation failed.');
    response.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: 'Operation unavailable. For broadcast requests, retry with the same body and Idempotency-Key.' });
  };
  app.use(errorHandler);

  return app;
}
