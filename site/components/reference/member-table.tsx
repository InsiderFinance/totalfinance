import type { MemberView } from '@/src/site-data';
import { JsDocText } from './jsdoc-text';

/** Compact markup: styling lives in `.tf-mt` (global.css) so large contracts stay light. */
export function MemberTable({ members }: { members: MemberView[] }) {
  return (
    <div className="tf-mt-wrap tf-scrollbar">
      <table className="tf-mt">
        <thead>
          <tr>
            <th>Name · type</th>
            <th>Meaning · unit</th>
            <th>Required · default</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.name}>
              <td>
                <code className="tf-mt-name">{member.name}</code>
                <code className="tf-mt-type">{member.type}</code>
              </td>
              <td>
                {member.description ? (
                  <JsDocText text={member.description} className="tf-mt-doc" />
                ) : (
                  '—'
                )}
                <span className="tf-mt-unit">{member.unit}</span>
              </td>
              <td>
                <span className={member.optional ? 'tf-mt-opt' : 'tf-mt-req'}>
                  {member.optional ? 'Optional' : 'Required'}
                </span>
                <span className="tf-mt-default">
                  {member.defaultValue !== null ? (
                    <>
                      Default <code>{member.defaultValue}</code>
                    </>
                  ) : (
                    'No @default declared'
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
