import type { JsonSchema } from "./api";

const supportedKeywords = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "oneOf", "minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems", "uniqueItems"]);
const supportedTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Internal contract-schema subset only. Arbitrary device schemas need a standards-compliant validator. */
export function schemaErrors(schema: JsonSchema, value: unknown, path = "$"): string[] {
  for (const keyword of Object.keys(schema)) if (!supportedKeywords.has(keyword)) throw new TypeError(`${path}: unsupported schema keyword ${keyword}`);
  if (schema.type !== undefined && !supportedTypes.has(schema.type)) throw new TypeError(`${path}: unsupported schema type ${schema.type}`);
  if (schema.anyOf && !schema.anyOf.some((item) => schemaErrors(item, value, path).length === 0)) return [`${path}: no variant matched`];
  if (schema.oneOf && schema.oneOf.filter((item) => schemaErrors(item, value, path).length === 0).length !== 1) return [`${path}: expected one variant`];
  if (schema.const !== undefined && value !== schema.const) return [`${path}: expected constant`];
  if (schema.enum && !schema.enum.some((item) => item === value)) return [`${path}: not in enum`];
  if (schema.type === "null") return value === null ? [] : [`${path}: expected null`];
  if (schema.type === "string") {
    if (typeof value !== "string") return [`${path}: expected string`];
    if (schema.minLength !== undefined && [...value].length < schema.minLength) return [`${path}: too short`];
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return [`${path}: too long`];
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return [`${path}: pattern mismatch`];
    return [];
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) return [`${path}: expected finite ${schema.type}`];
    if (schema.minimum !== undefined && value < schema.minimum) return [`${path}: below minimum`];
    if (schema.maximum !== undefined && value > schema.maximum) return [`${path}: above maximum`];
    return [];
  }
  if (schema.type === "boolean") return typeof value === "boolean" ? [] : [`${path}: expected boolean`];
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    const errors: string[] = [];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.uniqueItems && new Set(value.map(canonicalJson)).size !== value.length) errors.push(`${path}: duplicate items`);
    if (schema.items) value.forEach((item, i) => errors.push(...schemaErrors(schema.items!, item, `${path}[${i}]`)));
    return errors;
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object`];
    const object = value as Record<string, unknown>;
    const errors: string[] = [];
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) errors.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(object)) {
      const rule = schema.properties?.[key];
      if (rule) errors.push(...schemaErrors(rule, item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unexpected`);
      else if (typeof schema.additionalProperties === "object") errors.push(...schemaErrors(schema.additionalProperties, item, `${path}.${key}`));
    }
    return errors;
  }
  return [];
}

export function matchesSchema(schema: JsonSchema, value: unknown): boolean {
  return schemaErrors(schema, value).length === 0;
}
