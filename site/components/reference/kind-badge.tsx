export const KIND_BADGE: Record<string, string> = {
  function: 'fn',
  value: 'const',
  class: 'class',
  interface: 'iface',
  type: 'type',
  namespace: 'ns',
};

export function KindBadge({ kind }: { kind: string }) {
  return <span className={`tf-kind tf-kind-${kind}`}>{KIND_BADGE[kind] ?? kind}</span>;
}
