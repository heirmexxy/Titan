export interface AlertRule {
  id: string;
  orgId: string;
  siteId: string | null;
  deviceId: string | null;
  channel: string | null;
  metric: string;
  op: 'gt' | 'lt';
  threshold: number;
  durationS: number;
  hysteresis: number;
  severity: 'info' | 'warning' | 'critical';
  name: string | null;
}

export interface RuleState {
  breachSince: Date | null;
  alertId: string | null;
}

export type RuleAction = 'open' | 'resolve' | null;

/**
 * Pure threshold evaluation with minimum duration and hysteresis.
 * - Breach starts when the value crosses the threshold.
 * - An alert opens once the breach has lasted durationS.
 * - The breach clears only when the value comes back past threshold ± hysteresis.
 */
export function evaluateRule(rule: AlertRule, state: RuleState, value: number, at: Date): { state: RuleState; action: RuleAction } {
  const breaching = rule.op === 'gt' ? value > rule.threshold : value < rule.threshold;
  const cleared = rule.op === 'gt' ? value <= rule.threshold - rule.hysteresis : value >= rule.threshold + rule.hysteresis;

  if (breaching) {
    const since = state.breachSince ?? at;
    const lasted = (at.getTime() - since.getTime()) / 1000;
    if (!state.alertId && lasted >= rule.durationS) {
      return { state: { breachSince: since, alertId: state.alertId }, action: 'open' };
    }
    return { state: { breachSince: since, alertId: state.alertId }, action: null };
  }
  if (cleared) {
    return { state: { breachSince: null, alertId: null }, action: state.alertId ? 'resolve' : null };
  }
  return { state, action: null }; // inside the hysteresis band: hold
}

export function ruleMatches(rule: AlertRule, d: { orgId: string; siteId: string | null; deviceId: string }, metric: string, channel: string): boolean {
  if (rule.metric !== metric || rule.orgId !== d.orgId) return false;
  if (rule.siteId && rule.siteId !== d.siteId) return false;
  if (rule.deviceId && rule.deviceId !== d.deviceId) return false;
  if (rule.channel && rule.channel !== channel) return false;
  return true;
}

export function ruleTitle(rule: AlertRule, value: number, unit: string): string {
  const dir = rule.op === 'gt' ? 'above' : 'below';
  return rule.name ?? `${rule.metric} ${dir} ${rule.threshold}${unit ? ' ' + unit : ''} (now ${Math.round(value * 100) / 100})`;
}
