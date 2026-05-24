import {
  SLOT_RTP_TARGET,
  createSeededRng,
  evaluateSlotGrid,
  generateSlotGrid,
  settleSlotMath
} from "../slot-rules.mjs";

const paidSpins = Number(process.argv[2] || 1_000_000);
const seed = Number(process.argv[3] || 95005);
const bet = 100;
const rng = createSeededRng(seed);

let totalBet = 0;
let totalPayout = 0;
let hitCount = 0;
let bonusTriggerCount = 0;
let bonusTotalCount = 0;
let bonusTotalPayout = 0;
let maxObservedWin = 0;
let freeSpinCount = 0;
let retriggerCount = 0;
let stickyUpgradeCount = 0;

const crazyModeConfig = {
  stickyWildChance: 0.32,
  maxStickyWilds: 6,
  winMultiplierStep: 1
};

function spinGrid() {
  return generateSlotGrid({
    rng,
    nearMiss: true,
    assistSmallWin: true
  });
}

function settleSpin(grid, bonus = null) {
  const result = evaluateSlotGrid(grid);
  return {
    result,
    settlement: settleSlotMath({ result, bet, bonus })
  };
}

function stickyWildKey(row, column) {
  return `${row}-${column}`;
}

function addStickyWild(stickyWilds, row, column) {
  const key = stickyWildKey(row, column);
  if (stickyWilds.has(key) || stickyWilds.size >= crazyModeConfig.maxStickyWilds) {
    return false;
  }

  stickyWilds.add(key);
  return true;
}

function collectStickyWilds(grid, stickyWilds) {
  grid.forEach((rowValues, row) => {
    rowValues.forEach((symbolId, column) => {
      if (symbolId === "wild") {
        addStickyWild(stickyWilds, row, column);
      }
    });
  });
}

function prepareCrazyModeGrid(grid, stickyWilds) {
  const nextGrid = grid.map((rowValues) => [...rowValues]);

  stickyWilds.forEach((key) => {
    const [row, column] = key.split("-").map(Number);
    nextGrid[row][column] = "wild";
  });

  if (stickyWilds.size < crazyModeConfig.maxStickyWilds && rng() < crazyModeConfig.stickyWildChance) {
    const candidates = [];
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        const key = stickyWildKey(row, column);
        if (!stickyWilds.has(key) && nextGrid[row][column] !== "scatter") {
          candidates.push({ row, column });
        }
      }
    }

    if (candidates.length) {
      const pick = candidates[Math.floor(rng() * candidates.length)];
      nextGrid[pick.row][pick.column] = "wild";
      addStickyWild(stickyWilds, pick.row, pick.column);
    }
  }

  return nextGrid;
}

for (let index = 0; index < paidSpins; index += 1) {
  totalBet += bet;

  const paid = settleSpin(spinGrid());
  totalPayout += paid.settlement.payout;
  maxObservedWin = Math.max(maxObservedWin, paid.settlement.payout);
  if (paid.settlement.payout > 0) {
    hitCount += 1;
  }

  let bonus = paid.settlement.trigger;
  if (bonus) {
    bonusTriggerCount += 1;
    const bonusStartPayout = totalPayout;
    const stickyWilds = new Set();

    while (bonus.freeSpins > 0) {
      freeSpinCount += 1;
      const wasStickyBonus = Boolean(bonus.stickyWilds);
      const grid = bonus.stickyWilds ? prepareCrazyModeGrid(spinGrid(), stickyWilds) : spinGrid();
      const free = settleSpin(grid, bonus);
      bonus = free.settlement.nextBonus;
      if (bonus.stickyWilds) {
        collectStickyWilds(grid, stickyWilds);
        if (free.settlement.payout > 0 && free.result.lineWins.length && bonus.freeSpins > 0) {
          bonus.multiplier = Math.min(
            10,
            bonus.multiplier + crazyModeConfig.winMultiplierStep
          );
        }
      }
      totalPayout += free.settlement.payout;
      maxObservedWin = Math.max(maxObservedWin, free.settlement.payout);
      if (free.settlement.payout > 0) {
        hitCount += 1;
      }
      if (free.settlement.retrigger) {
        retriggerCount += 1;
        if (free.settlement.retrigger.stickyWilds && !wasStickyBonus) {
          stickyUpgradeCount += 1;
        }
      }
    }

    bonusTotalCount += 1;
    bonusTotalPayout += totalPayout - bonusStartPayout;
  }
}

const rtp = totalPayout / totalBet;
const houseEdge = 1 - rtp;
const bonusTriggerFrequency = bonusTriggerCount / paidSpins;
const averageBonusValue = bonusTotalCount ? bonusTotalPayout / bonusTotalCount : 0;
const hitFrequency = hitCount / (paidSpins + freeSpinCount);

console.log(`Paid spins: ${paidSpins.toLocaleString("en-US")}`);
console.log(`Seed: ${seed}`);
console.log(`RTP target: ${(SLOT_RTP_TARGET * 100).toFixed(2)}%`);
console.log(`RTP: ${(rtp * 100).toFixed(3)}%`);
console.log(`House edge: ${(houseEdge * 100).toFixed(3)}%`);
console.log(`Hit frequency: ${(hitFrequency * 100).toFixed(3)}%`);
console.log(`Bonus trigger frequency: ${(bonusTriggerFrequency * 100).toFixed(3)}%`);
console.log(`Retrigger count: ${retriggerCount.toLocaleString("en-US")}`);
console.log(`Sticky upgrades: ${stickyUpgradeCount.toLocaleString("en-US")}`);
console.log(`Free spins played: ${freeSpinCount.toLocaleString("en-US")}`);
console.log(`Average bonus value: ${(averageBonusValue / bet).toFixed(3)}x bet`);
console.log(`Max observed single-spin win: ${(maxObservedWin / bet).toFixed(2)}x bet`);
