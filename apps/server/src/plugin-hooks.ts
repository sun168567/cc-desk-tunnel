import { runInNewContext } from 'node:vm';
import { z } from 'zod';

// The structure of a Claude Code plugin's hooks/hooks.json, of which only command hooks are run.
const hookSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeout: z.number().positive().max(600).default(60),
});
export const hooksFileSchema = z.object({
  hooks: z.record(
    z.string(),
    z.array(z.object({ matcher: z.string().optional(), hooks: z.array(hookSchema) })),
  ),
});
export type Hook = z.infer<typeof hookSchema>;

// As Claude Code reads a matcher: names when it holds nothing but them, otherwise a regular expression.
export function matches(matcher: string | undefined, value: unknown) {
  if (!matcher || matcher === '*' || value === undefined) return true;
  if (/^[\w\- ,|]+$/.test(matcher))
    return matcher.split(/[|,]/).some((name) => name.trim() === value);
  // It runs in the service, which a pattern that goes on for long must not hold up.
  return !!runInNewContext('new RegExp(matcher).test(value)', { matcher, value }, { timeout: 100 });
}
