import { loadPlayground, validateInputs } from './playgrounds/load.js';

const worker = globalThis as unknown as {
  onmessage:
    | ((event: { data: { requestId: number; playgroundId: string; input: unknown } }) => void)
    | null;
  postMessage(message: unknown): void;
};
worker.onmessage = async (event) => {
  const { requestId, playgroundId, input } = event.data;
  try {
    const playground = await loadPlayground(playgroundId);
    const result = playground.run(validateInputs(playground, input));
    worker.postMessage({ requestId, result });
  } catch (error) {
    worker.postMessage({
      requestId,
      error: error instanceof Error ? error.message : 'The calculation failed.',
    });
  }
};
