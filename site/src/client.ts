import { escapeHtml, renderCalculation, renderExamples } from './render.js';
import type { Calculation } from './types.js';
import { loadPlayground, validateInputs } from './playgrounds/load.js';
import { search, type SearchRecord } from './search.js';
import { registerCalculatorTool, type BrowserToolContext } from './browser-tools.js';

let requestSequence = 0;
async function calculate(playgroundId: string, input: unknown): Promise<Calculation> {
  if (typeof Worker === 'undefined') {
    const playground = await loadPlayground(playgroundId);
    return playground.run(validateInputs(playground, input));
  }
  const worker = new Worker(new URL('./calculation-worker.js', import.meta.url), {
    type: 'module',
  });
  const requestId = ++requestSequence;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(
        new Error('Calculation stopped after 10 seconds. Reset the sample and try smaller inputs.'),
      );
    }, 10000);
    worker.onmessage = (
      event: MessageEvent<{ requestId: number; result?: Calculation; error?: string }>,
    ) => {
      if (event.data.requestId !== requestId) return;
      window.clearTimeout(timeout);
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.result) resolve(event.data.result);
      else reject(new Error('The calculation returned no result.'));
    };
    worker.onerror = () => {
      window.clearTimeout(timeout);
      worker.terminate();
      reject(
        new Error(
          'The calculation worker could not load. Reload this page or use the copied TypeScript example.',
        ),
      );
    };
    worker.postMessage({ requestId, playgroundId, input });
  });
}

document.addEventListener('click', async (event) => {
  const target =
    event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-copy]') : null;
  if (!target) return;
  const code = document.getElementById(target.dataset['copy'] ?? '');
  if (!code) return;
  const prefix = document.getElementById(target.dataset['copyPrefix'] ?? '');
  const source = prefix
    ? `${prefix.textContent ?? ''}\n\n${code.textContent ?? ''}`
    : (code.textContent ?? '');
  const original = target.textContent;
  try {
    await navigator.clipboard.writeText(source);
    target.textContent = 'Copied';
  } catch {
    target.textContent = 'Select the code to copy';
    const selection = window.getSelection();
    const range = document.createRange();
    const fallback = document.getElementById('copy-fallback');
    if (fallback) {
      fallback.textContent = source;
      fallback.hidden = false;
      fallback.focus();
    }
    range.selectNodeContents(fallback ?? code);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  window.setTimeout(() => {
    target.textContent = original;
  }, 2000);
});

for (const root of document.querySelectorAll<HTMLElement>('[data-playground]')) {
  const form = root.querySelector<HTMLFormElement>('form')!;
  const output = root.querySelector<HTMLElement>('[data-output]')!;
  const status = root.querySelector<HTMLElement>('[data-status]')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
    'input, button',
  ))
    control.disabled = false;
  status.textContent = 'Runs locally. No input data leaves this browser.';
  let running = false;
  const runAndDisplay = async (inputs: Record<string, number>): Promise<Calculation> => {
    if (running) throw new Error('A calculation is already running. Wait for it to finish.');
    running = true;
    submit.disabled = true;
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      'input, button',
    ))
      control.disabled = true;
    status.textContent = 'Calculating…';
    try {
      const result = await calculate(root.dataset['playground']!, inputs);
      for (const input of form.querySelectorAll<HTMLInputElement>('input[name]'))
        input.value = String(inputs[input.name]);
      output.innerHTML = renderCalculation(result);
      output.removeAttribute('aria-label');
      document.getElementById('calculation-examples')!.innerHTML = renderExamples(result);
      status.textContent = 'Updated. Results and copied code use these inputs.';
      status.classList.remove('error');
      return result;
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : 'The calculation could not complete.';
      status.classList.add('error');
      output.setAttribute('aria-label', 'Previous successful result; current inputs were refused.');
      throw error;
    } finally {
      for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        'input, button',
      ))
        control.disabled = false;
      running = false;
    }
  };
  const run = async () => {
    if (!form.reportValidity()) return;
    const inputs = Object.fromEntries(
      Array.from(new FormData(form).entries(), ([name, value]) => [name, Number(value)]),
    );
    // The action already reports a useful visible error; event handlers must not leak rejections.
    try {
      await runAndDisplay(inputs);
    } catch {
      /* status contains the refusal */
    }
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run();
  });
  form.addEventListener('reset', () => {
    window.setTimeout(() => void run(), 0);
  });
  form.addEventListener('input', () => {
    status.textContent = 'Inputs changed. Run to update the result and example.';
  });
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  const context = (document as Document & { modelContext?: BrowserToolContext }).modelContext;
  if (context?.registerTool) {
    void loadPlayground(root.dataset['playground']!)
      .then((playground) =>
        registerCalculatorTool(context, playground, runAndDisplay, lifecycle.signal),
      )
      .catch(() => {
        // Optional browser integration cannot disable the ordinary form or calculation worker.
        root.dataset['browserTools'] = 'unavailable';
      });
  }
}

const searchForm = document.querySelector<HTMLFormElement>('[data-search-form]');
if (searchForm) {
  const input = searchForm.querySelector<HTMLInputElement>('input')!;
  const resultElement = document.querySelector<HTMLElement>('[data-search-results]')!;
  const status = document.querySelector<HTMLElement>('[data-search-status]')!;
  const base = document.documentElement.dataset['base'] ?? '';
  let indexRequest: Promise<SearchRecord[]> | undefined;
  const loadIndex = () => {
    // Share the download AND JSON parsing, cache success, allow retry after any load failure.
    indexRequest ??= fetch(`${base}/search-index.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Search index unavailable');
        const records: unknown = await response.json();
        if (
          !Array.isArray(records) ||
          records.some(
            (record: unknown) =>
              !record ||
              typeof record !== 'object' ||
              !['title', 'url', 'description', 'category', 'keywords'].every(
                (key) => typeof (record as Record<string, unknown>)[key] === 'string',
              ) ||
              ('kind' in record && typeof record.kind !== 'string'),
          )
        )
          throw new Error('Search index malformed');
        return records as SearchRecord[];
      })
      .catch((error: unknown) => {
        indexRequest = undefined;
        throw error;
      });
    return indexRequest;
  };
  let generation = 0;
  const performSearch = async () => {
    const current = ++generation;
    const query = input.value.trim();
    if (!query) {
      resultElement.replaceChildren();
      status.textContent = 'Search functions, types, tasks, or financial concepts.';
      return;
    }
    status.textContent = 'Searching…';
    try {
      const index = await loadIndex();
      if (current !== generation) return;
      const matches = search(index, query);
      resultElement.innerHTML = matches
        .map(
          (match) =>
            `<a class="search-result" href="${escapeHtml(match.url)}"><strong>${escapeHtml(match.title)}</strong><small>${escapeHtml(match.kind ? `${match.kind} · ${match.category}` : match.category)}</small><p>${escapeHtml(match.description)}</p></a>`,
        )
        .join('');
      status.textContent = matches.length
        ? `${matches.length} ${matches.length === 1 ? 'result' : 'results'} shown. Refine your search to narrow the list.`
        : 'No matches. Try a full function name, package, or a shorter finance term.';
    } catch {
      if (current !== generation) return;
      status.textContent =
        'Search could not load. The API reference and guides remain available from the navigation.';
    }
  };
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    window.clearTimeout(timer);
    void performSearch();
  });
  let timer: number | undefined;
  input.addEventListener('input', () => {
    // Invalidate an outstanding search immediately, not after the debounce expires.
    ++generation;
    window.clearTimeout(timer);
    if (!input.value.trim()) {
      void performSearch();
      return;
    }
    timer = window.setTimeout(() => void performSearch(), 120);
  });
  input.value = new URLSearchParams(location.search).get('q') ?? '';
  if (input.value) void performSearch();
}
