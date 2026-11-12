/**
 * The playground contract. A playground is a framework-free module that turns typed inputs into
 * a `Calculation` by calling public TotalFinance APIs. One control schema drives the form, boundary
 * validation, shareable URL state, the browser agent-tool schema and the copied TypeScript.
 */

interface ControlBase {
  name: string;
  label: string;
  /** One sentence shown under the label. */
  hint?: string;
  /** Only shown while another select control has this value (it is still validated and sent). */
  when?: { name: string; value: string };
}

/** How a number is displayed. Inputs always stay in the library's own unit (e.g. decimals). */
export type NumberDisplay =
  | 'number'
  | 'integer'
  | 'currency'
  | 'decimal-percent'
  | 'basis-points'
  | 'years'
  | 'days';

export interface NumberControl extends ControlBase {
  kind?: 'number';
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display?: NumberDisplay;
  /** Show a slider next to the field (default true). */
  slider?: boolean;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectControl extends ControlBase {
  kind: 'select';
  value: string;
  options: SelectOption[];
}

export type TableCell = number | string;
export type TableRow = Record<string, TableCell>;

export interface TableColumn {
  name: string;
  label: string;
  unit?: string;
  type: 'number' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: SelectOption[];
}

export interface TablePreset {
  id: string;
  label: string;
  rows: TableRow[];
}

/** A small editable table, e.g. option legs or volatility quotes. */
export interface TableControl extends ControlBase {
  kind: 'table';
  columns: TableColumn[];
  value: TableRow[];
  minRows: number;
  maxRows: number;
  newRow: TableRow;
  presets?: TablePreset[];
}

export interface OhlcvBar {
  /** ISO calendar date, YYYY-MM-DD. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type DataValue =
  | {
      format: 'ohlcv';
      /** Human description of where the data came from. */
      label: string;
      origin: 'sample' | 'reader';
      bars: OhlcvBar[];
    }
  | {
      format: 'series';
      label: string;
      origin: 'sample' | 'reader';
      /** What the numbers are: closing prices or periodic simple returns (decimals). */
      meaning: 'prices' | 'returns';
      values: number[];
      dates?: string[];
    };

export interface DataSample {
  id: string;
  label: string;
  description: string;
  value: DataValue;
}

/** The reader's own data: pasted or uploaded CSV/TSV, parsed and validated in the browser. */
export interface DataControl extends ControlBase {
  kind: 'data';
  format: DataValue['format'];
  /** For series data, which meanings the playground accepts. */
  meanings?: ('prices' | 'returns')[];
  value: DataValue;
  samples: DataSample[];
  minRows: number;
  maxRows: number;
}

export type Control = NumberControl | SelectControl | TableControl | DataControl;
export type InputValue = number | string | TableRow[] | DataValue;
export type PlaygroundInput = Record<string, InputValue>;

export const isNumberControl = (control: Control): control is NumberControl =>
  control.kind === undefined || control.kind === 'number';

/** Value formats understood by the chart and result renderers. */
export type ValueFormat =
  | 'number'
  | 'integer'
  | 'currency'
  | 'decimal-percent'
  | 'percent'
  | 'basis-points'
  | 'date'
  | 'compact';

export type Tone = 'neutral' | 'brand' | 'profit' | 'loss';

export interface Point {
  x: number;
  y: number;
}

export interface LineSeries {
  name: string;
  points: Point[];
  /** `pnl` fills above zero as profit and below as loss; `points` draws unconnected markers. */
  style?: 'line' | 'area' | 'pnl' | 'dashed' | 'muted' | 'points';
}

/** A labelled reference line: vertical when `x` is set, horizontal when `y` is set. */
export interface Marker {
  x?: number;
  y?: number;
  label: string;
  tone?: Tone;
}

interface ChartBase {
  title: string;
  /** One sentence the chart makes visible; also the accessible description. */
  caption?: string;
  /** `half` charts sit two per row as small multiples on wide screens. */
  size?: 'full' | 'half';
}

export interface LineChart extends ChartBase {
  kind?: 'line';
  xLabel: string;
  yLabel: string;
  xFormat?: ValueFormat;
  yFormat?: ValueFormat;
  series: LineSeries[];
  markers?: Marker[];
  /** Force zero into the y-domain (default: only when values straddle or touch zero). */
  includeZero?: boolean;
}

export interface CandleBar extends OhlcvBar {
  /** Position on the shared x-axis (bar index). */
  x: number;
}

export interface CandlestickChart extends ChartBase {
  kind: 'candles';
  yLabel: string;
  bars: CandleBar[];
  overlays?: LineSeries[];
  bands?: { name: string; upper: Point[]; lower: Point[] }[];
  signals?: { x: number; side: 'buy' | 'sell'; label: string }[];
  /** Additional panes below the price pane, sharing its x-axis and crosshair. */
  panes?: {
    title: string;
    yLabel: string;
    yFormat?: ValueFormat;
    series: (Omit<LineSeries, 'style'> & { style?: LineSeries['style'] | 'histogram' })[];
    guides?: number[];
    domain?: [number, number];
  }[];
}

export interface HeatmapChart extends ChartBase {
  kind: 'heatmap';
  xLabel: string;
  yLabel: string;
  valueLabel: string;
  xFormat?: ValueFormat;
  yFormat?: ValueFormat;
  valueFormat?: ValueFormat;
  x: number[];
  y: number[];
  /** values[row][column], rows follow `y` and columns follow `x`. */
  values: number[][];
  scale: 'sequential' | 'diverging';
  highlight?: { x: number; y: number };
}

/** A distribution of raw observations; the renderer bins them for display only. */
export interface HistogramChart extends ChartBase {
  kind: 'histogram';
  xLabel: string;
  yLabel: string;
  xFormat?: ValueFormat;
  values: number[];
  /** Target bin count (default: Freedman–Diaconis, clamped to 12–60). */
  binCount?: number;
  markers?: Marker[];
  /** Observations at or below this value are drawn as the loss tail. */
  tailBelow?: number;
}

export interface BarChart extends ChartBase {
  kind: 'bars';
  xLabel: string;
  yLabel: string;
  yFormat?: ValueFormat;
  bars: { label: string; value: number; tone?: Tone }[];
}

export interface WaterfallChart extends ChartBase {
  kind: 'waterfall';
  yLabel: string;
  yFormat?: ValueFormat;
  steps: { label: string; value: number; kind: 'start' | 'delta' | 'total' }[];
}

export type Chart =
  | LineChart
  | CandlestickChart
  | HeatmapChart
  | HistogramChart
  | WaterfallChart
  | BarChart;

export interface Metric {
  label: string;
  value: number | string | null;
  unit?: string;
  format?: ValueFormat;
  tone?: Tone;
}

export interface Calculation {
  metrics: Metric[];
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
  run(input: PlaygroundInput): Calculation;
}
