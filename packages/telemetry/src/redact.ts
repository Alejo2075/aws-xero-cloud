const SENSITIVE_KEY = /(secret|token|password|passwd|authorization|credential|api[-_]?key|access[-_]?key|private|cookie|payload|body|event)/i;
const PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\b/g, // AWS access key ids
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(aws_secret_access_key|aws_session_token|secret_access_key|session_token)\s*[=:]\s*\S+/gi,
];
export const REDACTED = '[REDACTED]';

/** Redacts known secret values plus well-known credential patterns from free text. */
export class Redactor {
  private readonly secrets = new Set<string>();

  /** Register a literal secret (e.g. an injected session token). Very short values are ignored. */
  addSecret(value: string | undefined): void {
    if (value && value.length >= 8) this.secrets.add(value);
  }
  clearSecrets(): void {
    this.secrets.clear();
  }

  redactString(input: string): string {
    let out = input;
    for (const s of this.secrets) out = out.split(s).join(REDACTED);
    for (const p of PATTERNS) out = out.replace(p, REDACTED);
    return out;
  }
}

/** Deep-redacts object fields by key name and string content. Depth and size limited. */
export function redactFields(value: unknown, redactor: Redactor, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]';
  if (typeof value === 'string') return redactor.redactString(value.length > 2000 ? `${value.slice(0, 2000)}…` : value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactFields(v, redactor, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactor.redactString(value.message) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactFields(v, redactor, depth + 1);
    }
    return out;
  }
  return value;
}
