import {
  MERCHANT_SPEED_FIELDS_PER_HOUR,
  Tribe,
  merchantCapacity,
} from './travian-data';

export interface RouteVillageInput {
  name: string;
  x: number;
  y: number;
  merchantsTotal: number;
  tradeOfficeLevel: number;
  cropSurplusPerHour: number;
}

export interface RouteLeg {
  fromVillage: string;
  toVillage: string;
  cropPerHour: number;
  merchantsPerFiring: number;
  intervalHours: number;
  departureMinute: number;
  arrivalMinute: number;
}

export interface RoutePlan {
  legs: RouteLeg[];
  warnings: string[];
}

interface Coords {
  x: number;
  y: number;
}

export const ALLOWED_INTERVALS_HOURS = [1, 2, 3, 4, 6, 8];

const BUFFER_MINUTES = 5;
const CYCLE_HOURS = 24;
const MAX_MERCHANT_SHARE = 0.25;

function distanceFields(a: Coords, b: Coords): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// Travian computes travel time per minute, ceiling each one-way leg.
// 3m30s one-way → 4 min → 8 min round trip (not 7).
function oneWayMinutes(distance: number, speed: number): number {
  return Math.ceil((distance / speed) * 60);
}

function roundTripHours(distance: number, speed: number): number {
  return (oneWayMinutes(distance, speed) * 2) / 60;
}

function modMinutes(minutes: number, cycleMinutes: number): number {
  return ((Math.round(minutes) % cycleMinutes) + cycleMinutes) % cycleMinutes;
}

// Float noise guard: capacity * alliance-bonus multiplier can produce
// e.g. 4.000000000000001, which Math.ceil rounds to 5.
function ceilMerchants(value: number): number {
  return Math.ceil(value - 1e-6);
}

function bestInterval(roundTrip: number, merchantsTotal: number, maxSpreadHours: number) {
  let best: { K: number; cohortsInFlight: number; merchantsPerFiring: number; throughputUnits: number } | null = null;
  for (const K of ALLOWED_INTERVALS_HOURS) {
    if (K > maxSpreadHours) continue;
    const cohortsInFlight = Math.ceil(roundTrip / K);
    const merchantsPerFiring = Math.floor(merchantsTotal / cohortsInFlight);
    const throughputUnits = merchantsPerFiring / K;
    if (!best || throughputUnits > best.throughputUnits || (throughputUnits === best.throughputUnits && K < best.K)) {
      best = { K, cohortsInFlight, merchantsPerFiring, throughputUnits };
    }
  }
  return best ?? { K: 1, cohortsInFlight: Math.ceil(roundTrip), merchantsPerFiring: 0, throughputUnits: 0 };
}

function cheapestInterval(roundTrip: number, maxSpreadHours: number) {
  let best: { K: number; cohortsInFlight: number; merchantsPerUnit: number } | null = null;
  for (const K of ALLOWED_INTERVALS_HOURS) {
    if (K > maxSpreadHours) continue;
    const cohortsInFlight = Math.ceil(roundTrip / K);
    const merchantsPerUnit = cohortsInFlight * K;
    // Same merchant-time cost: prefer the interval that ties up fewer merchant
    // bodies at once (larger K), so distant relays stay under the fleet-share cap.
    if (
      !best ||
      merchantsPerUnit < best.merchantsPerUnit ||
      (merchantsPerUnit === best.merchantsPerUnit && cohortsInFlight < best.cohortsInFlight)
    ) {
      best = { K, cohortsInFlight, merchantsPerUnit };
    }
  }
  return best ?? { K: 1, cohortsInFlight: Math.ceil(roundTrip), merchantsPerUnit: Math.ceil(roundTrip) };
}

function maxThroughput(village: RouteVillageInput, target: Coords, tribe: Tribe, allianceBonusPercent: number, maxSpreadHours: number) {
  const distance = distanceFields(village, target);
  const speed = MERCHANT_SPEED_FIELDS_PER_HOUR[tribe];
  const oneWayHours = oneWayMinutes(distance, speed) / 60;
  const capacityPerMerchant = merchantCapacity(tribe, village.tradeOfficeLevel, allianceBonusPercent);
  const { K, cohortsInFlight, merchantsPerFiring } = bestInterval(roundTripHours(distance, speed), village.merchantsTotal, maxSpreadHours);
  const cropPerHour = (merchantsPerFiring * capacityPerMerchant) / K;
  return { oneWayHours, capacityPerMerchant, K, cohortsInFlight, merchantsPerFiring, cropPerHour };
}

interface GCandidate {
  village: RouteVillageInput;
  spareCapacity: number;
  roundTripHours: number;
  oneWayHours: number;
  cheapK: number;
  merchantsPerUnit: number;
  cohortsAtCheapestK: number;
}

// Greedy merchant-time water-fill. Returns allocations plus remaining budget
// so callers can chain a second pass (e.g. a hub pass after a direct pass).
function greedyAllocate(params: {
  cropBudget: number;       // use Infinity to find merchant-capacity ceiling
  merchantBudget: number;
  capacityPerMerchant: number;
  maxSpreadHours: number;
  candidates: GCandidate[]; // pre-filtered and pre-sorted by merchantsPerUnit
}): {
  allocations: Map<RouteVillageInput, { cropPerHour: number; oneWayHours: number; K: number }>;
  remainingSurplus: number;
  remainingMerchantTime: number;
} {
  const allocations = new Map<RouteVillageInput, { cropPerHour: number; oneWayHours: number; K: number }>();
  let remainingSurplus = params.cropBudget;
  let remainingMerchantTime = params.merchantBudget;

  for (const c of params.candidates) {
    if (remainingSurplus <= 0 || remainingMerchantTime <= 0) break;
    let bestAllocated = 0, bestMerchantTimeUsed = 0, bestK = c.cheapK;
    for (const K of ALLOWED_INTERVALS_HOURS) {
      if (K > params.maxSpreadHours) continue;
      const cohorts = Math.ceil(c.roundTripHours / K);
      const costPer = cohorts > 1 ? cohorts : c.roundTripHours / K;
      const maxMPF = Math.floor(remainingMerchantTime / costPer);
      if (maxMPF < 1) continue;
      const capByBudget = (maxMPF * params.capacityPerMerchant) / K;
      const cand = Math.min(remainingSurplus, c.spareCapacity, capByBudget);
      if (cand <= 0) continue;
      const mpf = ceilMerchants((cand * K) / params.capacityPerMerchant);
      const cost = mpf * costPer;
      // Prefer K that allocates more crop; break ties by choosing the cheaper K.
      if (cand > bestAllocated || (cand === bestAllocated && cost < bestMerchantTimeUsed)) {
        bestAllocated = cand;
        bestK = K;
        bestMerchantTimeUsed = cost;
      }
    }
    if (bestAllocated <= 0) continue;
    allocations.set(c.village, { cropPerHour: bestAllocated, oneWayHours: c.oneWayHours, K: bestK });
    remainingSurplus -= bestAllocated;
    remainingMerchantTime -= bestMerchantTimeUsed;
  }
  return { allocations, remainingSurplus, remainingMerchantTime };
}

export function computeRoutePlan(
  dietCoords: Coords,
  tribe: Tribe,
  allianceBonusPercent: number,
  villages: RouteVillageInput[],
  sourceVillageIndex: number | null,
  maxSpreadHours: number,
  arrivalOffsetMinutes: number
): RoutePlan {
  const warnings: string[] = [];
  const legs: RouteLeg[] = [];
  const speed = MERCHANT_SPEED_FIELDS_PER_HOUR[tribe];

  const source = sourceVillageIndex !== null ? villages[sourceVillageIndex] ?? null : null;
  const nonSource = villages.filter(v => v !== source);

  const relayStats = nonSource.map(village => ({
    village,
    ...maxThroughput(village, dietCoords, tribe, allianceBonusPercent, maxSpreadHours),
  }));

  // fromSource: village (relay or auto-detected hub) → what source sends to it
  const fromSource = new Map<RouteVillageInput, { cropPerHour: number; oneWayHours: number; K: number }>();

  // fromHub: relay → what a hub sends to it
  const fromHub = new Map<RouteVillageInput, { hub: RouteVillageInput; cropPerHour: number; oneWayHours: number; K: number }>();

  // hubMaxAllocations: for each auto-detected hub, its scaled relay plan
  const hubMaxAllocations = new Map<RouteVillageInput, Map<RouteVillageInput, { cropPerHour: number; oneWayHours: number; K: number }>>();

  if (source && source.cropSurplusPerHour > 0) {
    const sourceCapacity = merchantCapacity(tribe, source.tradeOfficeLevel, allianceBonusPercent);

    const buildCandidate = (village: RouteVillageInput, spareCapacity: number): GCandidate => {
      const dist = distanceFields(source, village);
      const rt = roundTripHours(dist, speed);
      const owH = oneWayMinutes(dist, speed) / 60;
      const { K: cheapK, cohortsInFlight, merchantsPerUnit } = cheapestInterval(rt, maxSpreadHours);
      return { village, spareCapacity, roundTripHours: rt, oneWayHours: owH, cheapK, merchantsPerUnit, cohortsAtCheapestK: cohortsInFlight };
    };

    // ── Phase 1: source → direct relay allocation ──────────────────────────
    const directCandidates = relayStats.map(stat => {
      const spare = Math.max(0, stat.cropPerHour - stat.village.cropSurplusPerHour);
      return buildCandidate(stat.village, spare);
    });

    for (const c of directCandidates) {
      if (c.cohortsAtCheapestK > source.merchantsTotal) {
        warnings.push(`${c.village.name} is too far from ${source.name} for a relay route even with up to ${maxSpreadHours}h spread — ignored.`);
      } else if (c.cohortsAtCheapestK > source.merchantsTotal * MAX_MERCHANT_SHARE) {
        warnings.push(`${c.village.name} would keep at least ${c.cohortsAtCheapestK} of ${source.name}'s ${source.merchantsTotal} merchants walking at all times — more than 25% of the fleet — skipped.`);
      }
    }

    const directEligible = directCandidates
      .filter(c => c.cohortsAtCheapestK <= source.merchantsTotal * MAX_MERCHANT_SHARE && c.spareCapacity > 0)
      .sort((a, b) => a.merchantsPerUnit - b.merchantsPerUnit || a.roundTripHours - b.roundTripHours);

    const { allocations: phase1, remainingSurplus: leftover, remainingMerchantTime: leftMT } = greedyAllocate({
      cropBudget: source.cropSurplusPerHour,
      merchantBudget: source.merchantsTotal,
      capacityPerMerchant: sourceCapacity,
      maxSpreadHours,
      candidates: directEligible,
    });

    for (const [v, a] of phase1) fromSource.set(v, a);

    // ── Phase 2: auto-hub detection ────────────────────────────────────────
    // If source still has surplus and merchant-time left, look for villages
    // that could act as intermediate hubs — close to source (cheap to feed)
    // and able to reach relays that source couldn't fill directly.
    if (leftover > 0.5 && leftMT > 0) {
      // Relay spare capacity remaining after Phase 1 direct allocations.
      const spareAfterPhase1 = new Map<RouteVillageInput, number>();
      for (const stat of relayStats) {
        const original = Math.max(0, stat.cropPerHour - stat.village.cropSurplusPerHour);
        const used = phase1.get(stat.village)?.cropPerHour ?? 0;
        spareAfterPhase1.set(stat.village, Math.max(0, original - used));
      }

      interface HubOption {
        village: RouteVillageInput;
        maxAllocs: Map<RouteVillageInput, { cropPerHour: number; oneWayHours: number; K: number }>;
        maxForwardCapacity: number;
        spareForSource: number;
        sourceCandidate: GCandidate;
      }

      const hubOptions: HubOption[] = [];

      for (const village of nonSource) {
        if (phase1.has(village)) continue; // already a direct relay recipient
        if (village.merchantsTotal === 0) continue;

        const hubCapacity = merchantCapacity(tribe, village.tradeOfficeLevel, allianceBonusPercent);

        // Build this village's candidates for hub→relay routing (exclude itself)
        const hubCandidates: GCandidate[] = relayStats
          .map(stat => {
            if (stat.village === village) return null; // hub can't route to itself
            const spare = spareAfterPhase1.get(stat.village) ?? 0;
            if (spare <= 0) return null;
            const dist = distanceFields(village, stat.village);
            const rt = roundTripHours(dist, speed);
            const owH = oneWayMinutes(dist, speed) / 60;
            const { K: cheapK, cohortsInFlight, merchantsPerUnit } = cheapestInterval(rt, maxSpreadHours);
            if (cohortsInFlight > village.merchantsTotal * MAX_MERCHANT_SHARE) return null;
            return { village: stat.village, spareCapacity: spare, roundTripHours: rt, oneWayHours: owH, cheapK, merchantsPerUnit, cohortsAtCheapestK: cohortsInFlight };
          })
          .filter((c): c is GCandidate => c !== null)
          .sort((a, b) => a.merchantsPerUnit - b.merchantsPerUnit || a.roundTripHours - b.roundTripHours);

        if (hubCandidates.length === 0) continue;

        const { allocations: maxAllocs } = greedyAllocate({
          cropBudget: Infinity,
          merchantBudget: village.merchantsTotal,
          capacityPerMerchant: hubCapacity,
          maxSpreadHours,
          candidates: hubCandidates,
        });

        const maxForwardCapacity = [...maxAllocs.values()].reduce((s, a) => s + a.cropPerHour, 0);
        const spareForSource = Math.max(0, maxForwardCapacity - village.cropSurplusPerHour);
        if (spareForSource <= 0.5) continue;

        // Can source actually reach this hub affordably?
        const sourceCandidate = buildCandidate(village, spareForSource);
        if (sourceCandidate.cohortsAtCheapestK > source.merchantsTotal * MAX_MERCHANT_SHARE) continue;

        hubOptions.push({ village, maxAllocs, maxForwardCapacity, spareForSource, sourceCandidate });
      }

      if (hubOptions.length > 0) {
        const hubEligible = hubOptions
          .map(h => h.sourceCandidate)
          .sort((a, b) => a.merchantsPerUnit - b.merchantsPerUnit);

        const { allocations: phase2 } = greedyAllocate({
          cropBudget: leftover,
          merchantBudget: leftMT,
          capacityPerMerchant: sourceCapacity,
          maxSpreadHours,
          candidates: hubEligible,
        });

        for (const [hub, alloc] of phase2) {
          fromSource.set(hub, alloc);
          const opt = hubOptions.find(h => h.village === hub)!;
          hubMaxAllocations.set(hub, opt.maxAllocs);

          const totalHubCrop = hub.cropSurplusPerHour + alloc.cropPerHour;
          const scale = Math.min(1, totalHubCrop / opt.maxForwardCapacity);

          for (const [relay, maxA] of opt.maxAllocs) {
            const scaled = maxA.cropPerHour * scale;
            if (scaled <= 0) continue;
            const existing = fromHub.get(relay);
            if (!existing || scaled > existing.cropPerHour) {
              fromHub.set(relay, { hub, cropPerHour: scaled, oneWayHours: maxA.oneWayHours, K: maxA.K });
            }
          }
        }

        const totalUsed = [...fromSource.values()].reduce((s, a) => s + a.cropPerHour, 0);
        const finalLeftover = source.cropSurplusPerHour - totalUsed;
        if (finalLeftover > 0.5) {
          warnings.push(`${source.name} has ${Math.round(finalLeftover)} crop/hour that couldn't be allocated — relay capacity or merchant limits reached.`);
        }
      } else {
        warnings.push(`${source.name} has ${Math.round(leftover)} crop/hour that couldn't be allocated — no hub village could bridge the remaining relays.`);
      }
    } else if (leftover > 0.5) {
      warnings.push(`${source.name} has ${Math.round(leftover)} crop/hour that couldn't be allocated — relay capacity or merchant limits reached.`);
    }
  }

  // ── Scheduling ────────────────────────────────────────────────────────────
  const dietCandidates = relayStats
    .filter(s => s.village.cropSurplusPerHour > 0 || fromSource.has(s.village) || fromHub.has(s.village));

  // A village can never send Diet more than its own merchant fleet sustains over
  // the distance (stat.cropPerHour). Cap each village's Diet outflow at that and
  // route only what fits — the rest stays in the village.
  const deliverableToDiet = new Map<RouteVillageInput, number>();
  const cannotRoute: string[] = [];
  for (const stat of dietCandidates) {
    const raw =
      stat.village.cropSurplusPerHour +
      (fromSource.get(stat.village)?.cropPerHour ?? 0) +
      (fromHub.get(stat.village)?.cropPerHour ?? 0);
    const capped = Math.min(raw, stat.cropPerHour);
    if (capped <= 1e-6) {
      cannotRoute.push(stat.village.name);
      continue;
    }
    deliverableToDiet.set(stat.village, capped);
    if (raw > stat.cropPerHour + 1e-6) {
      warnings.push(
        `${stat.village.name} can only ship ${Math.round(stat.cropPerHour)} of ${Math.round(raw)} crop/hour to Diet — capped by its merchants and distance; the rest stays in the village.`
      );
    }
  }
  if (cannotRoute.length) {
    warnings.push(
      `These villages have crop surplus but can't route any to Diet (no merchants or too far): ${cannotRoute.join(', ')}.`
    );
  }

  const dietBound = dietCandidates
    .filter(s => deliverableToDiet.has(s.village))
    .sort((a, b) => b.K - a.K);

  const hourLoad = new Array(CYCLE_HOURS).fill(0);
  const phaseHourByVillage = new Map<RouteVillageInput, number>();

  for (const stat of dietBound) {
    const outflow = deliverableToDiet.get(stat.village)!;
    const cropPerFiring = outflow * stat.K;
    const firingsPerCycle = CYCLE_HOURS / stat.K;
    let bestPhase = 0, bestScore = Infinity;
    for (let phase = 0; phase < stat.K; phase++) {
      let score = 0;
      for (let f = 0; f < firingsPerCycle; f++) score += hourLoad[(phase + f * stat.K) % CYCLE_HOURS];
      if (score < bestScore) { bestScore = score; bestPhase = phase; }
    }
    for (let f = 0; f < firingsPerCycle; f++) hourLoad[(bestPhase + f * stat.K) % CYCLE_HOURS] += cropPerFiring;
    phaseHourByVillage.set(stat.village, bestPhase);
  }

  if (dietBound.length > 0) {
    const emptyHours = hourLoad.map((l, h) => l === 0 ? h : null).filter((h): h is number => h !== null);
    if (emptyHours.length > 0) {
      warnings.push(`Diet gets nothing during hour${emptyHours.length > 1 ? 's' : ''} ${emptyHours.join(', ')} of the cycle — increase max spread, add more relays, or raise crop surplus.`);
    } else {
      const max = Math.max(...hourLoad), min = Math.min(...hourLoad);
      if (max > min * 1.5) warnings.push(`Deliveries to Diet are uneven — busiest hour gets ${Math.round(max)} crop, quietest gets ${Math.round(min)}.`);
    }
  }

  const byHour = new Map<number, typeof relayStats[number][]>();
  for (const stat of dietBound) {
    const hour = phaseHourByVillage.get(stat.village)!;
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour)!.push(stat);
  }

  const sourceCapPerMerchant = source
    ? merchantCapacity(tribe, source.tradeOfficeLevel, allianceBonusPercent)
    : 0;

  // ── Leg building ──────────────────────────────────────────────────────────
  const relayDepartureMinute = new Map<RouteVillageInput, number>();

  const pushLegToDiet = (stat: typeof relayStats[number], outflow: number, departure: number, arrival: number) => {
    if (outflow <= 0) return;
    const mpf = Math.min(
      stat.merchantsPerFiring,
      ceilMerchants((outflow * stat.K) / stat.capacityPerMerchant)
    );
    legs.push({ fromVillage: stat.village.name, toVillage: 'Diet', cropPerHour: outflow, merchantsPerFiring: mpf, intervalHours: stat.K, departureMinute: departure, arrivalMinute: arrival });
  };

  for (const stat of dietBound) {
    const hour = phaseHourByVillage.get(stat.village)!;
    const group = byHour.get(hour)!;
    const indexInGroup = group.indexOf(stat);
    const minuteInHour = Math.round((indexInGroup * 60) / group.length);
    const arrival = hour * 60 + ((minuteInHour + arrivalOffsetMinutes) % 60);
    const relayDep = modMinutes(arrival - stat.oneWayHours * 60, stat.K * 60);
    relayDepartureMinute.set(stat.village, relayDep);

    const srcIn = fromSource.get(stat.village);
    const outflow = deliverableToDiet.get(stat.village)!;
    pushLegToDiet(stat, outflow, relayDep, arrival);

    // Source → relay direct leg
    if (srcIn && source) {
      const latestSafe = relayDep - BUFFER_MINUTES;
      legs.push({
        fromVillage: source.name,
        toVillage: stat.village.name,
        cropPerHour: srcIn.cropPerHour,
        merchantsPerFiring: ceilMerchants((srcIn.cropPerHour * srcIn.K) / sourceCapPerMerchant),
        intervalHours: srcIn.K,
        departureMinute: modMinutes(latestSafe - srcIn.oneWayHours * 60, srcIn.K * 60),
        arrivalMinute: modMinutes(latestSafe, srcIn.K * 60),
      });
    }
  }

  // Hub → relay legs
  for (const [hub, maxAllocs] of hubMaxAllocations) {
    const srcToHub = fromSource.get(hub);
    if (!srcToHub) continue;
    const totalHubCrop = hub.cropSurplusPerHour + srcToHub.cropPerHour;
    const maxFwd = [...maxAllocs.values()].reduce((s, a) => s + a.cropPerHour, 0);
    if (maxFwd <= 0) continue;
    const scale = Math.min(1, totalHubCrop / maxFwd);
    const hubCap = merchantCapacity(tribe, hub.tradeOfficeLevel, allianceBonusPercent);

    for (const [relay, maxA] of maxAllocs) {
      const scaled = maxA.cropPerHour * scale;
      if (scaled <= 0) continue;
      const relayDep = relayDepartureMinute.get(relay);
      if (relayDep === undefined) continue;
      const latestSafe = relayDep - BUFFER_MINUTES;
      legs.push({
        fromVillage: hub.name,
        toVillage: relay.name,
        cropPerHour: scaled,
        merchantsPerFiring: ceilMerchants((scaled * maxA.K) / hubCap),
        intervalHours: maxA.K,
        departureMinute: modMinutes(latestSafe - maxA.oneWayHours * 60, maxA.K * 60),
        arrivalMinute: modMinutes(latestSafe, maxA.K * 60),
      });
    }
  }

  // Source → hub legs
  if (source) {
    for (const [hub, alloc] of fromSource) {
      if (!hubMaxAllocations.has(hub)) continue; // direct relays handled above
      const maxAllocs = hubMaxAllocations.get(hub)!;
      const hubRelayDeps = [...maxAllocs.keys()].map(r => relayDepartureMinute.get(r) ?? Infinity);
      const earliestDep = Math.min(...hubRelayDeps);
      const latestSafe = isFinite(earliestDep) ? earliestDep - BUFFER_MINUTES : 0;
      legs.push({
        fromVillage: source.name,
        toVillage: hub.name,
        cropPerHour: alloc.cropPerHour,
        merchantsPerFiring: ceilMerchants((alloc.cropPerHour * alloc.K) / sourceCapPerMerchant),
        intervalHours: alloc.K,
        departureMinute: modMinutes(latestSafe - alloc.oneWayHours * 60, alloc.K * 60),
        arrivalMinute: modMinutes(latestSafe, alloc.K * 60),
      });
    }
  }

  if (legs.length === 0 && warnings.length === 0) {
    warnings.push('No village has a crop surplus set — nothing to route. Set "Crop surplus/hour" for at least one village.');
  }

  return { legs, warnings };
}
