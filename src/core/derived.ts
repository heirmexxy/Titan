/** Derived metrics computed by Titan from raw readings. */

/** Dew point in °C (Magnus formula, valid roughly -45..60 °C). */
export function dewPoint(tempC: number, rh: number): number {
  const a = 17.62;
  const b = 243.12;
  const g = Math.log(Math.max(rh, 0.1) / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}

/** Saturation vapour pressure, kPa (Tetens). */
export function saturationVapourPressure(tempC: number): number {
  return 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
}

/** Air vapour pressure deficit, kPa. */
export function vpd(tempC: number, rh: number): number {
  return saturationVapourPressure(tempC) * (1 - Math.min(Math.max(rh, 0), 100) / 100);
}

export interface HendersonParams {
  k: number;
  n: number;
  c: number;
}

/**
 * Equilibrium moisture content (% wet basis) from the modified Henderson equation:
 * 1 - RH = exp(-K (T + C) M^N), M in % dry basis.
 * Returns null outside the equation's useful range.
 */
export function emcWetBasis(tempC: number, rh: number, p: HendersonParams): number | null {
  const r = rh / 100;
  if (!(r > 0.05 && r < 0.98)) return null;
  const denom = p.k * (tempC + p.c);
  if (denom <= 0) return null;
  const mdb = Math.pow(-Math.log(1 - r) / denom, 1 / p.n);
  if (!Number.isFinite(mdb)) return null;
  return (100 * mdb) / (100 + mdb);
}

export const round = (x: number, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;
