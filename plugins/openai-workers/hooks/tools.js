// Deliberately small whitelist of Claude Code tools exposed to OpenAI.
// Claude Code itself remains responsible for running each call and checking permissions.
const s = description => ({ type: 'string', description });
const n = description => ({ type: 'integer', description });
const b = description => ({ type: 'boolean', description });
export const TOOL_SPECS = {
  Read: {
    description: 'Read a file from the project. Use an absolute path.',
    properties: { file_path: s('Absolute path'), offset: n('First line, optional'), limit: n('Max lines, optional') },
    required: ['file_path'],
  },
  Edit: {
    description: 'Edit an existing file by replacing an exact string; read the file before editing.',
    properties: { file_path: s('Absolute path'), old_string: s('Exact old text'), new_string: s('Replacement text'), replace_all: b('Replace all occurrences') },
    required: ['file_path', 'old_string', 'new_string'],
  },
  Write: {
    description: 'Create or replace a project file with its complete content.',
    properties: { file_path: s('Absolute path'), content: s('Complete content') },
    required: ['file_path', 'content'],
  },
  Bash: {
    description: 'Run a shell command through Claude Code permissions. For searches, use rg -n.',
    properties: { command: s('Shell command'), description: s('Short description'), timeout: n('Timeout in milliseconds, up to 600000') },
    required: ['command'],
  },
};
export const OPENAI_TOOLS = Object.entries(TOOL_SPECS).map(([name, t]) => ({
  type: 'function', name, description: t.description,
  parameters: { type: 'object', properties: t.properties, required: t.required },
  strict: false,
}));
export function filterToolArgs(name, raw) {
  if (!(name in TOOL_SPECS)) throw new Error(`Unsupported tool: ${name}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid arguments for ${name}`);
  const spec = TOOL_SPECS[name];
  for (const prop of spec.required) if (typeof raw[prop] !== 'string') throw new Error(`Missing ${name}.${prop}`);
  return Object.fromEntries(Object.entries(raw).filter(([key]) => Object.hasOwn(spec.properties, key)));
}
