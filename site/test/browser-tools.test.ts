import { describe, expect, it, vi } from 'vitest';
import { registerCalculatorTool, type BrowserToolContext } from '../src/browser-tools.js';
import { playgrounds } from '../src/playgrounds/index.js';

describe('optional page-scoped calculator tools (mock contract, not host certification)', () => {
  it.each(playgrounds)(
    '$id validates, calls the visible action, and returns its result',
    async (playground) => {
      let tool: Parameters<BrowserToolContext['registerTool']>[0] | undefined;
      const lifecycle = new AbortController();
      const context: BrowserToolContext = {
        registerTool(candidate, options) {
          tool = candidate;
          expect(options.signal).toBe(lifecycle.signal);
        },
      };
      const display = vi.fn(async (input: Record<string, number>) => playground.run(input));
      await registerCalculatorTool(context, playground, display, lifecycle.signal);
      expect(tool?.name).toBe(`calculate_${playground.id.replaceAll('-', '_')}`);
      expect(tool?.annotations.readOnlyHint).toBe(false);
      expect(tool?.inputSchema).toMatchObject({
        additionalProperties: false,
        required: playground.controls.map((control) => control.name),
      });
      for (const input of [null, {}, { typo: 3 }])
        await expect(tool!.execute(input)).rejects.toThrow();
      expect(display).not.toHaveBeenCalled();
      const input = Object.fromEntries(
        playground.controls.map((control) => [control.name, control.value]),
      );
      const result = await tool!.execute(input);
      expect(result).toMatchObject({ result: playground.run(input).result });
      expect(display).toHaveBeenCalledOnce();
    },
  );
  it('does nothing without a supported host', async () => {
    const run = vi.fn();
    await registerCalculatorTool(undefined, playgrounds[0]!, run, new AbortController().signal);
    expect(run).not.toHaveBeenCalled();
  });
});
