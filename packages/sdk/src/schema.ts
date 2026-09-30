import type { JsonSchema } from "./api";

const supportedKeywords = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "oneOf", "minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems", "uniqueItems"]);
const supportedTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const typedKeywords: Record<string, readonly string[]> = {
  object: ["properties", "required", "additionalProperties"],
  array: ["items", "minItems", "maxItems", "uniqueItems"],
  string: ["minLength", "maxLength", "pattern"],
  number: ["minimum", "maximum"],
  integer: ["minimum", "maximum"],
};
function assertInternalSchema(schema: JsonSchema, path = "$", active = new WeakSet<object>()): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new TypeError(`${path}: schema must be an object`);
  if (active.has(schema)) throw new TypeError(`${path}: circular schema`);
  active.add(schema);
  for (const keyword of Object.keys(schema)) if (!supportedKeywords.has(keyword)) throw new TypeError(`${path}: unsupported schema keyword ${keyword}`);
  if (schema.type !== undefined && !supportedTypes.has(schema.type)) throw new TypeError(`${path}: unsupported schema type ${schema.type}`);
  for (const [type, keywords] of Object.entries(typedKeywords)) {
    for (const keyword of keywords) if (Object.hasOwn(schema, keyword) && schema.type !== type && !(type === "number" && schema.type === "integer") && !(type === "integer" && schema.type === "number")) throw new TypeError(`${path}: ${keyword} requires ${type} type`);
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) throw new TypeError(`${path}: invalid properties`);
    for (const [key, child] of Object.entries(schema.properties)) assertInternalSchema(child, `${path}.properties.${key}`, active);
  }
  if (schema.items !== undefined) assertInternalSchema(schema.items, `${path}.items`, active);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") assertInternalSchema(schema.additionalProperties, `${path}.additionalProperties`, active);
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (branches !== undefined) {
      if (!Array.isArray(branches) || branches.length === 0) throw new TypeError(`${path}: ${keyword} must be a non-empty array`);
      branches.forEach((child, i) => assertInternalSchema(child, `${path}.${keyword}[${i}]`, active));
    }
  }
  active.delete(schema);
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Internal contract-schema subset only. Arbitrary device schemas need a standards-compliant validator. */
export function schemaErrors(schema: JsonSchema, value: unknown, path = "$"): string[] {
  assertInternalSchema(schema, path);
  return valueErrors(schema, value, path);
}

function valueErrors(schema: JsonSchema, value: unknown, path: string): string[] {
  if (schema.anyOf && !schema.anyOf.some((item) => valueErrors(item, value, path).length === 0)) return [`${path}: no variant matched`];
  if (schema.oneOf && schema.oneOf.filter((item) => valueErrors(item, value, path).length === 0).length !== 1) return [`${path}: expected one variant`];
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
    if (schema.items) value.forEach((item, i) => errors.push(...valueErrors(schema.items!, item, `${path}[${i}]`)));
    return errors;
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object`];
    const object = value as Record<string, unknown>;
    const errors: string[] = [];
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) errors.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(object)) {
      const rule = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (rule) errors.push(...valueErrors(rule, item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unexpected`);
      else if (typeof schema.additionalProperties === "object") errors.push(...valueErrors(schema.additionalProperties, item, `${path}.${key}`));
    }
    return errors;
  }
  return [];
}

export function matchesSchema(schema: JsonSchema, value: unknown): boolean {
  return schemaErrors(schema, value).length === 0;
}
