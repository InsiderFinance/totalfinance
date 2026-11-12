import { playgrounds } from '@/src/playgrounds';
import { defaultInput } from '@/src/playgrounds/inputs';
import { stripSamples } from '@/src/playgrounds/transport';
import dynamic from 'next/dynamic';

/** Code-split: only pages that render a calculator download its client code (charts, controls, worker). */
const PlaygroundShell = dynamic(() =>
  import('./playground-shell').then((module) => module.PlaygroundShell),
);

/**
 * Server half of a calculator: runs the default inputs at build time so the page is complete
 * without JavaScript, then hands interactivity to the client. Only data crosses the boundary:
 * samples travel as ids and the full result object is recomputed in the browser on demand.
 */
export function PlaygroundSection({ id }: { id: string }) {
  const playground = playgrounds.find((candidate) => candidate.id === id);
  if (!playground) throw new Error(`Unknown playground ${id}.`);
  const calculation = playground.run(defaultInput(playground));
  return (
    <PlaygroundShell
      id={playground.id}
      title={playground.title}
      introduction={playground.introduction}
      controls={stripSamples(playground.controls)}
      initial={{ ...calculation, result: null }}
    />
  );
}
