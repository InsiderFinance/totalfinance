/**
 * ONE TYPED READER FOR THE PUBLISHED CONTRACT NODES.
 *
 * Every consumer of `public-contracts.json` used to declare its own local shape and walk whichever
 * child relationships it happened to need. That is why deleting `branchFields` broke a package test
 * and silently narrowed another: each reader named the representation it wanted in its own
 * interface, so the compiler had nothing to object to and the omission surfaced as a red suite in one
 * place and as quieter coverage in the other.
 *
 * The fix is not "remember to update every reader". It is that there is one place where the node
 * shape is written down and one place where its children are enumerated, so a representation change
 * is a compile error at every call site rather than a silent narrowing at some of them.
 *
 * `childNodes` is the load-bearing half: it returns EVERY child a node can have, each paired with the
 * route step that reaches it. A consumer that walks it cannot forget arms, tuple positions, callback
 * returns or array elements, because forgetting one is no longer something a consumer can do.
 */

import type { CallableSignatureNode } from './contract-fields.js';

/**
 * One admitted value of a closed primitive domain.
 *
 * Numbers and booleans as well as strings: `order?: 1 | 2` is a domain and was published as a bare
 * `number` while the producer skipped its arms on the grounds the values were recorded here.
 */
export type LiteralValue = string | number | boolean;

/** One step from a node to a child — the same vocabulary `RouteStep` uses for arguments. */
export type NodeStep =
  | { property: string }
  | { element: true }
  | { position: number }
  | { branch: number }
  | { returns: true };

/**
 * A node in the published contract graph.
 *
 * Deliberately ONE interface for parameters and fields alike: the artifact distinguishes them by
 * which keys are present (`fieldTree` at a parameter, `fields` below one), and a reader that walks
 * the graph should not have to care which level it is standing on. Every optional key here is a key
 * the generator emits; nothing is aspirational.
 */
export interface ManifestNode {
  name?: string;
  type?: string;
  kind?: string;
  optional?: boolean;
  nullable?: boolean;
  literals?: LiteralValue[];
  /** The declared members, below a parameter. */
  fields?: ManifestNode[];
  /** The declared members OF a parameter — the same thing one level up. */
  fieldTree?: ManifestNode[];
  /** A sequence parameter's element contract. */
  elementFieldTree?: ManifestNode[];
  /** What a sequence holds — one declared shape however many values. */
  element?: ManifestNode;
  /** A fixed-arity tuple's positions, which are separate declarations sharing a container. */
  tuple?: ManifestNode[];
  /**
   * The declared members OF each tuple position — `tuple`'s field-tree twin, one list per position.
   *
   * The producer emits this alongside `tupleContracts` for positions whose type is an object, and it
   * is a SEPARATE relationship from `tuple`: a parameter can carry members for its positions without
   * carrying position nodes. 140 nodes publish 690 members here that nothing could reach until this
   * function enumerated them.
   */
  tupleFieldTrees?: (ManifestNode[] | null)[];
  /** The contract identity of each tuple position, positionally aligned with `tupleFieldTrees`. */
  tupleContracts?: (string | null)[];
  /** A callable's resolved return contract. */
  returns?: ManifestNode;
  /** Every arm of a union, as complete nodes. */
  branches?: ManifestNode[];
  callSignature?: { parameters: number; returns: string };
  callSignatures?: CallableSignatureNode[];
  truncated?: boolean;
}

export interface ManifestSignature {
  parameters?: ManifestNode[];
  returns?: string;
}

export interface ManifestRecord {
  id: string;
  package?: string;
  implementation?: string;
  /** Which kind of callable this record is about — a constructor is not reached by a call signature. */
  boundaryKind?: string;
  signatures?: ManifestSignature[];
}

export interface ManifestArtifact {
  contracts?: ManifestRecord[];
}

/**
 * The arms of a union, or `null` when the node is not one.
 *
 * A single-arm "union" is not a union — it is one type — so it answers `null` here, and every reader
 * gets that judgement from the same place rather than each spelling its own `> 1`.
 */
export function armsOfNode(node: ManifestNode | undefined): ManifestNode[] | null {
  return node?.branches && node.branches.length > 1 ? node.branches : null;
}

/**
 * EVERY child of a node, with the step that reaches it.
 *
 * The enumeration is exhaustive by construction and lives here alone. A consumer that wants "all
 * nested unions" or "all tuple positions" walks this; it does not get to walk four of the six
 * relationships and report a clean sweep, which is exactly how 340 nested unions stayed invisible to
 * a gate that was looking for them.
 *
 * `fieldTree` and `fields` both yield `{ property }` steps because they are the same relationship at
 * two levels; `elementFieldTree` yields `element` then `property`, which is what it means.
 */
export function childNodes(node: ManifestNode): { node: ManifestNode; steps: NodeStep[] }[] {
  const children: { node: ManifestNode; steps: NodeStep[] }[] = [];
  for (const field of node.fieldTree ?? []) {
    children.push({ node: field, steps: [{ property: field.name ?? '' }] });
  }
  for (const field of node.fields ?? []) {
    children.push({ node: field, steps: [{ property: field.name ?? '' }] });
  }
  if (node.element) children.push({ node: node.element, steps: [{ element: true }] });
  /**
   * `elementFieldTree` members are reached THROUGH the element, so the route says so.
   *
   * The artifact records a sequence parameter's element contract as a flat member list — the element
   * itself is never a node — and an earlier version of this function mirrored that by emitting a
   * bare `{ property }`. That made the route a description of the ARTIFACT'S SHAPE rather than of
   * the declaration, and a route that does not describe the declaration cannot be compared against
   * anything that walks the declaration.
   */
  for (const field of node.elementFieldTree ?? []) {
    children.push({ node: field, steps: [{ element: true }, { property: field.name ?? '' }] });
  }
  (node.tuple ?? []).forEach((position, index) => {
    if (position) children.push({ node: position, steps: [{ position: index }] });
  });
  /**
   * `tupleFieldTrees` members are reached THROUGH their position, exactly as `elementFieldTree`
   * members are reached through the element.
   *
   * This relationship was missing while the docblock above claimed the enumeration was exhaustive.
   * It happened to cost nothing — 690 members across 140 nodes and not one union among them — which
   * is precisely why it is worth closing: a reader whose exhaustiveness claim is true only because
   * of what the surface currently happens to contain is the same shape as a gate that passes because
   * its subject is empty.
   */
  (node.tupleFieldTrees ?? []).forEach((members, index) => {
    for (const field of members ?? []) {
      children.push({ node: field, steps: [{ position: index }, { property: field.name ?? '' }] });
    }
  });
  (node.branches ?? []).forEach((arm, index) => {
    if (arm) children.push({ node: arm, steps: [{ branch: index }] });
  });
  if (node.returns) children.push({ node: node.returns, steps: [{ returns: true }] });
  return children;
}

/** A node reached by a walk, with the route that reached it and its depth. */
export interface VisitedNode {
  node: ManifestNode;
  route: NodeStep[];
  depth: number;
}

/**
 * Walk a node and everything beneath it, breadth of relationship before depth of nesting.
 *
 * The depth cap is a runaway guard, not a modelling decision: the generator already bounds what it
 * records, so a walk that terminates only because of this bound is looking at an artifact that
 * should not exist. It defaults well above the generator's own cap for that reason.
 */
export function walkManifest(
  root: ManifestNode,
  visit: (visited: VisitedNode) => void,
  { maxDepth = 24 }: { maxDepth?: number } = {},
): void {
  const stack: VisitedNode[] = [{ node: root, route: [], depth: 0 }];
  const seen = new Set<ManifestNode>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    // Object identity, not shape: the artifact shares node objects after JSON parse only when they
    // are literally the same node, which is precisely the cycle this needs to stop.
    if (seen.has(current.node)) continue;
    seen.add(current.node);
    visit(current);
    if (current.depth >= maxDepth) continue;
    for (const child of childNodes(current.node)) {
      stack.push({
        node: child.node,
        route: [...current.route, ...child.steps],
        /**
         * A BRANCH IS NOT A LEVEL. An arm is the union viewed one way, not a child of it — the same
         * accounting the producer uses, where charging an arm a level left named object arms
         * truncated and empty.
         */
        depth: current.depth + (child.steps.some((step) => 'branch' in step) ? 0 : 1),
      });
    }
  }
}

/** Render a route for a human — `arg0.entry[1]|2.value[]`. */
export function renderRoute(route: readonly NodeStep[]): string {
  return route
    .map((step) =>
      'property' in step
        ? `.${step.property}`
        : 'element' in step
          ? '[]'
          : 'position' in step
            ? `[${step.position}]`
            : 'branch' in step
              ? `|${step.branch}`
              : '()',
    )
    .join('');
}

/** Every parameter of every signature of every record, with its record and argument index. */
export function eachParameter(
  artifact: ManifestArtifact,
  visit: (entry: {
    record: ManifestRecord;
    parameter: ManifestNode;
    signatureIndex: number;
    argumentIndex: number;
  }) => void,
): void {
  for (const record of artifact.contracts ?? []) {
    (record.signatures ?? []).forEach((signature, signatureIndex) => {
      (signature.parameters ?? []).forEach((parameter, argumentIndex) => {
        visit({ record, parameter, signatureIndex, argumentIndex });
      });
    });
  }
}
