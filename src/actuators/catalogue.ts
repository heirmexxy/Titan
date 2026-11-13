/** Command catalogue, argument validation and policy checks. Pure functions. */

export type Source = 'admin' | 'ops' | 'api' | 'automation';

export interface ArgSpec {
  type: 'string' | 'number' | 'boolean';
  min?: number;
  max?: number;
  values?: string[];
  optional?: boolean;
}

export interface CommandSpec {
  name: string;
  label: string;
  args: Record<string, ArgSpec>;
  /** Who may send it. Missing = admin and ops only. */
  allow?: Source[];
}

/** Built into every device (Device Protocol v1 §8.2). */
export const SYSTEM_COMMANDS: CommandSpec[] = [
  { name: 'alarm_ack', label: 'Silence alarm', args: { code: { type: 'string', optional: true } }, allow: ['admin', 'ops', 'api'] },
  { name: 'send_state', label: 'Request status', args: {}, allow: ['admin', 'ops', 'api', 'automation'] },
  { name: 'time_sync', label: 'Sync clock', args: { time: { type: 'number', optional: true } }, allow: ['admin', 'ops'] },
  { name: 'reboot', label: 'Reboot', args: {}, allow: ['admin', 'ops'] },
];

export class CommandError extends Error {
  constructor(public code: 'unknown_command' | 'not_allowed' | 'invalid_args', message: string) {
    super(message);
  }
}

export function findCommand(typeCommands: CommandSpec[] | null | undefined, name: string): CommandSpec | null {
  return SYSTEM_COMMANDS.find((c) => c.name === name) ?? (typeCommands ?? []).find((c) => c.name === name) ?? null;
}

export function checkPolicy(spec: CommandSpec, source: Source) {
  const allow = spec.allow ?? ['admin', 'ops'];
  if (!allow.includes(source)) throw new CommandError('not_allowed', `${spec.name} cannot be sent by ${source}`);
}

/** Validates and normalises arguments against the spec. Unknown arguments are rejected. */
export function validateArgs(spec: CommandSpec, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args)) {
    if (!(k in spec.args)) throw new CommandError('invalid_args', `${spec.name} does not take argument ${k}`);
  }
  for (const [k, a] of Object.entries(spec.args)) {
    const v = args[k];
    if (v === undefined || v === null || v === '') {
      if (!a.optional) throw new CommandError('invalid_args', `${spec.name} needs ${k}`);
      continue;
    }
    if (a.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new CommandError('invalid_args', `${k} must be a number`);
      if (a.min !== undefined && n < a.min) throw new CommandError('invalid_args', `${k} must be at least ${a.min}`);
      if (a.max !== undefined && n > a.max) throw new CommandError('invalid_args', `${k} must be at most ${a.max}`);
      out[k] = n;
    } else if (a.type === 'boolean') {
      if (typeof v === 'boolean') out[k] = v;
      else if (v === 'true' || v === 'false') out[k] = v === 'true';
      else throw new CommandError('invalid_args', `${k} must be true or false`);
    } else {
      const sv = String(v).slice(0, 200);
      if (a.values && !a.values.includes(sv)) throw new CommandError('invalid_args', `${k} must be one of ${a.values.join(', ')}`);
      out[k] = sv;
    }
  }
  return out;
}
