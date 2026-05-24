export const SLOT_RTP_TARGET = 0.95;

export const SLOT_SYMBOLS = [
  { id: "cherry", label: "Cherries", icon: "🍒", tier: "common", weight: 18 },
  { id: "banana", label: "Banana", icon: "🍌", tier: "common", weight: 18 },
  { id: "apple", label: "Apple", icon: "🍎", tier: "common", weight: 17 },
  { id: "hundred", label: "Hundreds", icon: "💯", tier: "mid", weight: 12 },
  { id: "diamond", label: "Diamond", icon: "💎", tier: "mid", weight: 10 },
  { id: "seven", label: "Seven", icon: "7", tier: "premium", weight: 8 },
  { id: "jackpot", label: "Jackpot", icon: "🎰", tier: "jackpot", weight: 5 },
  { id: "crown", label: "Crown", icon: "♛", tier: "royal", weight: 3 },
  { id: "scatter", label: "Scatter", icon: "⭐", tier: "scatter", weight: 2 },
  { id: "wild", label: "Wild", icon: "⚡", tier: "wild", weight: 7 },
  { id: "gold", label: "Gold", icon: "🏆", tier: "jackpot", weight: 3 }
];

export const SLOT_SYMBOL_MAP = Object.fromEntries(SLOT_SYMBOLS.map((symbol) => [symbol.id, symbol]));

export const SLOT_PAYLINES = [
  { id: "top", name: "Top", rows: [0, 0, 0, 0, 0] },
  { id: "middle", name: "Middle", rows: [1, 1, 1, 1, 1] },
  { id: "bottom", name: "Bottom", rows: [2, 2, 2, 2, 2] },
  { id: "v", name: "V", rows: [0, 1, 2, 1, 0] },
  { id: "inverted-v", name: "Inv V", rows: [2, 1, 0, 1, 2] },
  { id: "zigzag", name: "Zig", rows: [0, 1, 0, 1, 0] },
  { id: "zag", name: "Zag", rows: [2, 1, 2, 1, 2] },
  { id: "rise", name: "Rise", rows: [2, 2, 1, 0, 0] },
  { id: "fall", name: "Fall", rows: [0, 0, 1, 2, 2] },
  { id: "diamond-line", name: "Gem", rows: [1, 0, 1, 2, 1] }
];

export const SLOT_PAYOUTS = {
  common: { 3: 0.564, 4: 1.481, 5: 3.349 },
  mid: { 3: 0.987, 4: 2.996, 5: 7.755 },
  premium: { 3: 1.939, 4: 6.345, 5: 21.15 },
  jackpot: { 3: 3.878, 4: 17.625, 5: 77.55 },
  royal: { 3: 7.05, 4: 35.25, 5: 229.125 },
  wild: { 3: 2.468, 4: 8.46, 5: 31.725 }
};

export const SLOT_SCATTER_RULES = {
  pays: { 2: 0.423, 3: 5.288, 4: 28.2, 5: 141, 6: 282, 7: 423, 8: 634.5, 9: 916.5, 10: 1339.5, 11: 1833, 12: 2467.5, 13: 3172.5, 14: 4053.75, 15: 5287.5 },
  awards: {
    3: { freeSpins: 6, multiplier: 2, retriggerSpins: 3, multiplierStep: 1 },
    4: { freeSpins: 10, multiplier: 3, retriggerSpins: 5, multiplierStep: 2 },
    5: { freeSpins: 15, multiplier: 5, retriggerSpins: 8, multiplierStep: 3 }
  },
  multiplierCap: 10,
  freeSpinBankCap: 50
};

export function createSeededRng(seed = 123456789) {
  let value = seed >>> 0;
  return function seededRandom() {
    value = (value + 0x6D2B79F5) >>> 0;
    let next = value;
    next = Math.imul(next ^ next >>> 15, next | 1);
    next ^= next + Math.imul(next ^ next >>> 7, next | 61);
    return ((next ^ next >>> 14) >>> 0) / 4294967296;
  };
}

export function weightedSlotSymbol(rng = Math.random, symbols = SLOT_SYMBOLS) {
  const totalWeight = symbols.reduce((sum, symbol) => sum + symbol.weight, 0);
  let pick = rng() * totalWeight;

  for (const symbol of symbols) {
    pick -= symbol.weight;
    if (pick <= 0) {
      return symbol;
    }
  }

  return symbols[0];
}

export function generateSlotGrid(options = {}) {
  const rng = options.rng || Math.random;
  const grid = Array.from({ length: 3 }, () =>
    Array.from({ length: 5 }, () => weightedSlotSymbol(rng).id)
  );

  if (options.nearMiss && rng() < 0.18 && grid.flat().filter((symbolId) => symbolId === "scatter").length === 0) {
    const firstColumn = Math.floor(rng() * 5);
    let secondColumn = Math.floor(rng() * 5);
    while (secondColumn === firstColumn) {
      secondColumn = Math.floor(rng() * 5);
    }
    grid[0][firstColumn] = "scatter";
    grid[2][secondColumn] = "scatter";
  }

  if (options.assistSmallWin && rng() < 0.08) {
    const result = evaluateSlotGrid(grid);
    if (!result.lineWins.length && !result.scatterTriggered) {
      const row = Math.floor(rng() * 3);
      const symbol = ["cherry", "banana", "apple", "hundred"][Math.floor(rng() * 4)];
      grid[row][0] = symbol;
      grid[row][1] = "wild";
      grid[row][2] = symbol;
    }
  }

  return grid;
}

function evaluateSlotLineRun(grid, payline, direction = "left") {
  const lineSymbols = payline.rows.map((row, column) => grid[row][column]);
  const columns = direction === "right" ? [4, 3, 2, 1, 0] : [0, 1, 2, 3, 4];
  const orderedSymbols = columns.map((column) => lineSymbols[column]);
  const target = orderedSymbols.find((symbolId) => symbolId !== "wild" && symbolId !== "scatter") || "wild";

  if (target === "scatter") {
    return null;
  }

  let count = 0;
  for (const symbolId of orderedSymbols) {
    if (symbolId === target || symbolId === "wild") {
      count += 1;
    } else {
      break;
    }
  }

  if (count < 3) {
    return null;
  }

  const symbol = SLOT_SYMBOL_MAP[target];
  const tier = target === "wild" ? "wild" : symbol.tier;
  const multiplier = SLOT_PAYOUTS[tier]?.[count] || 0;

  if (!multiplier) {
    return null;
  }

  return {
    id: direction === "right" ? `${payline.id}-right` : payline.id,
    paylineId: payline.id,
    name: direction === "right" ? `${payline.name} R` : payline.name,
    direction,
    symbol: target,
    symbols: orderedSymbols.slice(0, count),
    count,
    multiplier,
    cells: columns.slice(0, count).map((column) => ({ row: payline.rows[column], column }))
  };
}

export function evaluateSlotLine(grid, payline) {
  const leftWin = evaluateSlotLineRun(grid, payline, "left");
  const rightWin = evaluateSlotLineRun(grid, payline, "right");

  if (!leftWin) {
    return rightWin;
  }
  if (!rightWin) {
    return leftWin;
  }

  return leftWin.multiplier >= rightWin.multiplier ? leftWin : rightWin;
}

function evaluateSlotLineWins(grid, payline) {
  const leftWin = evaluateSlotLineRun(grid, payline, "left");
  const rightWin = evaluateSlotLineRun(grid, payline, "right");

  if (!leftWin) {
    return rightWin ? [rightWin] : [];
  }
  if (!rightWin) {
    return [leftWin];
  }
  if (leftWin.count === 5 && rightWin.count === 5 && leftWin.symbol === rightWin.symbol) {
    return [leftWin];
  }

  return [leftWin, rightWin];
}

export function evaluateSlotGrid(grid) {
  const lineWins = SLOT_PAYLINES.flatMap((payline) => evaluateSlotLineWins(grid, payline));
  const scatterCells = [];
  grid.forEach((rowValues, row) => {
    rowValues.forEach((symbolId, column) => {
      if (symbolId === "scatter") {
        scatterCells.push({ row, column });
      }
    });
  });

  const scatterCount = scatterCells.length;
  const lineMultiplier = lineWins.reduce((sum, win) => sum + win.multiplier, 0);
  const scatterPay = SLOT_SCATTER_RULES.pays[Math.min(scatterCount, 15)] || 0;
  const scatterAward = SLOT_SCATTER_RULES.awards[Math.min(scatterCount, 5)] || null;

  return {
    lineWins,
    scatterCount,
    scatterCells,
    scatterTriggered: Boolean(scatterAward),
    multiplier: lineMultiplier + scatterPay,
    lineMultiplier,
    scatterPay,
    freeSpinsAwarded: scatterAward?.freeSpins || 0,
    retriggerSpins: scatterAward?.retriggerSpins || 0,
    bonusMultiplier: scatterAward?.multiplier || 1,
    multiplierStep: scatterAward?.multiplierStep || 0,
    totalWays: lineWins.length + (scatterPay > 0 ? 1 : 0)
  };
}

export function winTier(payout, bet) {
  if (payout >= bet * 75) {
    return "jackpot";
  }
  if (payout >= bet * 30) {
    return "mega";
  }
  if (payout >= bet * 10) {
    return "big";
  }
  if (payout > 0) {
    return "small";
  }
  return "none";
}

export function winTierTitle(tier) {
  return {
    jackpot: "Jackpot",
    mega: "Mega win",
    big: "Big win",
    small: "Slot win",
    none: "No win"
  }[tier] || "Slot win";
}

export function settleSlotMath({ result, bet = 1, bonus = null }) {
  const inBonus = Boolean(bonus);
  const activeMultiplier = inBonus ? bonus.multiplier : 1;
  const payout = Math.round(bet * result.multiplier * activeMultiplier);
  const nextBonus = bonus ? { ...bonus } : null;
  let trigger = null;
  let retrigger = null;

  if (inBonus) {
    nextBonus.freeSpins = Math.max(0, nextBonus.freeSpins - 1);
    nextBonus.totalWin += payout;

    if (result.scatterTriggered) {
      const addedSpins = Math.min(
        result.retriggerSpins,
        Math.max(0, SLOT_SCATTER_RULES.freeSpinBankCap - nextBonus.freeSpins)
      );
      nextBonus.freeSpins += addedSpins;
      nextBonus.multiplier = Math.min(
        SLOT_SCATTER_RULES.multiplierCap,
        nextBonus.multiplier + result.multiplierStep
      );
      retrigger = {
        freeSpins: addedSpins,
        multiplier: nextBonus.multiplier
      };
    }
  } else if (result.scatterTriggered) {
    trigger = {
      freeSpins: result.freeSpinsAwarded,
      multiplier: result.bonusMultiplier,
      totalWin: 0
    };
  }

  return {
    payout,
    activeMultiplier,
    trigger,
    retrigger,
    nextBonus,
    tier: winTier(payout, bet)
  };
}
