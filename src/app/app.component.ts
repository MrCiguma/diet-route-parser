import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';

interface PlayerRow {
  player: string;
  incomingCrop: number;
  consumption: number;
  net: number;
  deliveries: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent {
  troopText = '';
  inputText = '';
  rows: PlayerRow[] = [];

  parse() {
    const incoming = cropIncomingByPlayerNextHour(this.inputText);
    const consumption = consumptionByPlayerPerHour(this.troopText);

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
function sanitizeText(raw: string): string {
  return (raw || '')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/\r\n/g, '\n');
}

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
