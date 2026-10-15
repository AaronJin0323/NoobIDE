import type { JsonSchema } from './model-port';

/**
 * Validates a tool input against the small JSON Schema subset the agent's tools use (S34.1): an object with
 * `properties` of type string / integer / boolean (with `enum`, `minLength`, `maxLength`, `minimum`, `maximum`),
 * `required`, and `additionalProperties: false`. Providers that stream tool input eagerly do not validate it, and a
 * tolerant parser can hand back a truncated object, so every input is checked here before a tool runs.
 * Returns null when valid, otherwise a short reason (never echoes the input itself).
 */
export function validateToolInput(schema: JsonSchema, input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'input must be a JSON object';
  const record = input as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as readonly string[];
  for (const name of required) {
    if (!Object.hasOwn(record, name) || record[name] === undefined) return `missing required field "${name}"`;
  }
  for (const [name, value] of Object.entries(record)) {
    const property = Object.hasOwn(properties, name) ? properties[name] : undefined;
    if (!property) {
      if (schema.additionalProperties === false) return `unknown field "${name}"`;
      continue;
    }
    const problem = checkValue(name, property, value);
    if (problem) return problem;
  }
  return null;
}

function checkValue(name: string, property: Record<string, unknown>, value: unknown): string | null {
  switch (property.type) {
    case 'string': {
      if (typeof value !== 'string') return `"${name}" must be a string`;
      if (typeof property.minLength === 'number' && value.length < property.minLength) return `"${name}" is too short`;
      if (typeof property.maxLength === 'number' && value.length > property.maxLength) return `"${name}" is too long`;
      break;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return `"${name}" must be an integer`;
      if (typeof property.minimum === 'number' && value < property.minimum) return `"${name}" is too small`;
      if (typeof property.maximum === 'number' && value > property.maximum) return `"${name}" is too large`;
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') return `"${name}" must be true or false`;
      break;
    default:
      return `"${name}" has an unsupported type`;
  }
  if (Array.isArray(property.enum) && !property.enum.includes(value))
    return `"${name}" is not one of the allowed values`;
  return null;
}
