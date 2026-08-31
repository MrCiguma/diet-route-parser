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
type VillageRole = 'relay' | 'source';

interface ParsedVillage {
  name: string;
  x: number | null;
  y: number | null;
  merchantsTotal: number;
  tradeOfficeLevel: number;
  usesDefaultTO: boolean;
  cropSurplusPerHour: number;
  role: VillageRole;
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
  arrivalOffsetMinutes = Math.floor(Math.random() * 60);

  villageInfoText = '';
  parsedVillages: ParsedVillage[] = [];
  defaultTradeOfficeLevel = 0;
  routePlan: RoutePlan | null = null;

  shareUrl = '';
  linkCopied = false;

  // Backward-compat: source coords from URL params before villages are loaded.
  private pendingSourceCoords: { x: number; y: number } | null = null;

  constructor(private route: ActivatedRoute, private router: Router) {}

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    this.dietX = numberOrNull(params.get('dietX'));
    this.dietY = numberOrNull(params.get('dietY'));

    const tribeParam = params.get('tribe');
    this.tribe = this.tribes.some((t) => t.value === tribeParam) ? (tribeParam as Tribe) : '';

    const merchantBonusParam = numberOrNull(params.get('merchantBonus'));
    this.merchantBonus = this.merchantBonuses.includes(merchantBonusParam as MerchantBonus)
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

    // Backward compat: sourceX/sourceY before roles were encoded in village data
    const sourceX = numberOrNull(params.get('sourceX'));
    const sourceY = numberOrNull(params.get('sourceY'));
    if (sourceX !== null && sourceY !== null) {
      this.pendingSourceCoords = { x: sourceX, y: sourceY };
    }

    const villagesParam = params.get('villages');
    if (villagesParam) {
      this.parsedVillages = decodeVillages(villagesParam);
      // Apply backward-compat source coords if no village has role='source' yet
      if (this.pendingSourceCoords && !this.parsedVillages.some(v => v.role === 'source')) {
        const idx = this.parsedVillages.findIndex(
          v => v.x === this.pendingSourceCoords!.x && v.y === this.pendingSourceCoords!.y
        );
        if (idx >= 0) this.parsedVillages[idx].role = 'source';
      }
    }

    this.updateShareUrl();
  }

  get sourceVillageIndex(): number | null {
    const idx = this.parsedVillages.findIndex(v => v.role === 'source');
    return idx >= 0 ? idx : null;
  }

  adjustLevel(v: ParsedVillage, delta: number): void {
    v.tradeOfficeLevel = Math.max(0, Math.min(20, v.tradeOfficeLevel + delta));
    v.usesDefaultTO = false;
    this.onParamsChange();
  }

  onVillageTOChange(v: ParsedVillage): void {
    v.usesDefaultTO = false;
    this.onParamsChange();
  }

  adjustSurplus(v: ParsedVillage, delta: number): void {
    v.cropSurplusPerHour = Math.max(0, v.cropSurplusPerHour + delta);
    this.onParamsChange();
  }

  adjustOffset(delta: number): void {
    this.arrivalOffsetMinutes = Math.max(0, Math.min(59, this.arrivalOffsetMinutes + delta));
    this.onParamsChange();
  }

  adjustDefaultTO(delta: number): void {
    this.defaultTradeOfficeLevel = Math.max(0, Math.min(20, this.defaultTradeOfficeLevel + delta));
    this.onDefaultTradeOfficeLevelChange();
  }

  onVillageRoleChange(index: number): void {
    if (this.parsedVillages[index].role === 'source') {
      this.parsedVillages.forEach((v, i) => {
        if (i !== index && v.role === 'source') v.role = 'relay';
      });
    }
    this.onParamsChange();
  }

  onParamsChange(): void {
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
        villages: this.parsedVillages.length ? encodeVillages(this.parsedVillages) : null,
        // Remove legacy params
        sourceX: null,
        sourceY: null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    this.updateShareUrl();
  }

  async copyShareLink(): Promise<void> {
    this.updateShareUrl();
    await navigator.clipboard.writeText(this.shareUrl);
    this.linkCopied = true;
    setTimeout(() => (this.linkCopied = false), 1500);
  }

  generateRoutes(): void {
    if (!this.tribe || this.dietX === null || this.dietY === null) {
      this.routePlan = { legs: [], warnings: ['Set diet village coordinates and player tribe first.'] };
      return;
    }

    const validVillages = this.parsedVillages.filter(
      (v): v is ParsedVillage & { x: number; y: number } => v.x !== null && v.y !== null
    );

    const sourceIndex = validVillages.findIndex(v => v.role === 'source');

    const villages = validVillages.map(v => ({
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
    const lines = sanitized.split('\n').map((l) => l.trim()).filter(Boolean);

    const villages: { name: string; merchantsTotal: number }[] = [];
    for (const line of lines) {
      const cells = line.split(/\t+/).map((c) => c.trim()).filter(Boolean);
      if (cells.length < 6) continue;
      const name = cells[0];
      if (name === 'Sum') continue;
      const merchantsMatch = cells[cells.length - 1].match(/^(\d+)\/(\d+)$/);
      if (!merchantsMatch) continue;
      villages.push({ name, merchantsTotal: Number(merchantsMatch[2]) });
    }

    // Crop production from the resources/production overview: rows of the form
    // "<name> <wood> <clay> <iron> <crop>" (comma-grouped numbers, crop last).
    const cropByName = new Map<string, number>();
    for (const line of lines) {
      const cells = line.split(/\t+/).map((c) => c.trim()).filter(Boolean);
      if (cells.length < 5) continue;
      const name = cells[0];
      if (name === 'Village' || name.startsWith('Sum')) continue;
      const last4 = cells.slice(-4);
      if (!last4.every((n) => /^-?[\d,]+$/.test(n))) continue;
      cropByName.set(name, Number(last4[3].replace(/,/g, '')));
    }
    for (const name of cropByName.keys()) {
      if (!villages.some((v) => v.name === name)) villages.push({ name, merchantsTotal: 0 });
    }

    const coordMatches = [...sanitized.matchAll(/\((-?\d+)\|(-?\d+)\)/g)];
    // Positional fallback is only trustworthy when the paste holds exactly one
    // coord per village (no extra coords from news feeds, group lists, etc.).
    const positionalOk = coordMatches.length === villages.length;

    // Prefer matching coords to the village's own [NN] tag (handles pastes where a
    // trailing "Village groups" block lists coords in a different order/count).
    const coordByTag = new Map<string, { x: number; y: number }>();
    for (const m of sanitized.matchAll(/\[(\d+)\][^\[\n]*(?:\n\s*)?\(\s*(-?\d+)\s*\|\s*(-?\d+)\s*\)/g)) {
      if (!coordByTag.has(m[1])) coordByTag.set(m[1], { x: Number(m[2]), y: Number(m[3]) });
    }

    // Match coords to the village name where it sits at the start of a line, with
    // the coords on the same or the next line (the "Village groups" block layout).
    const coordByName = (name: string): { x: number; y: number } | null => {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = sanitized.match(
        new RegExp('(?:^|\\n)\\s*' + esc + '[^(\\n]*\\n?\\s*\\(\\s*(-?\\d+)\\s*\\|\\s*(-?\\d+)\\s*\\)')
      );
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    };

    this.parsedVillages = villages.map((v, i) => {
      const tag = v.name.match(/\[(\d+)\]/)?.[1];
      const matched = (tag ? coordByTag.get(tag) : undefined) ?? coordByName(v.name);
      const fallback = positionalOk ? coordMatches[i] : undefined;
      return {
      name: v.name,
      x: matched ? matched.x : fallback ? Number(fallback[1]) : null,
      y: matched ? matched.y : fallback ? Number(fallback[2]) : null,
      merchantsTotal: v.merchantsTotal,
      tradeOfficeLevel: this.defaultTradeOfficeLevel,
      usesDefaultTO: true,
      cropSurplusPerHour: cropByName.get(v.name) ?? 0,
      role: 'relay' as VillageRole,
      };
    });
    this.routePlan = null;

    // Apply pending source coords (backward compat)
    if (this.pendingSourceCoords) {
      const idx = this.parsedVillages.findIndex(
        v => v.x === this.pendingSourceCoords!.x && v.y === this.pendingSourceCoords!.y
      );
      if (idx >= 0) this.parsedVillages[idx].role = 'source';
    }

    this.onParamsChange();
  }

  onDefaultTradeOfficeLevelChange(): void {
    for (const v of this.parsedVillages) {
      if (v.usesDefaultTO) v.tradeOfficeLevel = this.defaultTradeOfficeLevel;
    }
    this.onParamsChange();
  }

  private updateShareUrl(): void {
    const search = new URLSearchParams(this.buildQueryParams()).toString();
    this.shareUrl = `${window.location.origin}${window.location.pathname}${search ? '?' + search : ''}`;
  }

  private buildQueryParams(): Record<string, string> {
    const params: Record<string, string> = {};
    if (this.dietX !== null) params['dietX'] = String(this.dietX);
    if (this.dietY !== null) params['dietY'] = String(this.dietY);
    if (this.tribe) params['tribe'] = this.tribe;
    if (this.merchantBonus !== null) params['merchantBonus'] = String(this.merchantBonus);
    if (this.defaultTradeOfficeLevel) params['defaultTradeOfficeLevel'] = String(this.defaultTradeOfficeLevel);
    if (this.maxSpreadHours !== 1) params['maxSpreadHours'] = String(this.maxSpreadHours);
    params['arrivalOffset'] = String(this.arrivalOffsetMinutes);
    if (this.parsedVillages.length) params['villages'] = encodeVillages(this.parsedVillages);
    return params;
  }
}

// name,x,y,merchantsTotal,tradeOfficeLevel,cropSurplusPerHour,role per village
// role: r=relay (default), s=source  (legacy 'h' hub code decoded as relay)
function encodeVillages(villages: ParsedVillage[]): string {
  return villages
    .map(v => [
      encodeURIComponent(v.name),
      v.x ?? '',
      v.y ?? '',
      v.merchantsTotal,
      v.tradeOfficeLevel,
      v.cropSurplusPerHour,
      v.role === 'source' ? 's' : 'r',
    ].join(','))
    .join(';');
}

function decodeVillages(raw: string): ParsedVillage[] {
  return raw.split(';').filter(Boolean).map(entry => {
    const [name, x, y, merchantsTotal, tradeOfficeLevel, cropSurplusPerHour, roleCode] = entry.split(',');
    const role: VillageRole = roleCode === 's' ? 'source' : 'relay';
    return {
      name: decodeURIComponent(name ?? ''),
      x: numberOrNull(x),
      y: numberOrNull(y),
      merchantsTotal: Number(merchantsTotal) || 0,
      tradeOfficeLevel: Number(tradeOfficeLevel) || 0,
      usesDefaultTO: false,
      cropSurplusPerHour: Number(cropSurplusPerHour) || 0,
      role,
    };
  });
}

function numberOrNull(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
