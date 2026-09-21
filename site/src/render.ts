import type { Calculation, Chart, Playground } from './types.js';

export const escapeHtml = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

export function formatNumber(value: number | string | null): string {
  if (value === null) return 'Not defined';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value))
    return value === Infinity
      ? 'Unbounded'
      : value === -Infinity
        ? 'Unbounded loss'
        : 'Not defined';
  if (value !== 0 && Math.abs(value) < 0.0001)
    return new Intl.NumberFormat('en-US', {
      notation: 'scientific',
      maximumFractionDigits: 4,
    }).format(value);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value);
}

const chartNumber = (value: number): string =>
  Math.abs(value) >= 10000
    ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(
        value,
      )
    : formatNumber(value);

export function renderChart(chart: Chart): string {
  const points = chart.series.flatMap((series) => series.points);
  const finite = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (finite.length === 0) return '<p>No finite chart values are available for this input.</p>';
  const minimumX = Math.min(...finite.map((point) => point.x));
  const maximumX = Math.max(...finite.map((point) => point.x));
  const minimumY = Math.min(0, ...finite.map((point) => point.y));
  const maximumY = Math.max(0, ...finite.map((point) => point.y));
  const x = (value: number) => 76 + ((value - minimumX) / (maximumX - minimumX || 1)) * 600;
  const y = (value: number) => 266 - ((value - minimumY) / (maximumY - minimumY || 1)) * 230;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = minimumY + ((maximumY - minimumY) * index) / 4;
    return `<line x1="76" x2="676" y1="${y(value)}" y2="${y(value)}" class="chart-grid"/><text x="66" y="${y(value) + 5}" text-anchor="end">${escapeHtml(chartNumber(value))}</text>`;
  }).join('');
  const lines = chart.series
    .map(
      (series, index) =>
        `<polyline class="chart-line series-${index % 3}" points="${series.points
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
          .map((point) => `${x(point.x)},${y(point.y)}`)
          .join(' ')}"/>`,
    )
    .join('');
  return `<figure class="chart"><figcaption>${escapeHtml(chart.title)}</figcaption><svg viewBox="0 0 720 330" role="img" aria-label="${escapeHtml(`${chart.title}. ${chart.xLabel}; ${chart.yLabel}. Exact values in the data table below.`)}">${grid}<line class="chart-zero" x1="76" x2="676" y1="${y(0)}" y2="${y(0)}"/>${lines}<text x="76" y="291">${escapeHtml(formatNumber(minimumX))}</text><text x="676" y="291" text-anchor="end">${escapeHtml(formatNumber(maximumX))}</text><text x="376" y="321" text-anchor="middle">${escapeHtml(chart.xLabel)}</text></svg><p class="chart-legend">${chart.series.map((series, index) => `<span class="legend-${index % 3}">${escapeHtml(series.name)}</span>`).join('')}<span>${escapeHtml(chart.yLabel)}</span></p><details><summary>Exact chart data</summary><div class="table-scroll"><table><thead><tr><th>Series</th><th>${escapeHtml(chart.xLabel)}</th><th>${escapeHtml(chart.yLabel)}</th></tr></thead><tbody>${chart.series.flatMap((series) => series.points.map((point) => `<tr><td>${escapeHtml(series.name)}</td><td>${escapeHtml(point.x)}</td><td>${escapeHtml(point.y)}</td></tr>`)).join('')}</tbody></table></div></details></figure>`;
}

export function renderCalculation(calculation: Calculation): string {
  return `<div class="metrics">${calculation.metrics.map((metric) => `<div><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(formatNumber(metric.value))}</strong><small>${escapeHtml(metric.unit ?? '')}</small></div>`).join('')}</div>${renderChart(calculation.chart)}${(calculation.additionalCharts ?? []).map(renderChart).join('')}<div class="result-details"><details open><summary>Assumptions & conventions</summary><pre>${escapeHtml(JSON.stringify(calculation.assumptions, null, 2))}</pre></details><details open><summary>Diagnostics & warnings</summary><pre>${escapeHtml(JSON.stringify(calculation.diagnostics, null, 2))}</pre></details><details><summary>Full result · JSON</summary><pre>${escapeHtml(JSON.stringify(calculation.result, null, 2))}</pre></details></div>`;
}

export function renderExamples(calculation: Calculation): string {
  const { example } = calculation;
  const setup = example.setup;
  return `<div class="panel-heading"><h2>Use it in your project</h2><button class="button quiet" data-copy="first-call-code"${setup ? ' data-copy-prefix="sample-setup"' : ''}>${setup ? 'Copy setup + call' : 'Copy first call'}</button></div>
<p>${escapeHtml(example.description)}</p>
${setup ? `<h3>Sample inputs</h3><p>${escapeHtml(setup.description)}</p><pre>${escapeHtml(setup.preview)}</pre><details><summary>Complete sample setup · included when copying</summary><pre><code id="sample-setup">${escapeHtml(setup.code)}</code></pre></details>` : ''}
<pre><code id="first-call-code">${escapeHtml(example.code)}</code></pre>
<h3>Output of this example</h3><pre>${escapeHtml(JSON.stringify(example.result, null, 2))}</pre>
<details><summary>Reproduce this entire playground</summary><p>This complete example reproduces every chart point and the full playground result. Sample generation and chart mapping are example setup, not required conversions of library outputs.</p><button class="button quiet" data-copy="example-code">Copy full playground</button><pre><code id="example-code">${escapeHtml(calculation.code)}</code></pre></details>
<p class="muted">Both examples use the last successfully calculated inputs. The first call may show fewer scenarios or selected report fields, as labeled above. Displayed metrics are rounded; copied calculations retain exact values.</p>
<pre id="copy-fallback" tabindex="0" hidden></pre>`;
}

export function renderPlayground(playground: Playground): string {
  const result = playground.run(
    Object.fromEntries(playground.controls.map((control) => [control.name, control.value])),
  );
  return `<section class="playground" data-playground="${escapeHtml(playground.id)}"><div class="playground-input"><div class="panel-heading"><h2>Try it</h2><span class="sample-badge">Sample data</span></div><p>${escapeHtml(playground.introduction)}</p><form data-calculator>${playground.controls.map((control) => `<label>${escapeHtml(control.label)}<small>${escapeHtml(control.unit)}</small><input name="${escapeHtml(control.name)}" type="number" required min="${control.min}" max="${control.max}" step="any" value="${control.value}" inputmode="decimal" disabled/></label>`).join('')}<div class="form-actions"><button class="button primary" type="submit" disabled>Run calculation <span aria-hidden="true">↗</span></button><button class="button quiet" type="reset" disabled>Reset</button></div><p class="status" data-status role="status" aria-live="polite">Loading the local calculator. The verified sample is displayed below.</p><noscript><p>Changing inputs requires JavaScript. The sample result and TypeScript remain readable; select the code to run it in your project.</p></noscript></form></div><div class="playground-output" data-output>${renderCalculation(result)}</div></section><section class="code-section" id="calculation-examples">${renderExamples(result)}</section>`;
}
