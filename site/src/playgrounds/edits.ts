import { isNumberControl, type Playground, type PlaygroundInput } from '../types';
import { defaultInput } from './inputs';

/**
 * A deterministic "reader changed something" input: the first control moves to its next valid
 * value. Release evidence executes copied examples at both the default and this edited input.
 */
export function editedInput(playground: Pick<Playground, 'id' | 'controls'>): PlaygroundInput {
  const input = defaultInput(playground);
  const control = playground.controls[0];
  if (!control) throw new Error(`${playground.id}: a playground needs at least one control.`);
  if (isNumberControl(control)) {
    if (!(control.step > 0))
      throw new Error(`${playground.id}: ${control.name} needs a positive step.`);
    const up = control.value + control.step;
    const down = control.value - control.step;
    if (up <= control.max) input[control.name] = up;
    else if (down >= control.min) input[control.name] = down;
    else throw new Error(`${playground.id}: ${control.name} has no edited value inside its range.`);
    return input;
  }
  switch (control.kind) {
    case 'select': {
      const next = control.options.find((option) => option.value !== control.value);
      if (!next) throw new Error(`${playground.id}: ${control.name} needs a second option.`);
      input[control.name] = next.value;
      return input;
    }
    case 'table': {
      const current = JSON.stringify(control.value);
      const preset = control.presets?.find(
        (candidate) => JSON.stringify(candidate.rows) !== current,
      );
      if (!preset)
        throw new Error(
          `${playground.id}: ${control.name} needs a second preset for the edited case.`,
        );
      input[control.name] = JSON.parse(JSON.stringify(preset.rows)) as typeof preset.rows;
      return input;
    }
    case 'data': {
      const current = JSON.stringify(control.value);
      const sample = control.samples.find(
        (candidate) => JSON.stringify(candidate.value) !== current,
      );
      if (!sample)
        throw new Error(
          `${playground.id}: ${control.name} needs a second sample for the edited case.`,
        );
      input[control.name] = JSON.parse(JSON.stringify(sample.value)) as typeof sample.value;
      return input;
    }
  }
}
