import { SAMPLE_REGISTRY } from '../data/samples';
import type { Control, DataValue } from '../types';

/**
 * Controls cross the server→browser boundary without their sample datasets: samples are
 * deterministic and regenerated in the browser from `SAMPLE_REGISTRY`, so a page never ships the
 * same bars twice. A placeholder keeps the shape; `restoreSamples` puts the data back.
 */
const placeholder = (format: DataValue['format'], id: string): DataValue =>
  format === 'ohlcv'
    ? { format, label: `sample:${id}`, origin: 'sample', bars: [] }
    : { format, label: `sample:${id}`, origin: 'sample', meaning: 'prices', values: [] };

const idOf = (value: DataValue) =>
  value.origin === 'sample' && value.label.startsWith('sample:') ? value.label.slice(7) : null;

export function stripSamples(controls: readonly Control[]): Control[] {
  return controls.map((control) => {
    if (control.kind !== 'data') return control;
    const current = control.samples.find(
      (sample) => JSON.stringify(sample.value) === JSON.stringify(control.value),
    );
    if (!current)
      throw new Error(`${control.name}: the default dataset must be one of its samples.`);
    return {
      ...control,
      value: placeholder(control.format, current.id),
      samples: control.samples.map((sample) => ({
        ...sample,
        value: placeholder(control.format, sample.id),
      })),
    };
  });
}

export function restoreSamples(controls: readonly Control[]): Control[] {
  return controls.map((control) => {
    if (control.kind !== 'data') return control;
    const restore = (value: DataValue): DataValue => {
      const id = idOf(value);
      if (!id) return value;
      const sample = SAMPLE_REGISTRY.get(`${control.format}:${id}`);
      if (!sample) throw new Error(`Unknown sample ${id}.`);
      return sample.value;
    };
    return {
      ...control,
      value: restore(control.value),
      samples: control.samples.map((sample) => ({ ...sample, value: restore(sample.value) })),
    };
  });
}
