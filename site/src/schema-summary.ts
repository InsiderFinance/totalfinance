/** Top-level fields of a JSON Schema, for compact operation summaries. */
export interface SchemaNode {
  type?: string | string[];
  description?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  enum?: unknown[];
  items?: SchemaNode;
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
}

function typeOf(node: SchemaNode | undefined): string {
  if (!node) return 'any';
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (node.oneOf ?? node.anyOf) return (node.oneOf ?? node.anyOf)!.map(typeOf).join(' | ');
  if (node.type === 'array') return `${typeOf(node.items)}[]`;
  return Array.isArray(node.type) ? node.type.join(' | ') : (node.type ?? 'object');
}

export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export function schemaSummary(schema: unknown): SchemaField[] {
  const node = schema as SchemaNode;
  const required = new Set(node?.required ?? []);
  return Object.entries(node?.properties ?? {}).map(([name, field]) => ({
    name,
    type: typeOf(field),
    required: required.has(name),
    description: (field.description ?? '').replace(/\s+/g, ' ').slice(0, 280),
  }));
}
