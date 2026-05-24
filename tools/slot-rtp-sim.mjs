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

    while (bonus.freeSpins > 0) {
      freeSpinCount += 1;
      const free = settleSpin(spinGrid(), bonus);
      bonus = free.settlement.nextBonus;
      totalPayout += free.settlement.payout;
      maxObservedWin = Math.max(maxObservedWin, free.settlement.payout);
      if (free.settlement.payout > 0) {
        hitCount += 1;
      }
      if (free.settlement.retrigger) {
        retriggerCount += 1;
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
console.log(`Free spins played: ${freeSpinCount.toLocaleString("en-US")}`);
console.log(`Average bonus value: ${(averageBonusValue / bet).toFixed(3)}x bet`);
console.log(`Max observed single-spin win: ${(maxObservedWin / bet).toFixed(2)}x bet`);
