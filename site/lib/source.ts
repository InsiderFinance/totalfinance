import { docs, guides } from '@/.source/server';
import { loader, multiple } from 'fumadocs-core/source';

/** One page tree over authored MDX and generated guide Markdown. URLs are base-path relative. */
export const source = loader({
  baseUrl: '/',
  source: multiple({ docs: docs.toFumadocsSource(), guides: guides.toFumadocsSource() }),
});

export type SourcePage = NonNullable<ReturnType<typeof source.getPage>>;
