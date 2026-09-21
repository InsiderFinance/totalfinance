export interface Control {
  name: string;
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
}

export interface Chart {
  title: string;
  xLabel: string;
  yLabel: string;
  series: { name: string; points: { x: number; y: number }[] }[];
}

export interface Calculation {
  metrics: { label: string; value: number | string | null; unit?: string }[];
  chart: Chart;
  additionalCharts?: Chart[];
  assumptions: unknown;
  diagnostics: unknown;
  result: unknown;
  /** First useful call, without full chart setup. Both examples are installed-artifact tested. */
  example: {
    description: string;
    code: string;
    result: unknown;
    setup?: { code: string; preview: string; description: string };
  };
  /** Complete playground reproduction, including every chart point. */
  code: string;
}

export interface Playground {
  id: string;
  title: string;
  introduction: string;
  controls: Control[];
  run(input: Record<string, number>): Calculation;
}
