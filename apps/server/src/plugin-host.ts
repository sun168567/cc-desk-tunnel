import { createWriteStream } from 'node:fs';
import { text } from 'node:stream/consumers';

// The process a plugin's ui file is loaded in (see plugin-ui.ts): its code may hang, throw or exit without the service
// being any the worse. It answers one request and ends.
type Field = {
  type: string;
  validate?: (value: unknown, all: object) => unknown;
  run?: (all: object) => unknown;
};
type Request = {
  file: string;
  values?: Record<string, unknown>;
  // The fields to validate.
  check?: string[];
  button?: string;
};

async function answer({ file, values = {}, check, button }: Request) {
  const ui = await import(file);
  const fields: Record<string, Field> = Object.assign(
    {},
    ...(ui.settings ?? []).map((group: { fields: object }) => group.fields),
  );
  if (check) {
    const errors: Record<string, string> = {};
    for (const name of check) {
      const result = (await fields[name]?.validate?.(values[name], values)) as
        { valid?: boolean; message?: string } | undefined;
      if (result && result.valid !== true) errors[name] = String(result.message ?? '无效');
    }
    return { errors };
  }
  if (button) {
    const result = (await fields[button]?.run?.(values)) as { ok?: boolean; message?: string };
    if (typeof result?.ok !== 'boolean') throw new Error('按钮要返回 { ok, message }。');
    return { ok: result.ok, message: String(result.message ?? '') };
  }
  return { settings: ui.settings ?? [], slots: ui.slots ?? {} };
}

const reply = await answer(JSON.parse(await text(process.stdin))).catch((error: unknown) => ({
  failure: error instanceof Error ? error.message : String(error),
}));
// What was declared goes over without its functions.
createWriteStream('', { fd: 3 }).end(JSON.stringify(reply), () => process.exit(0));
