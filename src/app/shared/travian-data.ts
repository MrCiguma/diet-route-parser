export type Tribe = 'roman' | 'teuton' | 'gaul' | 'egyptian' | 'hun';

// Sources: support.kingdoms.com/marketplace, support.travian.com/213-guide-the-marketplace,
// travian.fandom.com/wiki/Merchant, travian.fandom.com/wiki/Trade_office
export const MERCHANT_BASE_CAPACITY: Record<Tribe, number> = {
  roman: 500,
  gaul: 750,
  teuton: 1000,
  egyptian: 750,
  hun: 500,
};

export const MERCHANT_SPEED_FIELDS_PER_HOUR: Record<Tribe, number> = {
  roman: 16,
  gaul: 24,
  teuton: 12,
  egyptian: 16,
  hun: 20,
};

// Romans get double the per-level Trade Office effect; every other tribe
// gets the standard rate (confirmed by user; Egyptian/Hun assumed to share
// the Gaul/Teuton rate since no tribe-specific split is documented).
export const TRADE_OFFICE_BONUS_PER_LEVEL: Record<Tribe, number> = {
  roman: 0.4,
  gaul: 0.2,
  teuton: 0.2,
  egyptian: 0.2,
  hun: 0.2,
};

export function merchantCapacity(
  tribe: Tribe,
  tradeOfficeLevel: number,
  allianceBonusPercent: number
): number {
  const base = MERCHANT_BASE_CAPACITY[tribe];
  const withTradeOffice =
    base + base * TRADE_OFFICE_BONUS_PER_LEVEL[tribe] * tradeOfficeLevel;
  return withTradeOffice * (1 + allianceBonusPercent / 100);
}
