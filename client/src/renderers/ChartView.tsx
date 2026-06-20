import { useMemo } from "react";

type ChartType = "bar" | "line" | "pie";

type ChartDataPoint = {
  label: string;
  value: number;
  color?: string;
};

type ChartViewProps = {
  chartType: ChartType;
  data: ChartDataPoint[];
  title?: string;
  height?: number;
};

const defaultColors = ["#4968ff", "#5c63ec", "#8061e6", "#a85bdd", "#cd6bd6", "#df73ce", "#f08fc4", "#f7a8ba"];

export function ChartView({ chartType, data, title, height = 300 }: ChartViewProps) {
  if (!data.length) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-[#e8edf5] bg-white p-8" style={{ height }}>
        <span className="text-sm text-[#8b95a7]">暂无数据</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#e8edf5] bg-white p-4">
      {title && <h3 className="mb-3 text-sm font-semibold text-[#263445]">{title}</h3>}
      <div style={{ height }}>
        {chartType === "bar" && <BarChart data={data} height={height} />}
        {chartType === "line" && <LineChart data={data} height={height} />}
        {chartType === "pie" && <PieChart data={data} height={height} />}
      </div>
    </div>
  );
}

function BarChart({ data, height }: { data: ChartDataPoint[]; height: number }) {
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const barWidth = Math.min(60, Math.max(20, (height * 0.7) / data.length));
  const chartHeight = height - 40;
  const chartWidth = data.length * (barWidth + 12);

  return (
    <div className="overflow-x-auto">
      <svg width={Math.max(chartWidth, 200)} height={height} viewBox={`0 0 ${Math.max(chartWidth, 200)} ${height}`}>
        {data.map((d, i) => {
          const barH = (d.value / maxVal) * (chartHeight - 10);
          const x = 20 + i * (barWidth + 12);
          const y = chartHeight - barH;
          const color = d.color ?? defaultColors[i % defaultColors.length];
          return (
            <g key={i}>
              <rect x={x} y={y} width={barWidth} height={barH} fill={color} rx={3} opacity={0.85} />
              <text x={x + barWidth / 2} y={chartHeight + 14} textAnchor="middle" className="text-[10px]" fill="#7a8494">{d.label.length > 6 ? d.label.slice(0, 6) + "…" : d.label}</text>
              <text x={x + barWidth / 2} y={y - 4} textAnchor="middle" className="text-[10px]" fill="#526075">{d.value}</text>
            </g>
          );
        })}
        <line x1={10} y1={chartHeight} x2={Math.max(chartWidth, 200) - 10} y2={chartHeight} stroke="#e8edf5" strokeWidth={1} />
      </svg>
    </div>
  );
}

function LineChart({ data, height }: { data: ChartDataPoint[]; height: number }) {
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const chartHeight = height - 40;
  const chartWidth = Math.max(data.length * 60, 200);
  const stepX = (chartWidth - 40) / Math.max(data.length - 1, 1);

  const points = useMemo(() => {
    return data.map((d, i) => ({
      x: 20 + i * stepX,
      y: chartHeight - (d.value / maxVal) * (chartHeight - 10),
      ...d
    }));
  }, [data, chartHeight, maxVal, stepX]);

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <div className="overflow-x-auto">
      <svg width={chartWidth} height={height} viewBox={`0 0 ${chartWidth} ${height}`}>
        <line x1={10} y1={chartHeight} x2={chartWidth - 10} y2={chartHeight} stroke="#e8edf5" strokeWidth={1} />
        {points.map((p, i) => (
          <g key={i}>
            <text x={p.x} y={chartHeight + 14} textAnchor="middle" className="text-[10px]" fill="#7a8494">{p.label.length > 6 ? p.label.slice(0, 6) + "…" : p.label}</text>
            <text x={p.x} y={p.y - 6} textAnchor="middle" className="text-[10px]" fill="#526075">{p.value}</text>
          </g>
        ))}
        <path d={pathD} fill="none" stroke="#4968ff" strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={3} fill="#4968ff" />
        ))}
      </svg>
    </div>
  );
}

function PieChart({ data, height }: { data: ChartDataPoint[]; height: number }) {
  const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
  const cx = height / 2;
  const cy = height / 2;
  const r = Math.min(cx, cy) - 20;

  const slices = useMemo(() => {
    let angle = -90;
    return data.map((d, i) => {
      const sweep = (d.value / total) * 360;
      const startAngle = angle;
      const endAngle = angle + sweep;
      angle = endAngle;
      const startRad = (startAngle * Math.PI) / 180;
      const endRad = (endAngle * Math.PI) / 180;
      const largeArc = sweep > 180 ? 1 : 0;
      const x1 = cx + r * Math.cos(startRad);
      const y1 = cy + r * Math.sin(startRad);
      const x2 = cx + r * Math.cos(endRad);
      const y2 = cy + r * Math.sin(endRad);
      const path = sweep >= 360
        ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
        : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
      return { path, color: d.color ?? defaultColors[i % defaultColors.length], label: d.label, value: d.value, percent: Math.round((d.value / total) * 100) };
    });
  }, [data, total, cx, cy, r]);

  return (
    <div className="flex items-start gap-4">
      <svg width={height} height={height} viewBox={`0 0 ${height} ${height}`}>
        {slices.map((s, i) => (
          <path key={i} d={s.path} fill={s.color} stroke="white" strokeWidth={2} opacity={0.85} />
        ))}
      </svg>
      <div className="mt-4 space-y-1">
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="text-[#526075]">{s.label}</span>
            <span className="text-[#8b95a7]">{s.percent}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}