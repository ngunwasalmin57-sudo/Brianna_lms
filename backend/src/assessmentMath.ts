// PLACEHOLDER RULES. BML sets the real formulas (screen X4).
// Keep this file identical to frontend/src/assessmentMath.ts.

// 85% of (monthly cash flow - existing obligations), rounded to the nearest TZS 10,000.
export function repaymentCapacity(cashFlow: number, obligations: number): number {
  const net = cashFlow - obligations;
  if (net <= 0) return 0;
  return Math.round((net * 85) / 100 / 10000) * 10000;
}

// The lower of 65% of monthly sales and 3 x repayment capacity, rounded down to TZS 100,000.
export function recommendedAmount(sales: number, capacity: number): number {
  const cap = Math.min(Math.floor((sales * 65) / 100), capacity * 3);
  return Math.max(0, Math.floor(cap / 100000) * 100000);
}
