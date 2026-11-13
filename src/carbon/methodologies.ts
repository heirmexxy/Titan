/**
 * Carbon calculations. Pure functions, versioned by methodology ID.
 *
 * These are Titan's estimators, built so every number traces back to signed readings or recorded lab results.
 * Before credits are issued, the parameters must be aligned with the registry methodology the project is
 * registered under (e.g. Puro.earth Biochar, Verra VM0044, Gold Standard metered cooking) and reviewed by the
 * project's validation/verification body.
 */

export interface Point { time: Date; value: number }

export const MEASUREMENT_KINDS: Record<string, { unit: string; label: string; methodology: string }> = {
  'biochar.mass_kg': { unit: 'kg', label: 'Biochar produced (as weighed)', methodology: 'biochar-v1' },
  'biochar.moisture_pct': { unit: '%', label: 'Biochar moisture', methodology: 'biochar-v1' },
  'feedstock.mass_kg': { unit: 'kg', label: 'Feedstock used', methodology: 'biochar-v1' },
  'lab.organic_carbon_pct': { unit: '%', label: 'Organic carbon content (lab, dry basis)', methodology: 'biochar-v1' },
  'lab.h_corg': { unit: 'ratio', label: 'H/Corg molar ratio (lab)', methodology: 'biochar-v1' },
  'cookstove.households': { unit: 'count', label: 'Households in sample', methodology: 'cookstove-v1' },
};

// ---------- Biochar ----------

/**
 * Highest temperature the kiln held continuously for at least `minMinutes`.
 * Points must be sorted by time. Gaps longer than `maxGapMin` break continuity.
 */
export function heldTemperature(points: Point[], minMinutes = 10, maxGapMin = 5): number | null {
  let best: number | null = null;
  for (let i = 0; i < points.length; i++) {
    let min = Infinity;
    for (let j = i; j < points.length; j++) {
      if (j > i && points[j].time.getTime() - points[j - 1].time.getTime() > maxGapMin * 60_000) break;
      min = Math.min(min, points[j].value);
      if (points[j].time.getTime() - points[i].time.getTime() >= minMinutes * 60_000) {
        if (best === null || min > best) best = min;
        break;
      }
    }
  }
  return best;
}

/** Permanence factor (fraction of carbon remaining after 100 years) by production temperature, IPCC 2019 Refinement Tier 1 values. */
export function permanenceFactor(tempC: number | null): number | null {
  if (tempC === null) return null;
  if (tempC >= 600) return 0.89;
  if (tempC >= 450) return 0.8;
  if (tempC >= 350) return 0.65;
  return null;
}

export interface BiocharParams {
  /** Project emissions (feedstock transport, energy, etc.) per tonne of dry biochar, tCO2e. Default 0. */
  emissionsTco2ePerT?: number;
  /** Share withheld as a buffer, %. Default 0. */
  bufferPct?: number;
  /** Maximum H/Corg for eligibility. Default 0.7. */
  maxHCorg?: number;
  /** Minimum minutes the production temperature must be held. Default 10. */
  minHoldMinutes?: number;
}

export interface BiocharInputs {
  biocharMassKg: number | null;
  moisturePct: number | null;
  organicCarbonPct: number | null;
  hCorg: number | null;
  heldTempC: number | null;
}

export function calculateBiochar(i: BiocharInputs, p: BiocharParams = {}) {
  const missing: string[] = [];
  const problems: string[] = [];
  if (i.biocharMassKg === null) missing.push('biochar mass');
  if (i.moisturePct === null) missing.push('biochar moisture');
  if (i.organicCarbonPct === null) missing.push('lab organic carbon');
  if (i.hCorg === null) missing.push('lab H/Corg');
  if (i.heldTempC === null) missing.push('kiln temperature record');
  const maxH = p.maxHCorg ?? 0.7;
  if (i.hCorg !== null && i.hCorg > maxH) problems.push(`H/Corg ${i.hCorg} is above ${maxH}`);
  const fPerm = permanenceFactor(i.heldTempC);
  if (i.heldTempC !== null && fPerm === null) problems.push(`Held temperature ${Math.round(i.heldTempC)} °C is below 350 °C`);

  const status = problems.length ? 'ineligible' : missing.length ? 'incomplete' : 'ok';
  if (status !== 'ok') return { status, missing, problems, method: 'biochar-v1' } as const;

  const dryT = (i.biocharMassKg! * (1 - i.moisturePct! / 100)) / 1000;
  const carbonT = dryT * (i.organicCarbonPct! / 100);
  const grossTco2e = carbonT * fPerm! * (44 / 12);
  const emissionsTco2e = dryT * (p.emissionsTco2ePerT ?? 0);
  const net = Math.max(0, grossTco2e - emissionsTco2e);
  const bufferTco2e = net * ((p.bufferPct ?? 0) / 100);
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return {
    status, missing, problems, method: 'biochar-v1',
    dryBiocharT: r(dryT), carbonT: r(carbonT), permanenceFactor: fPerm!, heldTempC: Math.round(i.heldTempC!),
    grossTco2e: r(grossTco2e), emissionsTco2e: r(emissionsTco2e), bufferTco2e: r(bufferTco2e), netTco2e: r(net - bufferTco2e),
  } as const;
}

// ---------- Cookstoves ----------

export interface Session { start: Date; end: Date; minutes: number }

/**
 * Cooking sessions from stove-body temperature: a session starts when the temperature rises above `onC`
 * and ends when it falls below `offC` (or data stops for more than `maxGapMin`). Sessions shorter than
 * `minMinutes` are ignored.
 */
export function detectSessions(points: Point[], o: { onC?: number; offC?: number; minMinutes?: number; maxGapMin?: number } = {}): Session[] {
  const onC = o.onC ?? 60, offC = o.offC ?? 45, minMinutes = o.minMinutes ?? 10, maxGap = (o.maxGapMin ?? 30) * 60_000;
  const out: Session[] = [];
  let start: Date | null = null;
  let last: Date | null = null;
  const close = (end: Date) => {
    const minutes = (end.getTime() - start!.getTime()) / 60_000;
    if (minutes >= minMinutes) out.push({ start: start!, end, minutes: Math.round(minutes) });
    start = null;
  };
  for (const p of points) {
    if (start && last && p.time.getTime() - last.getTime() > maxGap) close(last);
    if (!start && p.value >= onC) start = p.time;
    else if (start && p.value < offC) close(p.time);
    last = p.time;
  }
  if (start && last) close(last);
  return out;
}

export interface CookstoveParams {
  /** Baseline fuel use per hour of cooking on the old stove, kg. */
  baselineFuelKgPerHour?: number;
  /** Share of baseline fuel the project stove saves, 0..1. */
  fuelSavingFraction?: number;
  /** Fraction of non-renewable biomass, 0..1. */
  fNRB?: number;
  /** Emission factor of the baseline fuel, tCO2e per tonne. */
  efTco2PerTFuel?: number;
  onC?: number;
  offC?: number;
  minMinutes?: number;
}

export function calculateCookstove(sessionsByDevice: Record<string, Session[]>, p: CookstoveParams) {
  const required = ['baselineFuelKgPerHour', 'fuelSavingFraction', 'fNRB', 'efTco2PerTFuel'] as const;
  const missing = required.filter((k) => typeof p[k] !== 'number');
  const devices = Object.keys(sessionsByDevice);
  const sessions = devices.reduce((n, d) => n + sessionsByDevice[d].length, 0);
  const hours = devices.reduce((h, d) => h + sessionsByDevice[d].reduce((m, s) => m + s.minutes, 0) / 60, 0);
  const activeDevices = devices.filter((d) => sessionsByDevice[d].length > 0).length;
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  if (missing.length) return { status: 'incomplete' as const, missing: missing.map(String), problems: [] as string[], method: 'cookstove-v1', devices: devices.length, activeDevices, sessions, cookingHours: r(hours) };
  const fuelSavedT = (hours * p.baselineFuelKgPerHour! * p.fuelSavingFraction!) / 1000;
  const tco2e = fuelSavedT * p.fNRB! * p.efTco2PerTFuel!;
  return {
    status: 'ok' as const, missing: [] as string[], problems: [] as string[], method: 'cookstove-v1',
    devices: devices.length, activeDevices, sessions, cookingHours: r(hours), fuelSavedT: r(fuelSavedT), netTco2e: r(tco2e),
  };
}
