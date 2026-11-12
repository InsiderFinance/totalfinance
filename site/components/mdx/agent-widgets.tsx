import { agentProfiles, operations } from '@/lib/data';

export function AgentProfiles() {
  return (
    <div className="not-prose my-6 overflow-x-auto rounded-xl border border-fd-border">
      <table className="w-full text-sm">
        <thead className="bg-fd-muted text-left text-xs text-fd-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Profile</th>
            <th className="px-4 py-2 font-medium">Packs</th>
            <th className="px-4 py-2 text-right font-medium">Registered operations</th>
          </tr>
        </thead>
        <tbody>
          {agentProfiles().map((row) => (
            <tr key={row.profile} className="border-t border-fd-border align-top">
              <td className="px-4 py-2 font-mono text-[0.8125rem] font-semibold">{row.profile}</td>
              <td className="px-4 py-2 font-mono text-xs text-fd-muted-foreground">
                {row.packs.join(', ')}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{row.operations}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-fd-border px-4 py-2 text-xs text-fd-muted-foreground">
        Counts are registered operations before permission filtering. A profile never grants write
        authority.
      </p>
    </div>
  );
}

export function OperationCount({ which = 'all' }: { which?: 'all' | 'default' }) {
  const all = operations();
  return (
    <>
      {which === 'default'
        ? all.filter((operation) => operation.defaultEnabled).length
        : all.length}
    </>
  );
}
