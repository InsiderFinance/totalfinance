import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';

const schema = pageSchema.extend({
  /** Repository-relative source when the page is generated from the repository's public docs. */
  source: z.string().optional(),
  /** Calculator rendered by the page. */
  playground: z.string().optional(),
  /** The page shows install or run commands whose availability depends on publication. */
  installs: z.boolean().optional(),
});

/** Authored pages (MDX). */
export const docs = defineDocs({
  dir: 'content/docs',
  docs: { schema, postprocess: { includeProcessedMarkdown: true } },
});

/** Pages generated from docs/guides and other public repository documents (Markdown). */
export const guides = defineDocs({
  dir: 'content/generated',
  docs: { schema, postprocess: { includeProcessedMarkdown: true } },
});

export default defineConfig({
  mdxOptions: {
    // Code panels are dark in both themes, so one theme keeps the markup half the size.
    rehypeCodeOptions: {
      themes: { light: 'vesper', dark: 'vesper' },
      defaultColor: 'light',
    },
  },
});
