import type { Calculation, Playground } from './types.js';
import { validateInputs } from './playgrounds/load.js';

/** Optional proposed browser API; ordinary browsers keep the complete visible interface. */
export interface BrowserToolContext {
  registerTool(
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute(input: unknown): Promise<unknown>;
    },
    options: { signal: AbortSignal },
  ): void | Promise<void>;
}

export async function registerCalculatorTool(
  context: BrowserToolContext | undefined,
  playground: Playground,
  runAndDisplay: (input: Record<string, number>) => Promise<Calculation>,
  signal: AbortSignal,
): Promise<void> {
  if (!context?.registerTool) return;
  await context.registerTool(
    {
      name: `calculate_${playground.id.replaceAll('-', '_')}`,
      title: playground.title,
      description: `${playground.introduction} Runs the visible sample calculator and updates its inputs, results, charts, and copyable TypeScript. Does not fetch data, store a portfolio, or place orders. All financial inputs are explicit; control defaults are hypothetical examples, not recommendations.`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: playground.controls.map((control) => control.name),
        properties: Object.fromEntries(
          playground.controls.map((control) => [
            control.name,
            {
              type: 'number',
              description: `${control.label}; ${control.unit}`,
              minimum: control.min,
              maximum: control.max,
            },
          ]),
        ),
      },
      // The calculation is pure, but this action deliberately changes the visible page state.
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        const result = await runAndDisplay(validateInputs(playground, input));
        return {
          metrics: result.metrics,
          assumptions: result.assumptions,
          diagnostics: result.diagnostics,
          result: result.result,
          code: result.code,
        };
      },
    },
    { signal },
  );
}
