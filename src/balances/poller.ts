export class BalancePoller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly refresh: () => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.tick();
  }

  private tick(): void {
    this.running = Promise.resolve().then(this.refresh).then(() => {}, this.onError).finally(() => {
      if (!this.stopped) this.timer = setTimeout(() => this.tick(), this.intervalMs);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
