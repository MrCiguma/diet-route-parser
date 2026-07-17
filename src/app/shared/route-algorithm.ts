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
  departureMinute: number; // minutes from cycle start, within [0, intervalHours*60)
  arrivalMinute: number; // minutes from cycle start; can exceed intervalHours*60
}

export interface RoutePlan {
  legs: RouteLeg[];
  warnings: string[];
}

interface Coords {
  x: number;
  y: number;
}

// The route-firing intervals Travian actually offers.
export const ALLOWED_INTERVALS_HOURS = [1, 2, 3, 4, 6, 8];

const BUFFER_MINUTES = 5;
const CYCLE_HOURS = 24;

function distanceFields(a: Coords, b: Coords): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function roundTripHours(distance: number, speed: number): number {
  return (2 * distance) / speed;
}

function modMinutes(minutes: number, cycleMinutes: number): number {
  return ((Math.round(minutes) % cycleMinutes) + cycleMinutes) % cycleMinutes;
}

// Merchant counts are derived from crop amounts that have already passed
// through several multiply/divide steps (capacityPerMerchant itself carries
// float noise from the alliance-bonus multiplier), so a value that should
// land exactly on a whole number can come out as e.g. 4.000000000000001.
// Ceiling that without a tolerance rounds up to 5 and quietly wastes a
// merchant, so every merchant-count ceil() in this file goes through here.
function ceilMerchants(value: number): number {
  return Math.ceil(value - 1e-6);
}

// For a given round trip, a village's actual merchant count, and a cap on
// how many hours a route may be spread over, finds the firing interval
// (from Travian's allowed set) that maximizes ACTUAL achievable throughput —
// not merchants-per-unit efficiency. Those two are not the same thing:
// merchantsPerFiring = floor(merchantsTotal / cohortsInFlight) quantizes in
// steps, so a larger K can let a fixed merchant count divide evenly (using
// all of it) where a smaller K would leave several merchants idle to
// rounding, even though the smaller K "looks" more efficient per merchant.
// Village throughput, not merchant efficiency, is the actual goal — using
// more merchants is fine as long as the route can physically fire (i.e.
// never needs more merchants in flight than the village owns).
function bestInterval(
  roundTrip: number,
  merchantsTotal: number,
  maxSpreadHours: number
) {
  let best: {
    K: number;
    cohortsInFlight: number;
    merchantsPerFiring: number;
    throughputUnits: number;
  } | null = null;

  for (const K of ALLOWED_INTERVALS_HOURS) {
    if (K > maxSpreadHours) continue;
    const cohortsInFlight = Math.ceil(roundTrip / K);
    const merchantsPerFiring = Math.floor(merchantsTotal / cohortsInFlight);
    const throughputUnits = merchantsPerFiring / K; // crop/hour, per unit of capacityPerMerchant
    if (
      !best ||
      throughputUnits > best.throughputUnits ||
      (throughputUnits === best.throughputUnits && K < best.K)
    ) {
      best = { K, cohortsInFlight, merchantsPerFiring, throughputUnits };
    }
  }

  return (
    best ?? {
      K: 1,
      cohortsInFlight: Math.ceil(roundTrip),
      merchantsPerFiring: 0,
      throughputUnits: 0,
    }
  );
}

// For the source→relay hop, source isn't trying to maximize that single
// edge's capacity — its merchant pool is shared across every relay it might
// feed, so what matters is minimizing how many of ITS merchants a unit of
// throughput costs (ceil(roundTrip/K) * K). This is a different objective
// from bestInterval on purpose: a relay's own onward-to-Diet leg maximizes
// throughput given ITS fixed merchants, but source is rationing a shared
// budget across multiple candidates, so cost-per-unit is what should drive
// the choice here, independent of whatever K the relay uses onward.
function cheapestInterval(roundTrip: number, maxSpreadHours: number) {
  let best: { K: number; cohortsInFlight: number; merchantsPerUnit: number } | null =
    null;
  for (const K of ALLOWED_INTERVALS_HOURS) {
    if (K > maxSpreadHours) continue;
    const cohortsInFlight = Math.ceil(roundTrip / K);
    const merchantsPerUnit = cohortsInFlight * K;
    if (!best || merchantsPerUnit < best.merchantsPerUnit) {
      best = { K, cohortsInFlight, merchantsPerUnit };
    }
  }
  return (
    best ?? {
      K: 1,
      cohortsInFlight: Math.ceil(roundTrip),
      merchantsPerUnit: Math.ceil(roundTrip),
    }
  );
}

// Max crop/hour a village can sustain sending to a target, and the firing
// interval that achieves it.
function maxThroughput(
  village: RouteVillageInput,
  target: Coords,
  tribe: Tribe,
  allianceBonusPercent: number,
  maxSpreadHours: number
) {
  const distance = distanceFields(village, target);
  const speed = MERCHANT_SPEED_FIELDS_PER_HOUR[tribe];
  const oneWayHours = distance / speed;
  const capacityPerMerchant = merchantCapacity(
    tribe,
    village.tradeOfficeLevel,
    allianceBonusPercent
  );
  const { K, cohortsInFlight, merchantsPerFiring } = bestInterval(
    roundTripHours(distance, speed),
    village.merchantsTotal,
    maxSpreadHours
  );
  const cropPerHour = (merchantsPerFiring * capacityPerMerchant) / K;
  return {
    oneWayHours,
    capacityPerMerchant,
    K,
    cohortsInFlight,
    merchantsPerFiring,
    cropPerHour,
  };
}

export function computeRoutePlan(
  dietCoords: Coords,
  tribe: Tribe,
  allianceBonusPercent: number,
  villages: RouteVillageInput[],
  sourceVillageIndex: number | null,
  maxSpreadHours: number
): RoutePlan {
  const warnings: string[] = [];
  const legs: RouteLeg[] = [];

  const source =
    sourceVillageIndex !== null ? villages[sourceVillageIndex] ?? null : null;
  const others = villages.filter((v) => v !== source);

  const otherStats = others.map((village) => ({
    village,
    ...maxThroughput(
      village,
      dietCoords,
      tribe,
      allianceBonusPercent,
      maxSpreadHours
    ),
  }));

  // Keyed by village object identity, not name — village names aren't
  // guaranteed unique (e.g. multiple un-renamed "New village" entries).
  const fromSource = new Map<
    RouteVillageInput,
    { cropPerHour: number; oneWayHours: number; sourceK: number }
  >();

  if (source && source.cropSurplusPerHour > 0) {
    const sourceCapacityPerMerchant = merchantCapacity(
      tribe,
      source.tradeOfficeLevel,
      allianceBonusPercent
    );
    const speed = MERCHANT_SPEED_FIELDS_PER_HOUR[tribe];

    // The source→relay hop picks its own cheapest interval independent of
    // the relay's onward-to-Diet interval — see cheapestInterval() for why.
    // roundTripFromSource is kept around so the actual allocation step can
    // re-check every interval against whatever budget is left by then,
    // rather than committing to a single interval up front.
    const candidates = otherStats.map((stat) => {
      const distanceFromSource = distanceFields(source, stat.village);
      const oneWayFromSource = distanceFromSource / speed;
      const roundTripFromSource = roundTripHours(distanceFromSource, speed);
      const { K: sourceK, cohortsInFlight, merchantsPerUnit } = cheapestInterval(
        roundTripFromSource,
        maxSpreadHours
      );
      const spareCapacity = Math.max(
        0,
        stat.cropPerHour - stat.village.cropSurplusPerHour
      );
      return {
        stat,
        oneWayFromSource,
        roundTripFromSource,
        sourceK,
        cohortsInFlight,
        merchantsPerUnit,
        spareCapacity,
      };
    });

    // Two hard rules exclude a relay outright: it's physically impossible
    // (round trip alone needs more merchants than the village has at all),
    // or even sending just 1 merchant per firing would keep more than 25%
    // of source's fleet walking at all times (cohortsInFlight merchants
    // permanently occupied) — locking that much of the fleet on one far
    // relay isn't worth it. Short of that, more merchants is fine; every
    // remaining candidate gets a shot at leftover budget.
    const MAX_MERCHANT_SHARE = 0.25;
    for (const c of candidates) {
      if (c.cohortsInFlight > source.merchantsTotal) {
        warnings.push(
          `${c.stat.village.name} is too far from ${source.name} for a relay route even with up to ${maxSpreadHours}h spread (round trip alone needs more merchants than ${source.name} has) — ignored.`
        );
      } else if (c.cohortsInFlight > source.merchantsTotal * MAX_MERCHANT_SHARE) {
        warnings.push(
          `${c.stat.village.name} would keep at least ${c.cohortsInFlight} of ${source.name}'s ${source.merchantsTotal} merchants walking at all times — more than 25% of the fleet for one relay — skipped.`
        );
      }
    }

    // Greedy water-fill: cheapest relays (fewest source merchants per unit
    // throughput) get allocated first, up to their own spare capacity and
    // whatever's left of source's merchant pool.
    const eligible = candidates
      .filter(
        (c) =>
          c.cohortsInFlight <= source.merchantsTotal * MAX_MERCHANT_SHARE &&
          c.spareCapacity > 0
      )
      .sort((a, b) => a.merchantsPerUnit - b.merchantsPerUnit);

    let remainingSurplus = source.cropSurplusPerHour;
    let remainingMerchants = source.merchantsTotal;

    for (const c of eligible) {
      if (remainingSurplus <= 0 || remainingMerchants <= 0) break;

      // A cheaper-per-unit interval isn't useful if its up-front cohort
      // cost doesn't fit what's actually left of the budget by this point
      // in the greedy pass, while a "less efficient" interval with a
      // smaller absolute cohort count might still fit and deliver
      // something — so every interval is re-checked against what remains,
      // not just the one that was cheapest against the full merchant pool.
      let bestAllocated = 0;
      let bestMerchantsUsed = 0;
      let bestK = c.sourceK;

      for (const K of ALLOWED_INTERVALS_HOURS) {
        if (K > maxSpreadHours) continue;
        const cohorts = Math.ceil(c.roundTripFromSource / K);
        if (cohorts > remainingMerchants) continue;

        const maxMerchantsPerFiringByBudget = Math.floor(remainingMerchants / cohorts);
        const capByBudget = (maxMerchantsPerFiringByBudget * sourceCapacityPerMerchant) / K;
        const candidateAllocated = Math.min(remainingSurplus, c.spareCapacity, capByBudget);
        if (candidateAllocated <= bestAllocated) continue;

        bestAllocated = candidateAllocated;
        bestK = K;
        bestMerchantsUsed =
          ceilMerchants((candidateAllocated * K) / sourceCapacityPerMerchant) * cohorts;
      }

      if (bestAllocated <= 0) continue;

      fromSource.set(c.stat.village, {
        cropPerHour: bestAllocated,
        oneWayHours: c.oneWayFromSource,
        sourceK: bestK,
      });

      remainingSurplus -= bestAllocated;
      remainingMerchants -= bestMerchantsUsed;
    }

    if (remainingSurplus > 0.5) {
      warnings.push(
        `${source.name} has ${Math.round(
          remainingSurplus
        )} crop/hour that couldn't be allocated to any relay village (relay capacity or merchant limits reached).`
      );
    }
  }

  // Villages with nothing to send (still at the default 0 crop surplus)
  // don't get a leg at all.
  const standalone = otherStats.filter(
    (s) => !fromSource.has(s.village) && s.village.cropSurplusPerHour > 0
  );
  const relayFed = otherStats.filter((s) => fromSource.has(s.village));

  const pushLegToDiet = (
    stat: (typeof otherStats)[number],
    outflow: number,
    departureMinute: number,
    arrivalMinute: number
  ) => {
    if (outflow <= 0) return;
    const merchantsPerFiring = ceilMerchants(
      (outflow * stat.K) / stat.capacityPerMerchant
    );
    if (merchantsPerFiring > stat.merchantsPerFiring) {
      const requested = Math.round(outflow);
      const maxAchievable = Math.round(stat.cropPerHour);
      warnings.push(
        `${stat.village.name} can't sustain ${requested} crop/hour to Diet — its max capacity using every-${stat.K}h routes is ${maxAchievable} crop/hour with its current merchants and trade office level.`
      );
    }
    legs.push({
      fromVillage: stat.village.name,
      toVillage: 'Diet',
      cropPerHour: outflow,
      merchantsPerFiring,
      intervalHours: stat.K,
      departureMinute,
      arrivalMinute,
    });
  };

  // Diet arrivals are spread across a 24h reference cycle (a common
  // multiple of every allowed interval) so that every hour gets at least
  // one delivery and hourly totals stay roughly even. The hardest-to-place
  // routes (the biggest interval, fewest possible slots) are scheduled
  // first, each picking whichever slot is currently least loaded.
  const dietBound = [...standalone, ...relayFed].sort((a, b) => b.K - a.K);
  const hourLoad = new Array(CYCLE_HOURS).fill(0);
  const phaseHourByVillage = new Map<RouteVillageInput, number>();

  for (const stat of dietBound) {
    const outflow =
      stat.village.cropSurplusPerHour +
      (fromSource.get(stat.village)?.cropPerHour ?? 0);
    const cropPerFiring = outflow * stat.K;
    const firingsPerCycle = CYCLE_HOURS / stat.K;

    let bestPhase = 0;
    let bestScore = Infinity;
    for (let phase = 0; phase < stat.K; phase++) {
      let score = 0;
      for (let f = 0; f < firingsPerCycle; f++) {
        score += hourLoad[(phase + f * stat.K) % CYCLE_HOURS];
      }
      if (score < bestScore) {
        bestScore = score;
        bestPhase = phase;
      }
    }
    for (let f = 0; f < firingsPerCycle; f++) {
      hourLoad[(bestPhase + f * stat.K) % CYCLE_HOURS] += cropPerFiring;
    }
    phaseHourByVillage.set(stat.village, bestPhase);
  }

  if (dietBound.length > 0) {
    const emptyHours = hourLoad
      .map((load, hour) => (load === 0 ? hour : null))
      .filter((hour): hour is number => hour !== null);

    if (emptyHours.length > 0) {
      warnings.push(
        `Diet gets nothing during hour${
          emptyHours.length > 1 ? 's' : ''
        } ${emptyHours.join(', ')} of the cycle — increase max spread, add more relays, or raise crop surplus to close the gap.`
      );
    } else {
      const max = Math.max(...hourLoad);
      const min = Math.min(...hourLoad);
      if (max > min * 1.5) {
        warnings.push(
          `Deliveries to Diet are uneven across the cycle — busiest hour gets ${Math.round(
            max
          )} crop while the quietest gets ${Math.round(min)}.`
        );
      }
    }
  }

  // Within an hour that multiple routes share, minutes are spread out too
  // so they don't all land at the same instant.
  const byHour = new Map<number, (typeof otherStats)[number][]>();
  for (const stat of dietBound) {
    const hour = phaseHourByVillage.get(stat.village)!;
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour)!.push(stat);
  }

  const sourceCapacityPerMerchant = source
    ? merchantCapacity(tribe, source.tradeOfficeLevel, allianceBonusPercent)
    : 0;

  for (const stat of dietBound) {
    const hour = phaseHourByVillage.get(stat.village)!;
    const group = byHour.get(hour)!;
    const indexInGroup = group.indexOf(stat);
    const minuteInHour = Math.round((indexInGroup * 60) / group.length);
    const targetArrivalMinute = hour * 60 + minuteInHour;

    const incoming = fromSource.get(stat.village);
    if (incoming && source) {
      const relayDeparture = modMinutes(
        targetArrivalMinute - stat.oneWayHours * 60,
        stat.K * 60
      );
      // The latest a delivery can land and still leave the relay time to
      // forward it onward. Source's own leg runs on its own (usually
      // shorter) cycle, so its departure/arrival display is expressed
      // relative to that cycle, not the relay's.
      const latestSafeArrivalAtRelay = relayDeparture - BUFFER_MINUTES;
      const sourceDeparture = modMinutes(
        latestSafeArrivalAtRelay - incoming.oneWayHours * 60,
        incoming.sourceK * 60
      );
      const arrivalAtRelay = modMinutes(
        latestSafeArrivalAtRelay,
        incoming.sourceK * 60
      );

      legs.push({
        fromVillage: source.name,
        toVillage: stat.village.name,
        cropPerHour: incoming.cropPerHour,
        merchantsPerFiring: ceilMerchants(
          (incoming.cropPerHour * incoming.sourceK) / sourceCapacityPerMerchant
        ),
        intervalHours: incoming.sourceK,
        departureMinute: sourceDeparture,
        arrivalMinute: arrivalAtRelay,
      });

      pushLegToDiet(
        stat,
        stat.village.cropSurplusPerHour + incoming.cropPerHour,
        relayDeparture,
        targetArrivalMinute
      );
    } else {
      const departureMinute = modMinutes(
        targetArrivalMinute - stat.oneWayHours * 60,
        stat.K * 60
      );
      pushLegToDiet(
        stat,
        stat.village.cropSurplusPerHour,
        departureMinute,
        targetArrivalMinute
      );
    }
  }

  if (legs.length === 0 && warnings.length === 0) {
    warnings.push(
      'No village has a crop surplus set — nothing to route. Set "Crop surplus/hour" for at least one village.'
    );
  }

  return { legs, warnings };
}
