import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { sanitizeText } from '../shared/text-utils';

interface PlayerRow {
  player: string;
  incomingCrop: number;
  consumption: number;
  net: number;
  deliveries: number;
}

interface CropSwingPoint {
  time: number;
  value: number;
}

interface CropSwingChart {
  width: number;
  height: number;
  linePath: string;
  positiveFillPath: string;
  negativeFillPath: string;
  zeroY: number;
  nowX: number;
  peak: { x: number; y: number };
  trough: { x: number; y: number };
}

interface CropSwingResult {
  totalIncoming: number;
  ratePerSecond: number;
  peakValue: number;
  peakTimeSec: number;
  peakTimeLabel: string;
  troughValue: number;
  troughTimeSec: number;
  troughTimeLabel: string;
  swing: number;
  chart: CropSwingChart;
}

@Component({
  selector: 'app-diet-route-parser',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './diet-route-parser.component.html',
  styleUrls: ['./diet-route-parser.component.scss'],
})
export class DietRouteParserComponent {
  troopText = '';
  inputText = '';
  rows: PlayerRow[] = [];
  cropSwing: CropSwingResult | null = null;

  parse() {
    const incoming = cropIncomingByPlayerNextHour(this.inputText);
    const consumption = consumptionByPlayerPerHour(this.troopText);
    const now = new Date();
    const nowSecIntoHour = now.getMinutes() * 60 + now.getSeconds();
    this.cropSwing = computeCropSwing(
      incomingDeliveriesNextHour(this.inputText),
      nowSecIntoHour
    );

    const players = new Set<string>([
      ...incoming.keys(),
      ...consumption.keys(),
    ]);

    const out: PlayerRow[] = [];
    for (const p of players) {
      const inc = incoming.get(p) || { crop: 0, deliveries: 0 };
      const cons = consumption.get(p) || 0;
      out.push({
        player: p,
        incomingCrop: inc.crop,
        consumption: cons,
        net: inc.crop - cons,
        deliveries: inc.deliveries,
      });
    }

    out.sort((a, b) => b.net - a.net || a.player.localeCompare(b.player));

    const totalIncoming = out.reduce((s, r) => s + r.incomingCrop, 0);
    const totalCons = out.reduce((s, r) => s + r.consumption, 0);
    const totalDel = out.reduce((s, r) => s + r.deliveries, 0);

    if (out.length) {
      out.push({
        player: 'TOTAL',
        incomingCrop: totalIncoming,
        consumption: totalCons,
        net: totalIncoming - totalCons,
        deliveries: totalDel,
      });
    }

    this.rows = out;
  }
}

/* ---------- parser below ---------- */
function parseIntLoose(s: string): number {
  const digits = (s || '').replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

function parseDurationSeconds(line: string): number | null {
  // Accept 1–2 digits for hh/mm/ss because Travian sometimes uses "0:03:18"
  const m = line.match(/\bIn\s+(\d{1,2}):(\d{1,2}):(\d{1,2})\b/i);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  return h * 3600 + min * 60 + s;
}

function cropIncomingByPlayerNextHour(
  text: string
): Map<string, { crop: number; deliveries: number }> {
  const lines = sanitizeText(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const totals = new Map<string, { crop: number; deliveries: number }>();

  let currentPlayer: string | null = null;
  let nums: number[] = [];

  const flushIfValid = (durSec: number) => {
    const crop = nums.length ? nums[nums.length - 1] : 0;
    if (!currentPlayer || durSec > 3600 || crop <= 0) return;

    const prev = totals.get(currentPlayer) || { crop: 0, deliveries: 0 };
    totals.set(currentPlayer, {
      crop: prev.crop + crop,
      deliveries: prev.deliveries + 1,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of a shipment block
    const tm = line.match(/^Transport from\s+(.+?)\s*:\s*(.+)$/i);
    if (tm) {
      currentPlayer = tm[2].trim();
      nums = [];
      continue;
    }

    // Collect resource numbers while inside a block
    if (currentPlayer) {
      const durSec = parseDurationSeconds(line);
      if (durSec !== null) {
        // End of block: "In ..."
        flushIfValid(durSec);
        currentPlayer = null;
        nums = [];
        continue;
      }

      const n = parseIntLoose(line);
      if (n !== 0 && !(n === 1 && line.includes('×'))) nums.push(n);
    }
  }

  return totals;
}

function incomingDeliveriesNextHour(
  text: string
): { crop: number; arrivalSec: number }[] {
  const lines = sanitizeText(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const deliveries: { crop: number; arrivalSec: number }[] = [];

  let currentPlayer: string | null = null;
  let nums: number[] = [];

  const flushIfValid = (durSec: number) => {
    const crop = nums.length ? nums[nums.length - 1] : 0;
    if (!currentPlayer || durSec > 3600 || crop <= 0) return;
    deliveries.push({ crop, arrivalSec: durSec });
  };

  for (const line of lines) {
    const tm = line.match(/^Transport from\s+(.+?)\s*:\s*(.+)$/i);
    if (tm) {
      currentPlayer = tm[2].trim();
      nums = [];
      continue;
    }

    if (currentPlayer) {
      const durSec = parseDurationSeconds(line);
      if (durSec !== null) {
        flushIfValid(durSec);
        currentPlayer = null;
        nums = [];
        continue;
      }

      const n = parseIntLoose(line);
      if (n !== 0 && !(n === 1 && line.includes('×'))) nums.push(n);
    }
  }

  return deliveries;
}

// Simulates crop stock over the rolling 60 minutes starting now (so a
// delivery arriving 50 minutes from now is included even if that crosses
// into the next clock hour), assuming a constant consumption rate equal to
// the window's total incoming crop, while deliveries land as instantaneous
// lumps at their real clock-time ETA (nowSecIntoHour + their countdown).
// Times are kept as absolute seconds-from-top-of-current-hour (so they can
// exceed horizonSec once the window rolls into the next hour) — the chart
// wraps them back onto the :00–:60 dial.
function computeCropSwing(
  deliveries: { crop: number; arrivalSec: number }[],
  nowSecIntoHour: number,
  horizonSec = 3600
): CropSwingResult | null {
  if (!deliveries.length) return null;

  const withClockSec = deliveries.map((d) => ({
    crop: d.crop,
    clockSec: nowSecIntoHour + d.arrivalSec,
  }));

  const totalIncoming = withClockSec.reduce((s, d) => s + d.crop, 0);
  const ratePerSecond = totalIncoming / horizonSec;
  const sorted = [...withClockSec].sort((a, b) => a.clockSec - b.clockSec);
  const endSec = nowSecIntoHour + horizonSec;

  const points: CropSwingPoint[] = [{ time: nowSecIntoHour, value: 0 }];

  let stock = 0;
  let prevTime = nowSecIntoHour;
  let peakValue = 0;
  let peakTimeSec = nowSecIntoHour;
  let troughValue = 0;
  let troughTimeSec = nowSecIntoHour;

  const record = (time: number, value: number) => {
    points.push({ time, value });
    if (value > peakValue) {
      peakValue = value;
      peakTimeSec = time;
    }
    if (value < troughValue) {
      troughValue = value;
      troughTimeSec = time;
    }
  };

  for (const d of sorted) {
    stock -= ratePerSecond * (d.clockSec - prevTime);
    record(d.clockSec, stock);
    stock += d.crop;
    record(d.clockSec, stock);
    prevTime = d.clockSec;
  }

  stock -= ratePerSecond * (endSec - prevTime);
  record(endSec, stock);

  return {
    totalIncoming,
    ratePerSecond,
    peakValue,
    peakTimeSec,
    peakTimeLabel: formatClock(peakTimeSec),
    troughValue,
    troughTimeSec,
    troughTimeLabel: formatClock(troughTimeSec),
    swing: peakValue - troughValue,
    chart: buildSwingChart(
      points,
      horizonSec,
      { time: peakTimeSec, value: peakValue },
      { time: troughTimeSec, value: troughValue },
      nowSecIntoHour
    ),
  };
}

// Splits an absolute-time trajectory into one or two segments so that
// wherever the rolling window crosses the top of the clock hour, the second
// half is re-based to start at 0 again — letting it draw into the :00-:now
// stretch of the dial instead of running off the right edge.
function splitAtHourWrap(
  points: CropSwingPoint[],
  horizonSec: number
): CropSwingPoint[][] {
  const segments: CropSwingPoint[][] = [[]];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    segments[segments.length - 1].push(p);

    const next = points[i + 1];
    if (next && p.time <= horizonSec && next.time > horizonSec) {
      const ratio = (horizonSec - p.time) / (next.time - p.time);
      const boundaryValue = p.value + (next.value - p.value) * ratio;
      segments[segments.length - 1].push({ time: horizonSec, value: boundaryValue });
      segments.push([{ time: horizonSec, value: boundaryValue }]);
    }
  }

  return segments;
}

// Turns the stock trajectory into SVG geometry: a stroked line, a "holes"
// fill for the stretches where stock dips below zero, and a fill for the
// stretches where it's in surplus. Time is displayed on a fixed :00-:60
// dial, so a segment that rolls past :60 wraps around to draw at :00.
function buildSwingChart(
  points: CropSwingPoint[],
  horizonSec: number,
  peak: CropSwingPoint,
  trough: CropSwingPoint,
  nowSecIntoHour: number
): CropSwingChart {
  const width = 640;
  const height = 200;
  const pad = { top: 14, right: 14, bottom: 22, left: 14 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const values = points.map((p) => p.value);
  let maxV = Math.max(0, ...values);
  let minV = Math.min(0, ...values);
  if (maxV === minV) {
    maxV += 1;
    minV -= 1;
  }
  const span = maxV - minV;
  maxV += span * 0.1;
  minV -= span * 0.1;

  const xScale = (t: number) => pad.left + (t / horizonSec) * plotW;
  const yScale = (v: number) => pad.top + ((maxV - v) / (maxV - minV)) * plotH;
  const zeroY = yScale(0);
  // Segment 0 keeps absolute time as-is; any later segment (after a wrap)
  // is re-based so it starts drawing at display-time 0 again.
  const displayTime = (segmentIndex: number, t: number) =>
    segmentIndex === 0 ? t : t - horizonSec;

  const segments = splitAtHourWrap(points, horizonSec);

  const linePath = segments
    .map((segment, segmentIndex) =>
      segment
        .map(
          (p, i) =>
            `${i === 0 ? 'M' : 'L'} ${xScale(
              displayTime(segmentIndex, p.time)
            ).toFixed(1)} ${yScale(p.value).toFixed(1)}`
        )
        .join(' ')
    )
    .join(' ');

  const positiveParts: string[] = [];
  const negativeParts: string[] = [];

  const addQuad = (
    a: CropSwingPoint,
    b: CropSwingPoint,
    segmentIndex: number,
    list: string[]
  ) => {
    const x1 = xScale(displayTime(segmentIndex, a.time)).toFixed(1);
    const x2 = xScale(displayTime(segmentIndex, b.time)).toFixed(1);
    const y1 = yScale(a.value).toFixed(1);
    const y2 = yScale(b.value).toFixed(1);
    const zy = zeroY.toFixed(1);
    list.push(`M ${x1} ${zy} L ${x1} ${y1} L ${x2} ${y2} L ${x2} ${zy} Z`);
  };

  segments.forEach((segment, segmentIndex) => {
    for (let i = 0; i < segment.length - 1; i++) {
      const p1 = segment[i];
      const p2 = segment[i + 1];
      if (p1.time === p2.time) continue; // instantaneous delivery jump, no area under it

      if (p1.value >= 0 && p2.value >= 0) {
        addQuad(p1, p2, segmentIndex, positiveParts);
      } else if (p1.value <= 0 && p2.value <= 0) {
        addQuad(p1, p2, segmentIndex, negativeParts);
      } else {
        const crossTime =
          p1.time +
          ((0 - p1.value) / (p2.value - p1.value)) * (p2.time - p1.time);
        const crossPoint: CropSwingPoint = { time: crossTime, value: 0 };
        if (p1.value >= 0) {
          addQuad(p1, crossPoint, segmentIndex, positiveParts);
          addQuad(crossPoint, p2, segmentIndex, negativeParts);
        } else {
          addQuad(p1, crossPoint, segmentIndex, negativeParts);
          addQuad(crossPoint, p2, segmentIndex, positiveParts);
        }
      }
    }
  });

  const toDisplayTime = (t: number) => (t <= horizonSec ? t : t - horizonSec);

  return {
    width,
    height,
    linePath,
    positiveFillPath: positiveParts.join(' '),
    negativeFillPath: negativeParts.join(' '),
    zeroY,
    nowX: xScale(toDisplayTime(nowSecIntoHour)),
    peak: { x: xScale(toDisplayTime(peak.time)), y: yScale(peak.value) },
    trough: { x: xScale(toDisplayTime(trough.time)), y: yScale(trough.value) },
  };
}

function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function consumptionByPlayerPerHour(text: string): Map<string, number> {
  const lines = sanitizeText(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const totals = new Map<string, number>();

  const isHeader = (l: string): boolean => {
    if (!l.includes('\t')) return false;
    const right = l.substring(l.lastIndexOf('\t') + 1).trim();
    return right === 'Own troops' || right.endsWith("'s troops");
  };

  const playerFromHeader = (l: string): string | null => {
    const right = l.substring(l.lastIndexOf('\t') + 1).trim();
    if (right === 'Own troops') return 'Own';
    if (!right.endsWith("'s troops")) return null;
    const p = right.substring(0, right.length - "'s troops".length).trim();
    return p ? p : null;
  };

  for (let i = 0; i < lines.length; i++) {
    if (!isHeader(lines[i])) continue;

    const player = playerFromHeader(lines[i]);
    if (!player) continue;

    let cons = 0;
    for (let j = i + 1; j < lines.length; j++) {
      if (isHeader(lines[j])) break;
      if (lines[j] === 'Consumption' && j + 1 < lines.length) {
        cons = parseIntLoose(lines[j + 1]);
        break;
      }
    }

    if (cons > 0) {
      totals.set(player, (totals.get(player) || 0) + cons);
    }
  }

  return totals;
}
