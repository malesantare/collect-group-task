import { afterEach, expect, it, vi } from 'vitest';
import { BalancePoller } from '../src/balances/poller.js';

afterEach(() => vi.useRealTimers());

it('does not overlap slow refreshes and waits for the current refresh on stop', async () => {
  vi.useFakeTimers();
  let complete!: () => void;
  const refresh = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  const poller = new BalancePoller(refresh, 1000, vi.fn());
  poller.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(refresh).toHaveBeenCalledTimes(1);
  const stopped = vi.fn();
  const stopping = poller.stop().then(stopped);
  await Promise.resolve();
  expect(stopped).not.toHaveBeenCalled();
  complete();
  await stopping;
  await vi.advanceTimersByTimeAsync(5000);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('retries after failure and cancels the next scheduled cycle on stop', async () => {
  vi.useFakeTimers();
  const error = new Error('RPC unavailable');
  const refresh = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
  const onError = vi.fn();
  const poller = new BalancePoller(refresh, 1000, onError);
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledWith(error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh).toHaveBeenCalledTimes(2);
  await poller.stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(refresh).toHaveBeenCalledTimes(2);
});
