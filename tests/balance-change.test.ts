import { describe, expect, it } from 'vitest';
import { classifyChange } from '../src/balances/change.js';

describe('observed balance changes', () => {
  it('records a funded first observation as a baseline rather than a new deposit', () => {
    expect(classifyChange(null, 175122804546805318n)).toEqual({ kind: 'BASELINE', delta: null });
    expect(classifyChange(null, 0n)).toEqual({ kind: 'BASELINE', delta: null });
  });
  it('preserves one wei differences above floating-point precision', () => {
    expect(classifyChange(175122804546805318n, 175122804546805319n))
      .toEqual({ kind: 'INFLOW', delta: 1n });
  });
  it('does not infer a withdrawal broadcast from a decrease', () => {
    expect(classifyChange(100n, 0n)).toEqual({ kind: 'DECREASE', delta: -100n });
  });
  it('does not generate a change for equal balances', () => {
    expect(classifyChange(100n, 100n)).toBeNull();
  });
  it('rejects negative balances', () => {
    expect(() => classifyChange(0n, -1n)).toThrow();
  });
});
