import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { sanitizeText } from '../shared/text-utils';
import { Tribe } from '../shared/travian-data';
import {
  ALLOWED_INTERVALS_HOURS,
  computeRoutePlan,
  RoutePlan,
} from '../shared/route-algorithm';

type MerchantBonus = 0 | 30 | 60 | 90 | 120 | 150;

interface ParsedVillage {
  name: string;
  x: number | null;
  y: number | null;
  merchantsTotal: number;
  tradeOfficeLevel: number;
  cropSurplusPerHour: number;
}

@Component({
  selector: 'app-route-creator',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './route-creator.component.html',
  styleUrls: ['./route-creator.component.scss'],
})
export class RouteCreatorComponent implements OnInit {
  readonly tribes: { value: Tribe; label: string }[] = [
    { value: 'roman', label: 'Roman' },
    { value: 'teuton', label: 'Teuton' },
    { value: 'gaul', label: 'Gaul' },
    { value: 'egyptian', label: 'Egyptian' },
    { value: 'hun', label: 'Hun' },
  ];

  readonly merchantBonuses: MerchantBonus[] = [0, 30, 60, 90, 120, 150];
  readonly spreadOptions = ALLOWED_INTERVALS_HOURS;

  dietX: number | null = null;
  dietY: number | null = null;
  tribe: Tribe | '' = '';
  merchantBonus: MerchantBonus | null = null;
  maxSpreadHours = 1;

  villageInfoText = '';
  parsedVillages: ParsedVillage[] = [];
  defaultTradeOfficeLevel = 0;
  sourceVillageIndex: number | null = null;
  arrivalOffsetMinutes = Math.floor(Math.random() * 60);
  routePlan: RoutePlan | null = null;

  shareUrl = '';
  linkCopied = false;

  // Source village can't be selected until villages are parsed — coordinates
  // from the URL are held here and applied once parseVillageInfo() runs.
  private pendingSourceCoords: { x: number; y: number } | null = null;

  constructor(private route: ActivatedRoute, private router: Router) {}

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    this.dietX = numberOrNull(params.get('dietX'));
    this.dietY = numberOrNull(params.get('dietY'));

    const tribeParam = params.get('tribe');
    this.tribe = this.tribes.some((t) => t.value === tribeParam)
      ? (tribeParam as Tribe)
      : '';

    const merchantBonusParam = numberOrNull(params.get('merchantBonus'));
    this.merchantBonus = this.merchantBonuses.includes(
      merchantBonusParam as MerchantBonus
    )
      ? (merchantBonusParam as MerchantBonus)
      : null;

    const defaultToParam = numberOrNull(params.get('defaultTradeOfficeLevel'));
    if (defaultToParam !== null) this.defaultTradeOfficeLevel = defaultToParam;

    const maxSpreadParam = numberOrNull(params.get('maxSpreadHours'));
    if (maxSpreadParam !== null && ALLOWED_INTERVALS_HOURS.includes(maxSpreadParam)) {
      this.maxSpreadHours = maxSpreadParam;
    }

    const offsetParam = numberOrNull(params.get('arrivalOffset'));
    if (offsetParam !== null && offsetParam >= 0 && offsetParam <= 59) {
      this.arrivalOffsetMinutes = offsetParam;
    }

    const sourceX = numberOrNull(params.get('sourceX'));
    const sourceY = numberOrNull(params.get('sourceY'));
    if (sourceX !== null && sourceY !== null) {
      this.pendingSourceCoords = { x: sourceX, y: sourceY };
    }

    const villagesParam = params.get('villages');
    if (villagesParam) {
      this.parsedVillages = decodeVillages(villagesParam);
      this.sourceVillageIndex = this.pendingSourceCoords
        ? this.findVillageIndexByCoords(this.pendingSourceCoords)
        : null;
    }

    this.updateShareUrl();
  }

  onParamsChange(): void {
    const source =
      this.sourceVillageIndex !== null
        ? this.parsedVillages[this.sourceVillageIndex]
        : null;

    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        dietX: this.dietX,
        dietY: this.dietY,
        tribe: this.tribe || null,
        merchantBonus: this.merchantBonus,
        defaultTradeOfficeLevel: this.defaultTradeOfficeLevel || null,
        maxSpreadHours: this.maxSpreadHours !== 1 ? this.maxSpreadHours : null,
        arrivalOffset: this.arrivalOffsetMinutes,
        sourceX: source?.x ?? null,
        sourceY: source?.y ?? null,
        villages: this.parsedVillages.length
          ? encodeVillages(this.parsedVillages)
          : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    this.updateShareUrl();
  }

  onSourceVillageChange(index: number): void {
    this.sourceVillageIndex = index;
    this.onParamsChange();
  }

  async copyShareLink(): Promise<void> {
    this.updateShareUrl();
    await navigator.clipboard.writeText(this.shareUrl);
    this.linkCopied = true;
    setTimeout(() => (this.linkCopied = false), 1500);
  }

  generateRoutes(): void {
    if (!this.tribe || this.dietX === null || this.dietY === null) {
      this.routePlan = {
        legs: [],
        warnings: ['Set diet village coordinates and player tribe first.'],
      };
      return;
    }

    // Villages missing coordinates are dropped, which can shift indices —
    // so the source is re-located by identity within the filtered array
    // rather than reusing its index from the unfiltered parsedVillages.
    const sourceVillage =
      this.sourceVillageIndex !== null
        ? this.parsedVillages[this.sourceVillageIndex]
        : null;

    const validVillages = this.parsedVillages.filter(
      (v): v is ParsedVillage & { x: number; y: number } =>
        v.x !== null && v.y !== null
    );
    const sourceIndex = sourceVillage
      ? validVillages.findIndex((v) => v === sourceVillage)
      : -1;

    const villages = validVillages.map((v) => ({
      name: v.name,
      x: v.x,
      y: v.y,
      merchantsTotal: v.merchantsTotal,
      tradeOfficeLevel: v.tradeOfficeLevel,
      cropSurplusPerHour: v.cropSurplusPerHour,
    }));

    this.routePlan = computeRoutePlan(
      { x: this.dietX, y: this.dietY },
      this.tribe,
      this.merchantBonus ?? 0,
      villages,
      sourceIndex >= 0 ? sourceIndex : null,
      this.maxSpreadHours,
      this.arrivalOffsetMinutes
    );
  }

  get totalCropPerHour(): number {
    if (!this.routePlan) return 0;
    return this.routePlan.legs
      .filter((l) => l.toVillage === 'Diet')
      .reduce((sum, l) => sum + l.cropPerHour, 0);
  }

  get sortedLegs() {
    if (!this.routePlan) return [];
    // Source→relay legs (anything not headed to Diet) sort first, then
    // everything sorts by which village it's from.
    return [...this.routePlan.legs].sort((a, b) => {
      const aIsFromSource = a.toVillage !== 'Diet';
      const bIsFromSource = b.toVillage !== 'Diet';
      if (aIsFromSource !== bIsFromSource) return aIsFromSource ? -1 : 1;
      return a.fromVillage.localeCompare(b.fromVillage);
    });
  }

  formatMinute(totalMinutes: number): string {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}`;
  }

  parseVillageInfo(): void {
    const sanitized = sanitizeText(this.villageInfoText);
    const lines = sanitized
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const villages: { name: string; merchantsTotal: number }[] = [];
    for (const line of lines) {
      const cells = line
        .split(/\t+/)
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length < 6) continue;

      const name = cells[0];
      if (name === 'Sum') continue;

      const merchantsMatch = cells[cells.length - 1].match(/^(\d+)\/(\d+)$/);
      if (!merchantsMatch) continue;

      villages.push({ name, merchantsTotal: Number(merchantsMatch[2]) });
    }

    // Coordinates live in a separate section ("Currently building") further
    // down the page, in the same village order as the resource table above —
    // matched positionally rather than by name, since duplicate village
    // names (e.g. "New village") make name-based matching unreliable.
    const coordMatches = [...sanitized.matchAll(/\((-?\d+)\|(-?\d+)\)/g)];

    this.parsedVillages = villages.map((v, i) => ({
      name: v.name,
      x: coordMatches[i] ? Number(coordMatches[i][1]) : null,
      y: coordMatches[i] ? Number(coordMatches[i][2]) : null,
      merchantsTotal: v.merchantsTotal,
      tradeOfficeLevel: this.defaultTradeOfficeLevel,
      cropSurplusPerHour: 0,
    }));
    this.routePlan = null;

    this.sourceVillageIndex = this.pendingSourceCoords
      ? this.findVillageIndexByCoords(this.pendingSourceCoords)
      : null;

    this.onParamsChange();
  }

  onDefaultTradeOfficeLevelChange(): void {
    for (const v of this.parsedVillages) {
      if (v.tradeOfficeLevel === 0) {
        v.tradeOfficeLevel = this.defaultTradeOfficeLevel;
      }
    }
    this.onParamsChange();
  }

  private findVillageIndexByCoords(coords: { x: number; y: number }): number | null {
    const index = this.parsedVillages.findIndex(
      (v) => v.x === coords.x && v.y === coords.y
    );
    return index >= 0 ? index : null;
  }

  private updateShareUrl(): void {
    const search = new URLSearchParams(this.buildQueryParams()).toString();
    this.shareUrl = `${window.location.origin}${window.location.pathname}${
      search ? '?' + search : ''
    }`;
  }

  private buildQueryParams(): Record<string, string> {
    const params: Record<string, string> = {};
    if (this.dietX !== null) params['dietX'] = String(this.dietX);
    if (this.dietY !== null) params['dietY'] = String(this.dietY);
    if (this.tribe) params['tribe'] = this.tribe;
    if (this.merchantBonus !== null)
      params['merchantBonus'] = String(this.merchantBonus);
    if (this.defaultTradeOfficeLevel)
      params['defaultTradeOfficeLevel'] = String(this.defaultTradeOfficeLevel);
    if (this.maxSpreadHours !== 1)
      params['maxSpreadHours'] = String(this.maxSpreadHours);
    params['arrivalOffset'] = String(this.arrivalOffsetMinutes);

    const source =
      this.sourceVillageIndex !== null
        ? this.parsedVillages[this.sourceVillageIndex]
        : null;
    if (source && source.x !== null && source.y !== null) {
      params['sourceX'] = String(source.x);
      params['sourceY'] = String(source.y);
    }
    if (this.parsedVillages.length)
      params['villages'] = encodeVillages(this.parsedVillages);
    return params;
  }
}

// name,x,y,merchantsTotal,tradeOfficeLevel,cropSurplusPerHour per village,
// villages joined with ";". Name is percent-encoded since it's the only
// free-text field and could otherwise collide with the "," / ";" delimiters.
function encodeVillages(villages: ParsedVillage[]): string {
  return villages
    .map((v) =>
      [
        encodeURIComponent(v.name),
        v.x ?? '',
        v.y ?? '',
        v.merchantsTotal,
        v.tradeOfficeLevel,
        v.cropSurplusPerHour,
      ].join(',')
    )
    .join(';');
}

function decodeVillages(raw: string): ParsedVillage[] {
  return raw
    .split(';')
    .filter(Boolean)
    .map((entry) => {
      const [name, x, y, merchantsTotal, tradeOfficeLevel, cropSurplusPerHour] =
        entry.split(',');
      return {
        name: decodeURIComponent(name ?? ''),
        x: numberOrNull(x),
        y: numberOrNull(y),
        merchantsTotal: Number(merchantsTotal) || 0,
        tradeOfficeLevel: Number(tradeOfficeLevel) || 0,
        cropSurplusPerHour: Number(cropSurplusPerHour) || 0,
      };
    });
}

function numberOrNull(value: string | null): number | null {
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
