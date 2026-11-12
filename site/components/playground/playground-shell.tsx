'use client';
import { useMemo } from 'react';
import { restoreSamples } from '@/src/playgrounds/transport';
import { PlaygroundClient, type PlaygroundClientProps } from './playground-client';

/** Restores sample datasets in the browser before the calculator mounts. */
export function PlaygroundShell(props: PlaygroundClientProps) {
  const controls = useMemo(() => restoreSamples(props.controls), [props.controls]);
  return <PlaygroundClient {...props} controls={controls} />;
}
