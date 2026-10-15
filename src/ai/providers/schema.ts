/**
 * The JSON-schema subset NoobIDE's AI tools use, and a strict validator for it (S31.1). Tool inputs streamed with
 * eager input streaming are not validated by the provider, so every tool input is checked here before it is used:
 * an input that fails is never run (decision 0025, tool-use rules).
 *
 * Supported: type object/string/number/integer/boolean/array, properties, required, additionalProperties: false,
 * items, enum (strings), minLength/maxLength, minimum/maximum, maxItems.
 */
export interface JsonSchema {
  readonly type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxItems?: number;
}

/** Returns a short description of the first problem (no input text in it), or null when the value matches. */
export function validateJsonSchema(schema: JsonSchema, value: unknown, at = 'input'): string | null {
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${at} must be an object`;
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record) || record[key] === undefined) return `${at}.${key} is required`;
      }
      for (const [key, child] of Object.entries(record)) {
        const childSchema = schema.properties?.[key];
        if (!childSchema) {
          if (schema.additionalProperties === false) return `${at}.${key} is not allowed`;
          continue;
        }
        const problem = validateJsonSchema(childSchema, child, `${at}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
    case 'string':
      if (typeof value !== 'string') return `${at} must be a string`;
      if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}`;
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${at} is too short`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${at} is too long`;
      return null;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${at} must be a number`;
      if (schema.type === 'integer' && !Number.isInteger(value)) return `${at} must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} is too small`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} is too large`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${at} must be true or false`;
    case 'array': {
      if (!Array.isArray(value)) return `${at} must be a list`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at} has too many items`;
      if (!schema.items) return null;
      for (let i = 0; i < value.length; i += 1) {
        const problem = validateJsonSchema(schema.items, value[i], `${at}[${i}]`);
        if (problem) return problem;
      }
      return null;
    }
  }
}
