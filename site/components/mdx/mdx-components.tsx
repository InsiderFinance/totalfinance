import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';
import Link from 'next/link';
import { DomainGrid, EntrypointList, KeyExports } from './reference-widgets';
import { PlaygroundGallery } from './playground-gallery';
import { AgentProfiles, OperationCount } from './agent-widgets';
import { GuideIndex } from './guide-index';
import { ConnectAgent } from '../agents/connect-agent';

/** Internal links go through Next (base path aware); everything else is a plain anchor. */
function Anchor({ href = '', ...props }: ComponentProps<'a'>) {
  if (href.startsWith('/') && !href.startsWith('//')) return <Link href={href} {...props} />;
  return <a href={href} {...props} />;
}

export function mdxComponents(extra?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    a: Anchor,
    Callout,
    Card,
    Cards,
    Step,
    Steps,
    Tab,
    Tabs,
    DomainGrid,
    EntrypointList,
    KeyExports,
    PlaygroundGallery,
    AgentProfiles,
    OperationCount,
    GuideIndex,
    ConnectAgent,
    ...extra,
  };
}
