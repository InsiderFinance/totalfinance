import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserToolContext } from '../src/browser-tools.js';
import { options } from '../src/playgrounds/options.js';
import { renderExamples } from '../src/render.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function setup() {
  vi.useFakeTimers();
  const inputs = options.controls.map((control) => ({
    name: control.name,
    value: String(control.value),
    disabled: true,
  }));
  const submit = { disabled: true };
  const formHandlers = new Map<string, (event: { preventDefault(): void }) => void>();
  const form = {
    querySelector: () => submit,
    querySelectorAll: (selector: string) =>
      selector === 'input[name]' ? inputs : [...inputs, submit],
    addEventListener: (name: string, handler: (event: { preventDefault(): void }) => void) =>
      formHandlers.set(name, handler),
    reportValidity: () => true,
  };
  const output = { innerHTML: '', removeAttribute: vi.fn(), setAttribute: vi.fn() };
  const status = { textContent: '', classList: { add: vi.fn(), remove: vi.fn() } };
  const root = {
    dataset: { playground: options.id },
    querySelector: (selector: string) =>
      selector === 'form' ? form : selector === '[data-output]' ? output : status,
  };
  const examples = { innerHTML: '' };
  const code = { textContent: 'const result = calculate(data);' };
  const prefix = { textContent: 'const data = [100, 102, 104];' };
  const fallback = { textContent: '', hidden: true, focus: vi.fn() };
  let click!: (event: { target: unknown }) => Promise<void>;
  let tool: Parameters<BrowserToolContext['registerTool']>[0] | undefined;
  const selectNodeContents = vi.fn();
  vi.stubGlobal('document', {
    addEventListener: (_name: string, handler: typeof click) => {
      click = handler;
    },
    querySelectorAll: () => [root],
    querySelector: () => null,
    getElementById: (id: string) =>
      ({
        'calculation-examples': examples,
        'first-call-code': code,
        'sample-setup': prefix,
        'copy-fallback': fallback,
      })[id],
    createRange: () => ({ selectNodeContents }),
    modelContext: {
      registerTool: (candidate: typeof tool) => {
        tool = candidate;
      },
    },
  });
  const clipboard = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    getSelection: () => ({ removeAllRanges: vi.fn(), addRange: vi.fn() }),
  });
  vi.stubGlobal('Worker', undefined);
  vi.stubGlobal(
    'FormData',
    class {
      entries() {
        return inputs.map((input) => [input.name, input.value]);
      }
    },
  );
  class Button {
    textContent = 'Copy setup + call';
    dataset: Record<string, string> = { copy: 'first-call-code', copyPrefix: 'sample-setup' };
    closest() {
      return this;
    }
  }
  vi.stubGlobal('Element', Button);
  await import('../src/client.js');
  await vi.waitFor(() => expect(tool).toBeDefined());
  return {
    examples,
    status,
    inputs,
    clipboard,
    fallback,
    selectNodeContents,
    copy: () => click({ target: new Button() }),
    execute: (input: unknown) => tool!.execute(input),
    submit: async () => {
      formHandlers.get('submit')!({ preventDefault() {} });
      await vi.waitFor(() => expect(submit.disabled).toBe(false));
    },
  };
}

describe('example copy/update behavior (mock document, not browser certification)', () => {
  it('copies setup and call as one executable source, with a complete selectable fallback', async () => {
    const page = await setup();
    const expected = 'const data = [100, 102, 104];\n\nconst result = calculate(data);';
    await page.copy();
    expect(page.clipboard).toHaveBeenLastCalledWith(expected);
    page.clipboard.mockRejectedValueOnce(new Error('Permission denied'));
    await page.copy();
    expect(page.fallback.textContent).toBe(expected);
    expect(page.fallback.hidden).toBe(false);
    expect(page.fallback.focus).toHaveBeenCalledOnce();
    expect(page.selectNodeContents).toHaveBeenLastCalledWith(page.fallback);
  });

  it('updates both examples after form and tool success; failed inputs retain the last successful copies', async () => {
    const page = await setup();
    page.inputs[0]!.value = '101';
    await page.submit();
    const input = Object.fromEntries(page.inputs.map((field) => [field.name, Number(field.value)]));
    expect(page.examples.innerHTML).toBe(renderExamples(options.run(input)));
    await page.execute({ ...input, spot: 102 });
    expect(page.examples.innerHTML).toBe(renderExamples(options.run({ ...input, spot: 102 })));
    const previous = page.examples.innerHTML;
    await expect(page.execute({ ...input, spot: -1 })).rejects.toThrow();
    expect(page.examples.innerHTML).toBe(previous);
    page.inputs[0]!.value = '-1';
    await page.submit();
    expect(page.status.classList.add).toHaveBeenCalledWith('error');
    expect(page.examples.innerHTML).toBe(previous);
  });
});
