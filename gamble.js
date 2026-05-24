import { requireAuth, updateNavbar } from './auth.js';
import {
  DEFAULT_BALANCE,
  getPlayerBalance,
  insertGamblingEvent,
  savePlayerBalance as persistPlayerBalance
} from './gamble-data.js?v=dashboard-clean-1';
import { renderRecentEvents } from './gamble-activity.js?v=dashboard-clean-1';
import { renderGamblingDashboard } from './gamble-dashboard.js?v=dashboard-clean-1';
import { renderLeaderboard } from './gamble-leaderboard.js?v=dashboard-clean-1';
import {
  SLOT_PAYLINES as slotRulesPaylines,
  SLOT_RTP_TARGET,
  SLOT_SYMBOL_MAP as slotRulesSymbolMap,
  SLOT_SYMBOLS as slotRulesSymbols,
  evaluateSlotGrid as evaluateSlotRulesGrid,
  generateSlotGrid as generateSlotRulesGrid,
  settleSlotMath as settleSlotRulesMath,
  weightedSlotSymbol as weightedSlotRulesSymbol,
  winTierTitle
} from './slot-rules.mjs?v=slot-rtp-1';

const activeUsername = requireAuth('signin.html');
updateNavbar(activeUsername);

const ranks = [
  { label: "2", value: 2, blackjack: 2 },
  { label: "3", value: 3, blackjack: 3 },
  { label: "4", value: 4, blackjack: 4 },
  { label: "5", value: 5, blackjack: 5 },
  { label: "6", value: 6, blackjack: 6 },
  { label: "7", value: 7, blackjack: 7 },
  { label: "8", value: 8, blackjack: 8 },
  { label: "9", value: 9, blackjack: 9 },
  { label: "10", value: 10, blackjack: 10 },
  { label: "J", value: 11, blackjack: 10 },
  { label: "Q", value: 12, blackjack: 10 },
  { label: "K", value: 13, blackjack: 10 },
  { label: "A", value: 14, blackjack: 11 }
];
const suits = [
  { label: "S", color: "black" },
  { label: "H", color: "red" },
  { label: "D", color: "red" },
  { label: "C", color: "black" }
];

const state = {
  username: activeUsername,
  balanceLoading: true,
  game: "high-card",
  credits: 0,
  bet: 5,
  streak: 0,
  wins: 0,
  losses: 0,
  blackjackActive: false,
  dealerHand: [],
  playerHand: [],
  hideDealerHole: false,
  blackjackResolving: false,
  renderedBet: 5,
  blackjackRound: 0,
  rouletteActive: false,
  rouletteBetType: "color",
  rouletteChoice: "red",
  rouletteWheelRotation: 0,
  rouletteBallRotation: 0,
  slotActive: false,
  slotFreeSpins: 0,
  slotMultiplier: 1,
  slotLastWin: 0,
  slotScatterCount: 0,
  slotRound: 0,
  slotBonusTotal: 0,
  slotRetriggerText: ""
};

const creditsEl = document.getElementById("credits");
const betEl = document.getElementById("bet-value");
const streakEl = document.getElementById("streak");
const winsEl = document.getElementById("wins");
const lossesEl = document.getElementById("losses");
const titleEl = document.getElementById("result-title");
const copyEl = document.getElementById("result-copy");
const gameCopyEl = document.getElementById("game-copy");
const dealButton = document.getElementById("deal");
const hitButton = document.getElementById("hit");
const standButton = document.getElementById("stand");
const lowerBetButton = document.getElementById("lower-bet");
const raiseBetButton = document.getElementById("raise-bet");
const minBetButton = document.getElementById("min-bet");
const maxBetButton = document.getElementById("max-bet");
const resetButton = document.getElementById("reset");
const deckShoeEl = document.getElementById("deck-shoe");
const effectLayerEl = document.getElementById("effect-layer");
const playerCardEl = document.getElementById("player-card");
const houseCardEl = document.getElementById("house-card");
const dealerHandEl = document.getElementById("dealer-hand");
const playerHandEl = document.getElementById("blackjack-hand");
const dealerZoneEl = document.getElementById("dealer-zone");
const playerZoneEl = document.getElementById("player-zone");
const dealerTotalEl = document.getElementById("dealer-total");
const playerTotalEl = document.getElementById("player-total");
const rouletteWheelEl = document.getElementById("roulette-wheel");
const rouletteBallTrackEl = document.getElementById("roulette-ball-track");
const rouletteResultEl = document.getElementById("roulette-result");
const rouletteNumberBoardEl = document.getElementById("roulette-number-board");
const slotCabinetEl = document.getElementById("slot-cabinet");
const slotReelsEl = document.getElementById("slot-reels");
const slotModeEl = document.getElementById("slot-mode");
const slotSpinStatusEl = document.getElementById("slot-spin-status");
const slotWinPanelEl = document.getElementById("slot-win-panel");
const slotWinTitleEl = document.getElementById("slot-win-title");
const slotWinDetailEl = document.getElementById("slot-win-detail");
const slotWinAmountEl = document.getElementById("slot-win-amount");
const slotPaylineListEl = document.getElementById("slot-payline-list");
const slotScatterCountEl = document.getElementById("slot-scatter-count");
const slotScatterFillEl = document.getElementById("slot-scatter-fill");
const slotLastWinEl = document.getElementById("slot-last-win");
const slotMultiplierEl = document.getElementById("slot-multiplier");
const slotBonusTotalEl = document.getElementById("slot-bonus-total");
const slotRtpEl = document.getElementById("slot-rtp");
const slotRetriggerEl = document.getElementById("slot-retrigger");
const leaderboardListEl = document.getElementById("leaderboard-list");
const leaderboardStatusEl = document.getElementById("leaderboard-status");
const activityListEl = document.getElementById("activity-list");
const activityStatusEl = document.getElementById("activity-status");
const dashboardStatusEl = document.getElementById("dashboard-status");
const dashboardKpiEl = document.getElementById("dashboard-kpis");
const netChartEl = document.getElementById("net-chart");
const mixChartEl = document.getElementById("mix-chart");
const gameChartEl = document.getElementById("game-chart");
const activityTabs = Array.from(document.querySelectorAll("[data-activity-filter]"));
const slotLineEls = Array.from(document.querySelectorAll(".slot-line"));
const messageEl = document.querySelector(".message");
const betBoxEl = document.querySelector(".bet");
const creditsStatEl = creditsEl.closest(".stat");
const streakStatEl = streakEl.closest(".stat");
const recordStatEl = winsEl.closest(".stat");
const tabs = Array.from(document.querySelectorAll(".tab"));
const panels = {
  "high-card": document.getElementById("high-card-panel"),
  blackjack: document.getElementById("blackjack-panel"),
  roulette: document.getElementById("roulette-panel"),
  slots: document.getElementById("slots-panel")
};
const chipButtons = Array.from(document.querySelectorAll("[data-chip]"));
let roulettePickButtons = Array.from(document.querySelectorAll("[data-roulette-type]"));
const blackjackCards = {
  dealer: [],
  player: []
};
const rouletteNumbers = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];
const redNumbers = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const slotSymbols = [
  { id: "cherry", label: "Cherries", icon: "🍒", tier: "common", weight: 17 },
  { id: "banana", label: "Banana", icon: "🍌", tier: "common", weight: 17 },
  { id: "apple", label: "Apple", icon: "🍎", tier: "common", weight: 15 },
  { id: "hundred", label: "Hundreds", icon: "💯", tier: "mid", weight: 12 },
  { id: "diamond", label: "Diamond", icon: "💎", tier: "mid", weight: 10 },
  { id: "seven", label: "Seven", icon: "7", tier: "premium", weight: 7 },
  { id: "jackpot", label: "Jackpot", icon: "🎰", tier: "jackpot", weight: 4 },
  { id: "scatter", label: "Scatter", icon: "⭐", tier: "scatter", weight: 3 },
  { id: "wild", label: "Wild", icon: "⚡", tier: "wild", weight: 9 },
  { id: "gold", label: "Gold", icon: "🏆", tier: "jackpot", weight: 3 }
];
const slotSymbolMap = Object.fromEntries(slotSymbols.map((symbol) => [symbol.id, symbol]));
const slotPaylines = [
  { id: "top", name: "Top", rows: [0, 0, 0, 0, 0] },
  { id: "middle", name: "Middle", rows: [1, 1, 1, 1, 1] },
  { id: "bottom", name: "Bottom", rows: [2, 2, 2, 2, 2] },
  { id: "v", name: "V", rows: [0, 1, 2, 1, 0] },
  { id: "inverted-v", name: "Inv V", rows: [2, 1, 0, 1, 2] }
];
const slotPayouts = {
  common: { 3: 0.5, 4: 1, 5: 2 },
  mid: { 3: 1, 4: 3, 5: 6 },
  premium: { 3: 2, 4: 8, 5: 20 },
  jackpot: { 3: 4, 4: 15, 5: 50 },
  wild: { 3: 2, 4: 8, 5: 20 }
};
const gameMeta = {
  "high-card": {
    title: "High Card",
    copy: "Higher card wins. Ties return your bet.",
    action: "Deal Cards"
  },
  blackjack: {
    title: "Blackjack",
    copy: "Get closer to 21 than the dealer without going over.",
    activeCopy: "Dealer stands on 17. Natural blackjack pays 3:2.",
    action: "Deal Blackjack"
  },
  roulette: {
    title: "Roulette",
    copy: "Pick a color or exact number and spin for fictional-dollar payouts.",
    activeCopy: "Pick a color or exact number, then spin the wheel.",
    action: "Spin Wheel"
  },
  slots: {
    title: "Slots",
    copy: "Five reels, ten lines, scatter bonuses, and tuned 95% RTP.",
    activeCopy: "Match left-to-right or land 3 scatters for free spins.",
    action: "Spin Reels"
  }
};
const cardMarkMarkup = `<div class="card-mark">GTS&reg;</div>`;
const cardBackBrandMarkup = `<div class="card-back-brand"><span>GamerTown Solutions &reg;</span><span>solutions that solve</span></div>`;

function replayAnimation(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

function clearAnimationClass(element, className, delay = 900) {
  window.setTimeout(() => element.classList.remove(className), delay);
}

function showResult(title, copy) {
  titleEl.textContent = title;
  copyEl.textContent = copy;
  replayAnimation(messageEl, "flash");
}

function pulseStats(...stats) {
  stats.forEach((stat) => replayAnimation(stat, "pulse"));
}

function resetEffects() {
  messageEl.classList.remove("impact");
  dealerZoneEl.classList.remove("outcome-win", "outcome-loss");
  playerZoneEl.classList.remove("outcome-win", "outcome-loss");
  effectLayerEl.innerHTML = "";
  rouletteResultEl.classList.remove("pop");
  slotCabinetEl.classList.remove("big-win");
  slotWinPanelEl.classList.remove("win", "bonus");
  slotCabinetEl.querySelectorAll(".slot-coin").forEach((coinEl) => coinEl.remove());
  document.querySelectorAll(".card.winner, .card.loser").forEach((cardEl) => {
    cardEl.classList.remove("winner", "loser");
  });
  document.querySelectorAll(".slot-cell.winning, .slot-cell.scatter-hit").forEach((cellEl) => {
    cellEl.classList.remove("winning", "scatter-hit");
  });
  slotLineEls.forEach((lineEl) => {
    lineEl.classList.remove("active");
    lineEl.removeAttribute("data-hit");
  });
  dealerTotalEl.classList.remove("winner", "loser");
  playerTotalEl.classList.remove("winner", "loser");
}

function createSparkles() {
  effectLayerEl.innerHTML = "";
  const positions = [
    [18, 72], [28, 36], [38, 64], [48, 28], [58, 70], [70, 42], [80, 62], [88, 32]
  ];

  positions.forEach(([left, top], index) => {
    const sparkle = document.createElement("span");
    sparkle.className = "sparkle";
    sparkle.style.left = `${left}%`;
    sparkle.style.top = `${top}%`;
    sparkle.style.animationDelay = `${index * 55}ms`;
    effectLayerEl.appendChild(sparkle);
  });
  window.setTimeout(() => {
    effectLayerEl.innerHTML = "";
  }, 1050);
}

function playOutcomeEffect(result, winner = null) {
  if (result === "win") {
    createSparkles();
  } else if (result === "loss") {
    replayAnimation(messageEl, "impact");
    clearAnimationClass(messageEl, "impact", 360);
  }

  if (winner === "player") {
    playerZoneEl.classList.add("outcome-win");
    dealerZoneEl.classList.add("outcome-loss");
    playerTotalEl.classList.add("winner");
    dealerTotalEl.classList.add("loser");
    blackjackCards.dealer.forEach(({ cardEl }) => cardEl.classList.add("loser"));
  } else if (winner === "dealer") {
    dealerZoneEl.classList.add("outcome-win");
    playerZoneEl.classList.add("outcome-loss");
    dealerTotalEl.classList.add("winner");
    playerTotalEl.classList.add("loser");
    blackjackCards.player.forEach(({ cardEl }) => cardEl.classList.add("loser"));
  }

  if (result === "push") {
    createSparkles();
  }
}

function maxBet() {
  return Math.floor(state.credits / 5) * 5;
}

function rouletteColor(number) {
  if (number === 0) {
    return "green";
  }
  return redNumbers.has(number) ? "red" : "black";
}

function normalizeAngle(angle) {
  return ((angle % 360) + 360) % 360;
}

function nextClockwiseRotation(current, targetAngle, spins) {
  const currentAngle = normalizeAngle(current);
  const target = normalizeAngle(targetAngle);
  return current + spins * 360 + normalizeAngle(target - currentAngle);
}

function nextCounterClockwiseRotation(current, targetAngle, spins) {
  const currentAngle = normalizeAngle(current);
  const target = normalizeAngle(targetAngle);
  return current - spins * 360 - normalizeAngle(currentAngle - target);
}

function initializeRouletteUi() {
  const segment = 360 / rouletteNumbers.length;
  rouletteWheelEl.innerHTML = "";
  rouletteNumbers.forEach((number, index) => {
    const label = document.createElement("span");
    label.className = "roulette-number";
    label.textContent = number;
    label.style.setProperty("--angle", `${index * segment + segment / 2}deg`);
    rouletteWheelEl.appendChild(label);
  });

  rouletteNumberBoardEl.innerHTML = "";
  for (let number = 1; number <= 36; number += 1) {
    const button = document.createElement("button");
    button.className = `roulette-number-pick ${rouletteColor(number)}`;
    button.type = "button";
    button.dataset.rouletteType = "number";
    button.dataset.rouletteValue = String(number);
    button.textContent = number;
    rouletteNumberBoardEl.appendChild(button);
  }

  roulettePickButtons = Array.from(document.querySelectorAll("[data-roulette-type]"));
}

function weightedSlotSymbol() {
  return weightedSlotRulesSymbol();
}

function generateSlotGrid(options = {}) {
  return generateSlotRulesGrid(options);
}

function evaluateSlotLine(grid, payline) {
  const lineSymbols = payline.rows.map((row, column) => grid[row][column]);
  const target = lineSymbols.find((symbolId) => symbolId !== "wild" && symbolId !== "scatter") || "wild";

  if (target === "scatter") {
    return null;
  }

  let count = 0;
  for (const symbolId of lineSymbols) {
    if (symbolId === target || symbolId === "wild") {
      count += 1;
    } else {
      break;
    }
  }

  if (count < 3) {
    return null;
  }

  const symbol = slotRulesSymbolMap[target];
  const tier = target === "wild" ? "wild" : symbol.tier;
  const multiplier = slotPayouts[tier]?.[count] || 0;

  if (!multiplier) {
    return null;
  }

  return {
    id: payline.id,
    name: payline.name,
    symbol: target,
    symbols: lineSymbols.slice(0, count),
    count,
    multiplier,
    cells: payline.rows.slice(0, count).map((row, column) => ({ row, column }))
  };
}

function evaluateSlotGrid(grid) {
  return evaluateSlotRulesGrid(grid);
}

function renderSlotGrid(grid, winningLines = [], scatterCells = []) {
  const winningCells = new Set();
  const scatterCellSet = new Set(scatterCells.map(({ row, column }) => `${row}-${column}`));
  winningLines.forEach((line) => {
    line.cells.forEach(({ row, column }) => winningCells.add(`${row}-${column}`));
  });

  slotReelsEl.innerHTML = "";
  for (let column = 0; column < 5; column += 1) {
    const reelEl = document.createElement("div");
    reelEl.className = "slot-reel";

    for (let row = 0; row < 3; row += 1) {
      reelEl.appendChild(createSlotCell(
        grid[row][column],
        row,
        column,
        winningCells.has(`${row}-${column}`),
        scatterCellSet.has(`${row}-${column}`)
      ));
    }

    slotReelsEl.appendChild(reelEl);
  }

  slotLineEls.forEach((lineEl) => {
    const line = winningLines.find((win) => win.id === lineEl.dataset.line);
    lineEl.classList.toggle("active", Boolean(line));
    if (line) {
      lineEl.dataset.hit = `${line.count} ${slotRulesSymbolMap[line.symbol].label}`;
    } else {
      lineEl.removeAttribute("data-hit");
    }
  });
}

function createSlotCell(symbolId, row = "", column = "", winning = false, scatterHit = false) {
  const symbol = slotRulesSymbolMap[symbolId];
  const cellEl = document.createElement("div");
  cellEl.className = "slot-cell";
  cellEl.dataset.row = String(row);
  cellEl.dataset.column = String(column);
  cellEl.dataset.symbol = symbol.id;
  cellEl.setAttribute("aria-label", symbol.label);
  cellEl.innerHTML = `<span class="slot-symbol" aria-hidden="true"><span class="slot-symbol-text">${symbol.icon}</span></span>`;

  if (winning) {
    cellEl.classList.add("winning");
  }
  if (scatterHit) {
    cellEl.classList.add("scatter-hit");
  }

  return cellEl;
}

function renderSlotColumn(grid, column, winningLines = [], scatterCells = []) {
  const winningCells = new Set();
  const scatterCellSet = new Set(scatterCells.map(({ row, column: scatterColumn }) => `${row}-${scatterColumn}`));
  winningLines.forEach((line) => {
    line.cells.forEach(({ row, column: winColumn }) => winningCells.add(`${row}-${winColumn}`));
  });

  const reelEl = slotReelsEl.children[column];
  if (!reelEl) {
    return;
  }

  reelEl.className = "slot-reel";
  reelEl.innerHTML = "";
  for (let row = 0; row < 3; row += 1) {
    reelEl.appendChild(createSlotCell(
      grid[row][column],
      row,
      column,
      winningCells.has(`${row}-${column}`),
      scatterCellSet.has(`${row}-${column}`)
    ));
  }
}

function slotStepSize(stripEl) {
  const firstCell = stripEl.querySelector(".slot-cell");
  if (!firstCell) {
    return 0;
  }

  const styles = window.getComputedStyle(stripEl);
  const gap = Number.parseFloat(styles.rowGap) || 0;
  return firstCell.getBoundingClientRect().height + gap;
}

function renderSlotSpin(finalGrid) {
  slotLineEls.forEach((lineEl) => {
    lineEl.classList.remove("active");
    lineEl.removeAttribute("data-hit");
  });
  slotReelsEl.innerHTML = "";
  const stopPromises = [];

  for (let column = 0; column < 5; column += 1) {
    const reelEl = document.createElement("div");
    const stripEl = document.createElement("div");
    const leadCount = 26 + column * 6;
    const duration = 2100 + column * 430;
    reelEl.className = "slot-reel";
    stripEl.className = "slot-strip";

    const spinSymbols = [];
    for (let index = 0; index < leadCount; index += 1) {
      spinSymbols.push(weightedSlotSymbol().id);
    }
    for (let row = 0; row < 3; row += 1) {
      spinSymbols.push(finalGrid[row][column]);
    }

    spinSymbols.forEach((symbolId, index) => {
      stripEl.appendChild(createSlotCell(symbolId, index, column));
    });

    reelEl.appendChild(stripEl);
    slotReelsEl.appendChild(reelEl);

    const stopPromise = new Promise((resolve) => {
      let stopped = false;
      const stopColumn = () => {
        if (stopped) {
          return;
        }
        stopped = true;
        renderSlotColumn(finalGrid, column);
        resolve();
      };
      const fallbackTimer = window.setTimeout(stopColumn, duration + 700);

      stripEl.addEventListener("transitionend", (event) => {
        if (event.propertyName === "transform") {
          window.clearTimeout(fallbackTimer);
          stopColumn();
        }
      }, { once: true });
    });
    stopPromises.push(stopPromise);

    stripEl.style.transitionDuration = `${duration}ms`;
    window.requestAnimationFrame(() => {
      const distance = slotStepSize(stripEl) * leadCount;
      reelEl.classList.add("stopping");
      stripEl.style.transform = `translate3d(0, -${distance}px, 0)`;
    });
  }

  return Promise.all(stopPromises);
}

function readVisibleSlotGrid() {
  const grid = Array.from({ length: 3 }, () => Array(5).fill(slotRulesSymbols[0].id));
  Array.from(slotReelsEl.children).forEach((reelEl, column) => {
    Array.from(reelEl.querySelectorAll(".slot-cell")).slice(0, 3).forEach((cellEl, row) => {
      grid[row][column] = cellEl.dataset.symbol || slotRulesSymbols[0].id;
    });
  });
  return grid;
}

function updateSlotMeta() {
  const freeSpinsActive = state.slotFreeSpins > 0;
  slotModeEl.textContent = freeSpinsActive ? "Free Spins" : "Base Game";
  slotSpinStatusEl.textContent = state.slotActive
    ? "Spinning..."
    : freeSpinsActive
      ? `${state.slotFreeSpins} remaining`
      : "Ready";
  slotScatterCountEl.textContent = `${Math.min(state.slotScatterCount, 3)} / 3`;
  slotScatterFillEl.style.setProperty("--scatter-progress", `${Math.min(state.slotScatterCount, 3) / 3 * 100}%`);
  slotLastWinEl.textContent = formatDollars(state.slotLastWin);
  slotMultiplierEl.textContent = `${state.slotMultiplier}x`;
  if (slotBonusTotalEl) {
    slotBonusTotalEl.textContent = formatDollars(state.slotBonusTotal);
  }
  if (slotRtpEl) {
    slotRtpEl.textContent = `${Math.round(SLOT_RTP_TARGET * 100)}%`;
  }
  if (slotRetriggerEl) {
    slotRetriggerEl.textContent = state.slotRetriggerText || (freeSpinsActive ? "Live" : "Ready");
  }
}

function slotLineLabel(line, spinBet, bonusMultiplier = 1) {
  const symbol = slotRulesSymbolMap[line.symbol];
  const symbolNames = line.symbols
    ? line.symbols.map((symbolId) => slotRulesSymbolMap[symbolId].label).join(" + ")
    : `${line.count} ${symbol.label}`;
  const amount = spinBet * line.multiplier * bonusMultiplier;
  return `${line.name}: ${symbolNames} pays ${formatDollars(amount)}`;
}

function renderSlotPaylineSummary(resultOrLines, spinBet, bonusMultiplier = 1) {
  const lineWins = Array.isArray(resultOrLines) ? resultOrLines : resultOrLines.lineWins;
  const scatterPay = Array.isArray(resultOrLines) ? 0 : resultOrLines.scatterPay;
  const scatterCount = Array.isArray(resultOrLines) ? 0 : resultOrLines.scatterCount;
  slotPaylineListEl.innerHTML = "";

  if (!lineWins.length && !scatterPay) {
    const emptyEl = document.createElement("span");
    emptyEl.className = "slot-payline-chip empty";
    emptyEl.textContent = "No active line wins";
    slotPaylineListEl.appendChild(emptyEl);
    return;
  }

  if (scatterPay) {
    const chipEl = document.createElement("span");
    chipEl.className = "slot-payline-chip bonus";
    chipEl.textContent = `${scatterCount} Scatters pay ${formatDollars(spinBet * scatterPay * bonusMultiplier)}`;
    slotPaylineListEl.appendChild(chipEl);
  }

  lineWins.forEach((line) => {
    const chipEl = document.createElement("span");
    chipEl.className = "slot-payline-chip";
    chipEl.textContent = slotLineLabel(line, spinBet, bonusMultiplier);
    slotPaylineListEl.appendChild(chipEl);
  });
}

function renderSlotWinPanel({ title, detail, amount = 0, mode = "" }) {
  slotWinTitleEl.textContent = title;
  slotWinDetailEl.textContent = detail;
  slotWinAmountEl.textContent = formatDollars(amount);
  slotWinPanelEl.classList.remove("win", "bonus");
  if (mode) {
    replayAnimation(slotWinPanelEl, mode);
  }
}

function createSlotCoins(count = 12) {
  slotCabinetEl.querySelectorAll(".slot-coin").forEach((coinEl) => coinEl.remove());
  for (let index = 0; index < count; index += 1) {
    const coinEl = document.createElement("span");
    const x = Math.round((Math.random() - 0.5) * 360);
    const y = Math.round(-70 - Math.random() * 150);
    coinEl.className = "slot-coin";
    coinEl.style.setProperty("--coin-x", `${x}px`);
    coinEl.style.setProperty("--coin-y", `${y}px`);
    coinEl.style.animationDelay = `${index * 34}ms`;
    slotCabinetEl.appendChild(coinEl);
  }

  window.setTimeout(() => {
    slotCabinetEl.querySelectorAll(".slot-coin").forEach((coinEl) => coinEl.remove());
  }, 1250);
}

function animateSlotWinAmount(amount) {
  const steps = 18;
  let step = 0;
  const timer = window.setInterval(() => {
    step += 1;
    slotLastWinEl.textContent = formatDollars(amount * (step / steps));
    if (step >= steps) {
      window.clearInterval(timer);
      slotLastWinEl.textContent = formatDollars(amount);
    }
  }, 28);
}

function startFreeSpins(count, multiplier) {
  state.slotFreeSpins += count;
  state.slotMultiplier = Math.max(state.slotMultiplier, multiplier);
  state.slotBonusTotal = 0;
  state.slotRetriggerText = `${count} spins`;
  showResult("Free spins unlocked", `${count} free spins at ${state.slotMultiplier}x are loaded.`);
  updateSlotMeta();
}

function finishSlotSpin(grid, result, wasFreeSpin, spinBet) {
  const balanceBefore = state.credits;
  const bonusBeforeSpin = wasFreeSpin
    ? {
        freeSpins: state.slotFreeSpins,
        multiplier: state.slotMultiplier,
        totalWin: state.slotBonusTotal
      }
    : null;
  const settlement = settleSlotRulesMath({ result, bet: spinBet, bonus: bonusBeforeSpin });
  const { payout, activeMultiplier } = settlement;
  const winTier = settlement.tier;
  state.slotActive = false;
  state.slotScatterCount = result.scatterCount;
  state.slotLastWin = payout;
  state.slotRetriggerText = "";

  const highlightedScatters = result.scatterCount >= 2 ? result.scatterCells : [];
  renderSlotGrid(grid, result.lineWins, highlightedScatters);
  renderSlotPaylineSummary(result, spinBet, activeMultiplier);
  animateSlotWinAmount(payout);

  if (!wasFreeSpin) {
    state.credits -= spinBet;
  } else {
    state.slotFreeSpins = settlement.nextBonus?.freeSpins ?? 0;
    state.slotMultiplier = settlement.nextBonus?.multiplier ?? state.slotMultiplier;
    state.slotBonusTotal = settlement.nextBonus?.totalWin ?? state.slotBonusTotal;
  }

  if (settlement.trigger) {
    startFreeSpins(settlement.trigger.freeSpins, settlement.trigger.multiplier);
  } else if (settlement.retrigger) {
    state.slotRetriggerText = `+${settlement.retrigger.freeSpins} spins`;
  }

  if (payout > 0) {
    state.credits += payout;
    state.streak += 1;
    state.wins += 1;
    const lineNames = result.lineWins.map((line) => line.name).join(", ");
    const title = winTierTitle(winTier);
    const winSource = [
      lineNames,
      result.scatterPay ? `${result.scatterCount} scatters` : ""
    ].filter(Boolean).join(" + ") || "Bonus";
    const retriggerCopy = settlement.retrigger ? ` Retriggered ${settlement.retrigger.freeSpins} spins.` : "";
    const triggerCopy = settlement.trigger ? ` Free spins loaded: ${settlement.trigger.freeSpins} at ${settlement.trigger.multiplier}x.` : "";
    showResult(title, `${winSource} paid ${formatDollars(payout)}${wasFreeSpin ? " in free spins" : ""}.${triggerCopy}${retriggerCopy}`);
    renderSlotWinPanel({
      title,
      detail: `${result.totalWays} way${result.totalWays === 1 ? "" : "s"} paid at ${activeMultiplier}x.${triggerCopy}${retriggerCopy}`,
      amount: payout,
      mode: winTier === "jackpot" || winTier === "mega" ? "bonus" : "win"
    });
    pulseStats(creditsStatEl, streakStatEl, recordStatEl);
    playOutcomeEffect("win");
    createSlotCoins(winTier === "jackpot" ? 30 : winTier === "mega" ? 24 : winTier === "big" ? 18 : 10);
    if (["big", "mega", "jackpot"].includes(winTier) || result.lineWins.some((line) => ["jackpot", "royal"].includes(slotRulesSymbolMap[line.symbol].tier) && line.count === 5)) {
      replayAnimation(slotCabinetEl, "big-win");
    }
  } else if (settlement.trigger) {
    state.streak += 1;
    state.wins += 1;
    showResult("Scatter bonus", "Free spins are ready. The next spins are on the house.");
    renderSlotWinPanel({
      title: "Scatter bonus",
      detail: `${result.scatterCount} scatters awarded ${result.freeSpinsAwarded} free spins at ${result.bonusMultiplier}x.`,
      amount: 0,
      mode: "bonus"
    });
    pulseStats(streakStatEl, recordStatEl);
    playOutcomeEffect("push");
    createSlotCoins(8);
  } else if (settlement.retrigger) {
    state.streak += 1;
    state.wins += 1;
    showResult("Retrigger", `${settlement.retrigger.freeSpins} more free spins added at ${settlement.retrigger.multiplier}x.`);
    renderSlotWinPanel({
      title: "Retrigger",
      detail: `${result.scatterCount} scatters extended the bonus.`,
      amount: 0,
      mode: "bonus"
    });
    pulseStats(streakStatEl, recordStatEl);
    playOutcomeEffect("push");
    createSlotCoins(8);
  } else if (wasFreeSpin) {
    if (state.slotFreeSpins > 0) {
      showResult("Free spin", "No line hit. Your bonus spins continue.");
      renderSlotWinPanel({
        title: "No line hit",
        detail: `${state.slotFreeSpins} bonus spin${state.slotFreeSpins === 1 ? "" : "s"} remaining.`,
        amount: 0
      });
    } else {
      state.slotMultiplier = 1;
      state.slotRetriggerText = "Ended";
      showResult("Bonus ended", "Free spins are complete. Back to the base game.");
      renderSlotWinPanel({
        title: "Bonus ended",
        detail: `Bonus total: ${formatDollars(state.slotBonusTotal)}.`,
        amount: 0
      });
    }
    playOutcomeEffect("push");
  } else {
    const nearMiss = result.scatterCount === 2 ? " Two scatters teased the bonus." : "";
    state.streak = 0;
    state.losses += 1;
    showResult("No win", `You lost ${formatDollars(spinBet)}.${nearMiss}`);
    renderSlotWinPanel({
      title: result.scatterCount === 2 ? "Near bonus" : "No win",
      detail: result.scatterCount === 2 ? "Two scatters landed. One more would start free spins." : "No active payline matched from the left.",
      amount: 0,
      mode: result.scatterCount === 2 ? "bonus" : ""
    });
    pulseStats(creditsStatEl, streakStatEl, recordStatEl);
    playOutcomeEffect("loss");
  }

  if (state.slotFreeSpins === 0 && !settlement.trigger) {
    state.slotMultiplier = 1;
  }

  updateSlotMeta();
  const lineNames = result.lineWins.map((line) => line.name);
  const slotEvent = buildEvent({
    game: "slots",
    eventType: settlement.trigger && payout === 0 ? "bonus_awarded" : (wasFreeSpin ? "free_spin_settled" : "wager_settled"),
    outcome: payout > 0 ? "win" : (settlement.trigger || settlement.retrigger ? "bonus" : (state.credits < balanceBefore ? "loss" : "push")),
    betAmount: wasFreeSpin ? 0 : spinBet,
    payoutAmount: payout,
    balanceBefore,
    balanceAfter: state.credits,
    details: {
      free_spin: wasFreeSpin,
      line_wins: lineNames,
      paylines_hit: lineNames.length,
      scatter_count: result.scatterCount,
      scatter_triggered: result.scatterTriggered,
      free_spins_awarded: result.freeSpinsAwarded,
      free_spins_remaining: state.slotFreeSpins,
      bonus_total: state.slotBonusTotal,
      retriggered: Boolean(settlement.retrigger),
      win_tier: winTier,
      multiplier: activeMultiplier,
      grid
    }
  });
  savePlayerBalance(slotEvent);
  render();
}

function spinSlots() {
  if (state.slotActive) {
    return;
  }

  const wasFreeSpin = state.slotFreeSpins > 0;
  const spinBet = state.bet;
  if (!wasFreeSpin && state.credits < spinBet) {
    showResult("Bankroll low", "Lower the bet or reset your bankroll.");
    return;
  }

  resetEffects();
  state.slotActive = true;
  state.slotRound += 1;
  const round = state.slotRound;
  state.slotLastWin = 0;
  slotSpinStatusEl.textContent = wasFreeSpin ? "Bonus spin..." : "Spinning...";
  slotLastWinEl.textContent = "$0";
  renderSlotPaylineSummary([], spinBet);
  renderSlotWinPanel({
    title: "Reels spinning",
    detail: wasFreeSpin ? `Bonus spin at ${state.slotMultiplier}x.` : "Waiting for the reels to stop.",
    amount: 0
  });
  showResult("Reels spinning", wasFreeSpin ? `${state.slotFreeSpins} free spins remaining at ${state.slotMultiplier}x.` : `${formatDollars(spinBet)} spin in progress.`);

  const grid = generateSlotGrid({ nearMiss: true, assistSmallWin: true });

  renderSlotSpin(grid).then(() => {
    if (round !== state.slotRound) {
      return;
    }

    const visibleGrid = readVisibleSlotGrid();
    const visibleResult = evaluateSlotGrid(visibleGrid);
    finishSlotSpin(visibleGrid, visibleResult, wasFreeSpin, spinBet);
  });
  render();
}

function dealFromDeck(cardEl, delay = 0) {
  const deckRect = deckShoeEl.getBoundingClientRect();
  const cardRect = cardEl.getBoundingClientRect();
  const deckX = deckRect.left + deckRect.width / 2;
  const deckY = deckRect.top + deckRect.height / 2;
  const cardX = cardRect.left + cardRect.width / 2;
  const cardY = cardRect.top + cardRect.height / 2;

  cardEl.style.setProperty("--deal-x", `${deckX - cardX}px`);
  cardEl.style.setProperty("--deal-y", `${deckY - cardY}px`);
  cardEl.style.animationDelay = `${delay}ms`;
  replayAnimation(cardEl, "dealt");
}

function highlightWinner(cardEl, delay = 0) {
  window.setTimeout(() => {
    cardEl.classList.remove("dealt");
    replayAnimation(cardEl, "winner");
  }, delay + 460);
}

function drawCard() {
  return {
    rank: ranks[Math.floor(Math.random() * ranks.length)],
    suit: suits[Math.floor(Math.random() * suits.length)]
  };
}

function createCard(card, hidden = false) {
  const cardEl = document.createElement("div");
  cardEl.className = hidden ? "card back" : "card";
  cardEl.style.setProperty("--tilt", `${Math.floor(Math.random() * 7) - 3}deg`);

  if (hidden) {
    cardEl.innerHTML = cardBackBrandMarkup;
    return cardEl;
  }

  cardEl.classList.toggle("red", card.suit.color === "red");
  cardEl.innerHTML = `
    <div class="corner top"><span>${card.rank.label}</span><span>${card.suit.label}</span></div>
    ${cardMarkMarkup}
    <div class="rank">${card.rank.label}</div>
    <div class="suit">${card.suit.label}</div>
    <div class="corner bottom"><span>${card.rank.label}</span><span>${card.suit.label}</span></div>
  `;
  return cardEl;
}

function revealCard(cardEl, card) {
  const tilt = cardEl.style.getPropertyValue("--tilt");
  cardEl.classList.remove("back");
  replayAnimation(cardEl, "revealing");
  window.setTimeout(() => {
    const freshCard = createCard(card);
    cardEl.replaceChildren(...freshCard.childNodes);
    cardEl.className = freshCard.className;
    cardEl.style.setProperty("--tilt", tilt || freshCard.style.getPropertyValue("--tilt"));
    replayAnimation(cardEl, "revealing");
    clearAnimationClass(cardEl, "revealing", 560);
  }, 260);
}

function renderCard(cardEl, card, delay = 0) {
  cardEl.replaceChildren(...createCard(card).childNodes);
  cardEl.className = "card";
  cardEl.classList.toggle("red", card.suit.color === "red");
  cardEl.classList.remove("winner");
  requestAnimationFrame(() => dealFromDeck(cardEl, delay));
}

function handTotal(hand) {
  let total = hand.reduce((sum, card) => sum + card.rank.blackjack, 0);
  let aces = hand.filter((card) => card.rank.label === "A").length;

  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }

  return total;
}

function isBlackjack(hand) {
  return hand.length === 2 && handTotal(hand) === 21;
}

function clampBet() {
  const currentMax = maxBet();
  state.bet = Math.max(5, Math.min(state.bet, currentMax || 5));
  betEl.textContent = formatDollars(state.bet);

  if (state.bet !== state.renderedBet) {
    state.renderedBet = state.bet;
    replayAnimation(betBoxEl, "pop");
  }
}

function formatDollars(value) {
  const amount = Number.isInteger(value) ? value : value.toFixed(2);
  return `$${amount}`;
}

let balanceSaveTimer = null;
let dashboardModel = null;
let activityFilter = "all";

function gameEventKey(game = state.game) {
  return game === "high-card" ? "high_card" : game;
}

function clientEventId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (char) =>
    (Number(char) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(char) / 4).toString(16)
  );
}

function cardCode(card) {
  return `${card.rank.label}${card.suit.label}`;
}

function buildEvent({
  game = gameEventKey(),
  eventType = "wager_settled",
  outcome,
  betAmount = state.bet,
  payoutAmount = 0,
  balanceBefore,
  balanceAfter,
  details = {}
}) {
  return {
    username: state.username,
    game,
    event_type: eventType,
    outcome,
    bet_amount: Math.max(0, Math.round(betAmount)),
    payout_amount: Math.max(0, Math.round(payoutAmount)),
    net_change: Math.round(balanceAfter - balanceBefore),
    balance_before: Math.max(0, Math.round(balanceBefore)),
    balance_after: Math.max(0, Math.round(balanceAfter)),
    client_event_id: clientEventId(),
    details
  };
}

async function refreshLeaderboard() {
  await renderLeaderboard({
    listEl: leaderboardListEl,
    statusEl: leaderboardStatusEl,
    currentUsername: state.username,
    rows: dashboardModel?.players ?? null
  });
}

async function refreshRecentEvents() {
  await renderRecentEvents({
    listEl: activityListEl,
    statusEl: activityStatusEl,
    events: dashboardModel?.recentEvents ?? null,
    filter: activityFilter
  });
}

async function refreshDashboard() {
  dashboardModel = await renderGamblingDashboard({
    statusEl: dashboardStatusEl,
    kpiEl: dashboardKpiEl,
    netChartEl,
    mixChartEl,
    gameChartEl
  });
}

async function refreshStatsSection() {
  await refreshDashboard();
  await Promise.all([
    refreshLeaderboard(),
    refreshRecentEvents()
  ]);
}

function recordGamblingEvent(event) {
  if (!event?.username) {
    return;
  }

  insertGamblingEvent(event)
    .then(refreshStatsSection)
    .catch((error) => {
      console.warn("Gambling event save failed:", error.message);
    });
}

async function loadPlayerBalance() {
  if (!state.username) {
    return;
  }

  state.balanceLoading = true;
  showResult("Loading bankroll", "Pulling your live balance from Supabase.");
  render();

  try {
    state.credits = await getPlayerBalance(state.username);
    state.balanceLoading = false;
    state.bet = Math.max(5, Math.min(state.bet, maxBet() || 5));
    showResult("Bankroll loaded", `${state.username} has ${formatDollars(state.credits)} ready to play.`);
    render();
    await refreshStatsSection();
  } catch (error) {
    state.balanceLoading = false;
    showResult("Balance error", error.message);
    render();
  }
}

function savePlayerBalance(event = null) {
  if (!state.username || state.balanceLoading) {
    return;
  }

  if (event) {
    (async () => {
      try {
        await persistPlayerBalance(state.username, state.credits);
        await insertGamblingEvent(event);
        await refreshStatsSection();
      } catch (error) {
        console.warn("Balance/event save failed:", error.message);
      }
    })();
    return;
  }

  window.clearTimeout(balanceSaveTimer);
  balanceSaveTimer = window.setTimeout(async () => {
    try {
      await persistPlayerBalance(state.username, state.credits);
      await refreshStatsSection();
    } catch (error) {
      console.warn("Balance save failed:", error.message);
    }
  }, 250);
}

function totalStateClass(hand, hidden = false) {
  if (!hand.length) {
    return "";
  }

  const total = handTotal(hand);
  if (!hidden && isBlackjack(hand)) {
    return "blackjack";
  }
  if (total > 21) {
    return "bust";
  }
  if (total >= 18) {
    return "hot";
  }
  return "safe";
}

function updateTotalBadge(badgeEl, hand, hidden = false) {
  const visibleHand = hidden ? hand.slice(0, 1) : hand;
  const total = visibleHand.length ? handTotal(visibleHand) : "--";
  const isWinner = badgeEl.classList.contains("winner");
  const isLoser = badgeEl.classList.contains("loser");
  badgeEl.textContent = total;
  badgeEl.className = "total-badge";

  const stateClass = totalStateClass(visibleHand, hidden);
  if (stateClass) {
    badgeEl.classList.add(stateClass);
  }
  if (isWinner) {
    badgeEl.classList.add("winner");
  }
  if (isLoser) {
    badgeEl.classList.add("loser");
  }
}

function updateBlackjackTotals() {
  updateTotalBadge(dealerTotalEl, state.dealerHand, state.hideDealerHole);
  updateTotalBadge(playerTotalEl, state.playerHand, false);
}

function appendBlackjackCard(hand, card, options = {}) {
  const cardEl = createCard(card, options.hidden);
  const target = hand === "dealer" ? dealerHandEl : playerHandEl;
  target.appendChild(cardEl);
  blackjackCards[hand].push({ card, cardEl, hidden: Boolean(options.hidden) });
  requestAnimationFrame(() => dealFromDeck(cardEl, options.delay || 0));
  updateBlackjackTotals();
  return cardEl;
}

function revealDealerHoleCard() {
  const hole = blackjackCards.dealer[1];
  if (!hole || !hole.hidden) {
    state.hideDealerHole = false;
    updateBlackjackTotals();
    return;
  }

  state.hideDealerHole = false;
  hole.hidden = false;
  revealCard(hole.cardEl, hole.card);
  updateBlackjackTotals();
}

function clearBlackjackTable() {
  dealerHandEl.innerHTML = "";
  playerHandEl.innerHTML = "";
  blackjackCards.dealer = [];
  blackjackCards.player = [];
  dealerTotalEl.textContent = "--";
  playerTotalEl.textContent = "--";
  dealerTotalEl.className = "total-badge";
  playerTotalEl.className = "total-badge";
}

function render() {
  creditsEl.textContent = formatDollars(state.credits);
  streakEl.textContent = state.streak;
  winsEl.textContent = state.wins;
  lossesEl.textContent = state.losses;
  clampBet();

  tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.game === state.game));
  tabs.forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.game === state.game));
    tab.disabled = state.balanceLoading || ((state.blackjackActive || state.rouletteActive || state.slotActive || state.slotFreeSpins > 0) && tab.dataset.game !== state.game);
  });
  Object.entries(panels).forEach(([game, panel]) => {
    panel.classList.toggle("active", game === state.game);
  });
  deckShoeEl.hidden = state.game === "roulette" || state.game === "slots";

  const outOfCredits = state.credits < 5;
  const balanceLoading = state.balanceLoading;
  const slotBonusLocked = state.slotActive || state.slotFreeSpins > 0;
  const lockedBet = state.blackjackActive || state.blackjackResolving || state.rouletteActive || slotBonusLocked;
  const canUseFreeSpin = state.game === "slots" && state.slotFreeSpins > 0;
  dealButton.hidden = state.game === "blackjack" && state.blackjackActive;
  hitButton.hidden = state.game !== "blackjack" || (!state.blackjackActive && !state.blackjackResolving);
  standButton.hidden = state.game !== "blackjack" || (!state.blackjackActive && !state.blackjackResolving);
  dealButton.disabled = balanceLoading || (outOfCredits && !canUseFreeSpin) || state.blackjackResolving || state.rouletteActive || state.slotActive;
  hitButton.disabled = balanceLoading || outOfCredits || !state.blackjackActive || state.blackjackResolving;
  standButton.disabled = balanceLoading || outOfCredits || !state.blackjackActive || state.blackjackResolving;
  lowerBetButton.disabled = balanceLoading || state.bet <= 5 || outOfCredits || lockedBet;
  raiseBetButton.disabled = balanceLoading || state.bet >= maxBet() || outOfCredits || lockedBet;
  minBetButton.disabled = balanceLoading || outOfCredits || lockedBet || state.bet <= 5;
  maxBetButton.disabled = balanceLoading || outOfCredits || lockedBet || state.bet >= maxBet();
  resetButton.disabled = balanceLoading || lockedBet;
  chipButtons.forEach((button) => {
    button.disabled = balanceLoading || outOfCredits || lockedBet || state.bet >= maxBet();
  });
  roulettePickButtons.forEach((button) => {
    const isActive = button.dataset.rouletteType === state.rouletteBetType &&
      button.dataset.rouletteValue === String(state.rouletteChoice);
    button.classList.toggle("active", isActive);
    button.disabled = balanceLoading || state.rouletteActive;
  });

  const meta = gameMeta[state.game];
  dealButton.textContent = meta.action;
  gameCopyEl.textContent = meta.activeCopy || meta.copy;
  updateSlotMeta();

  if (!balanceLoading && outOfCredits && !canUseFreeSpin) {
    showResult("Bankroll empty", "Reset your fictional dollars to play another round.");
  }
}

function canChangeBet() {
  return !state.balanceLoading && state.credits >= 5 && !state.blackjackActive && !state.blackjackResolving && !state.rouletteActive && !state.slotActive && state.slotFreeSpins === 0;
}

function changeBet(amount) {
  if (!canChangeBet()) {
    return;
  }

  if ((amount < 0 && state.bet <= 5) || (amount > 0 && state.bet >= maxBet())) {
    return;
  }

  state.bet = Math.max(5, Math.min(state.bet + amount, maxBet()));
  render();
}

function setBet(amount) {
  if (!canChangeBet()) {
    return;
  }

  state.bet = Math.max(5, Math.min(amount, maxBet()));
  render();
}

function bindHoldToRepeat(button, amount) {
  let repeatTimer;
  let repeatDelay;

  const stop = () => {
    clearTimeout(repeatDelay);
    clearInterval(repeatTimer);
  };

  button.addEventListener("pointerdown", () => {
    changeBet(amount);
    stop();
    repeatDelay = setTimeout(() => {
      repeatTimer = setInterval(() => changeBet(amount), 80);
    }, 280);
  });

  button.addEventListener("pointerup", stop);
  button.addEventListener("pointercancel", stop);
  button.addEventListener("pointerleave", stop);
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      changeBet(amount);
    }
  });
}

function settleWin(amount, title, copy, options = {}) {
  const balanceBefore = state.credits;
  const payoutAmount = Math.round(amount);
  state.credits += payoutAmount;
  state.streak += 1;
  state.wins += 1;
  showResult(title, copy);
  pulseStats(creditsStatEl, streakStatEl, recordStatEl);
  playOutcomeEffect("win", state.game === "blackjack" ? "player" : null);
  savePlayerBalance(buildEvent({
    outcome: "win",
    betAmount: options.betAmount ?? state.bet,
    payoutAmount,
    balanceBefore,
    balanceAfter: state.credits,
    details: options.details ?? {}
  }));
}

function settleLoss(title, copy, options = {}) {
  const balanceBefore = state.credits;
  state.credits -= state.bet;
  state.streak = 0;
  state.losses += 1;
  showResult(title, copy);
  pulseStats(creditsStatEl, streakStatEl, recordStatEl);
  playOutcomeEffect("loss", state.game === "blackjack" ? "dealer" : null);
  savePlayerBalance(buildEvent({
    outcome: "loss",
    betAmount: options.betAmount ?? state.bet,
    payoutAmount: 0,
    balanceBefore,
    balanceAfter: state.credits,
    details: options.details ?? {}
  }));
}

function recordPush(details = {}) {
  recordGamblingEvent(buildEvent({
    outcome: "push",
    payoutAmount: 0,
    balanceBefore: state.credits,
    balanceAfter: state.credits,
    details
  }));
}

function dealHighCard() {
  resetEffects();
  const playerCard = drawCard();
  const houseCard = drawCard();

  renderCard(playerCardEl, playerCard, 0);
  renderCard(houseCardEl, houseCard, 130);

  if (playerCard.rank.value > houseCard.rank.value) {
    settleWin(state.bet, "You win", `You earned ${formatDollars(state.bet)}.`, {
      details: {
        player_card: cardCode(playerCard),
        house_card: cardCode(houseCard)
      }
    });
    highlightWinner(playerCardEl, 0);
  } else if (playerCard.rank.value < houseCard.rank.value) {
    settleLoss("House wins", `You lost ${formatDollars(state.bet)}.`, {
      details: {
        player_card: cardCode(playerCard),
        house_card: cardCode(houseCard)
      }
    });
    highlightWinner(houseCardEl, 130);
  } else {
    state.streak = 0;
    showResult("Push", "Same rank. Your bet comes back.");
    pulseStats(streakStatEl);
    playOutcomeEffect("push");
    recordPush({
      player_card: cardCode(playerCard),
      house_card: cardCode(houseCard)
    });
  }

  render();
}

function startBlackjack() {
  resetEffects();
  clearBlackjackTable();
  state.blackjackRound += 1;
  const round = state.blackjackRound;
  state.blackjackActive = true;
  state.blackjackResolving = false;
  state.hideDealerHole = true;
  state.dealerHand = [drawCard(), drawCard()];
  state.playerHand = [drawCard(), drawCard()];
  showResult("Blackjack dealt", "Hit to draw or stand to hold.");

  appendBlackjackCard("player", state.playerHand[0], { delay: 0 });
  appendBlackjackCard("dealer", state.dealerHand[0], { delay: 120 });
  appendBlackjackCard("player", state.playerHand[1], { delay: 240 });
  appendBlackjackCard("dealer", state.dealerHand[1], { delay: 360, hidden: true });

  const playerNatural = isBlackjack(state.playerHand);
  const dealerNatural = isBlackjack(state.dealerHand);

  if (playerNatural || dealerNatural) {
    state.blackjackActive = false;
    window.setTimeout(() => {
      if (round === state.blackjackRound) {
        revealDealerHoleCard();
      }
    }, 780);

    if (playerNatural && dealerNatural) {
      state.streak = 0;
      showResult("Push", "Both hands have blackjack. Your bet comes back.");
      pulseStats(streakStatEl);
      playOutcomeEffect("push");
      recordPush({
        player_total: handTotal(state.playerHand),
        dealer_total: handTotal(state.dealerHand),
        player_blackjack: true,
        dealer_blackjack: true
      });
    } else if (playerNatural) {
      const payout = Math.round(state.bet * 1.5);
      settleWin(payout, "Blackjack", `Natural blackjack pays ${formatDollars(payout)}.`, {
        details: {
          player_total: handTotal(state.playerHand),
          dealer_total: handTotal(state.dealerHand),
          player_blackjack: true
        }
      });
    } else {
      settleLoss("Dealer blackjack", `You lost ${formatDollars(state.bet)}.`, {
        details: {
          player_total: handTotal(state.playerHand),
          dealer_total: handTotal(state.dealerHand),
          dealer_blackjack: true
        }
      });
    }
  }

  render();
}

function hitBlackjack() {
  const card = drawCard();
  state.playerHand.push(card);
  appendBlackjackCard("player", card);

  if (handTotal(state.playerHand) > 21) {
    state.blackjackActive = false;
    state.blackjackResolving = true;
    const round = state.blackjackRound;
    showResult("Bust", "Resolving hand...");
    render();

    window.setTimeout(() => {
      if (round !== state.blackjackRound || !state.blackjackResolving) {
        return;
      }

      state.blackjackResolving = false;
      revealDealerHoleCard();
      settleLoss("Bust", `You went over 21 and lost ${formatDollars(state.bet)}.`, {
        details: {
          player_total: handTotal(state.playerHand),
          dealer_total: handTotal(state.dealerHand),
          player_bust: true
        }
      });
      render();
    }, 650);
    return;
  }

  render();
}

function standBlackjack() {
  revealDealerHoleCard();
  let delay = 220;

  while (handTotal(state.dealerHand) < 17) {
    const card = drawCard();
    state.dealerHand.push(card);
    appendBlackjackCard("dealer", card, { delay });
    delay += 120;
  }

  const playerTotal = handTotal(state.playerHand);
  const dealerTotal = handTotal(state.dealerHand);
  state.blackjackActive = false;

  if (dealerTotal > 21) {
    settleWin(state.bet, "Dealer busts", `You earned ${formatDollars(state.bet)}.`, {
      details: {
        player_total: playerTotal,
        dealer_total: dealerTotal,
        dealer_bust: true
      }
    });
  } else if (playerTotal > dealerTotal) {
    settleWin(state.bet, "You win", `${playerTotal} beats ${dealerTotal}. You earned ${formatDollars(state.bet)}.`, {
      details: {
        player_total: playerTotal,
        dealer_total: dealerTotal
      }
    });
  } else if (playerTotal < dealerTotal) {
    settleLoss("Dealer wins", `${dealerTotal} beats ${playerTotal}. You lost ${formatDollars(state.bet)}.`, {
      details: {
        player_total: playerTotal,
        dealer_total: dealerTotal
      }
    });
  } else {
    state.streak = 0;
    showResult("Push", `${playerTotal} ties ${dealerTotal}. Your bet comes back.`);
    pulseStats(streakStatEl);
    playOutcomeEffect("push");
    recordPush({
      player_total: playerTotal,
      dealer_total: dealerTotal
    });
  }

  render();
}

function rouletteBetLabel() {
  return state.rouletteBetType === "number"
    ? `number ${state.rouletteChoice}`
    : state.rouletteChoice;
}

function selectRouletteBet(type, value) {
  if (state.rouletteActive) {
    return;
  }

  state.rouletteBetType = type;
  state.rouletteChoice = type === "number" ? Number(value) : value;
  showResult("Roulette", `Betting on ${rouletteBetLabel()}.`);
  render();
}

function spinRoulette() {
  if (state.rouletteActive) {
    return;
  }

  resetEffects();
  state.rouletteActive = true;
  rouletteResultEl.textContent = "--";
  rouletteResultEl.className = "roulette-result";
  showResult("Wheel spinning", `Your ${formatDollars(state.bet)} bet is on ${rouletteBetLabel()}.`);

  const pocketIndex = Math.floor(Math.random() * rouletteNumbers.length);
  const number = rouletteNumbers[pocketIndex];
  const color = rouletteColor(number);
  const segment = 360 / rouletteNumbers.length;
  const targetAngle = pocketIndex * segment + segment / 2;
  const wheelSpins = 4 + Math.floor(Math.random() * 2);
  const ballSpins = 7 + Math.floor(Math.random() * 2);
  const wheelTargetAngle = -targetAngle;
  const ballTargetAngle = 0;

  state.rouletteWheelRotation = nextClockwiseRotation(state.rouletteWheelRotation, wheelTargetAngle, wheelSpins);
  state.rouletteBallRotation = nextCounterClockwiseRotation(state.rouletteBallRotation, ballTargetAngle, ballSpins);
  rouletteWheelEl.style.transform = `rotate(${state.rouletteWheelRotation}deg)`;
  rouletteBallTrackEl.style.transform = `rotate(${state.rouletteBallRotation}deg)`;
  render();

  window.setTimeout(() => {
    const won = state.rouletteBetType === "number"
      ? number === state.rouletteChoice
      : color === state.rouletteChoice;
    const payout = state.rouletteBetType === "number" ? state.bet * 35 : state.bet;

    state.rouletteActive = false;
    rouletteResultEl.textContent = number;
    rouletteResultEl.className = `roulette-result ${color}`;
    replayAnimation(rouletteResultEl, "pop");

    if (won) {
      settleWin(payout, `${color.toUpperCase()} ${number}`, `Roulette pays ${formatDollars(payout)}.`, {
        details: {
          bet_type: state.rouletteBetType,
          bet_value: state.rouletteChoice,
          result_number: number,
          result_color: color
        }
      });
    } else {
      settleLoss(`${color.toUpperCase()} ${number}`, `You lost ${formatDollars(state.bet)} on ${rouletteBetLabel()}.`, {
        details: {
          bet_type: state.rouletteBetType,
          bet_value: state.rouletteChoice,
          result_number: number,
          result_color: color
        }
      });
    }

    render();
  }, 4550);
}

function switchGame(game) {
  if (state.blackjackActive || state.rouletteActive || state.slotActive || state.slotFreeSpins > 0) {
    return;
  }

  state.game = game;
  resetEffects();
  showResult(gameMeta[game].title, gameMeta[game].copy);
  render();
}

initializeRouletteUi();
renderSlotGrid(generateSlotGrid());
updateSlotMeta();

tabs.forEach((tab) => {
  tab.addEventListener("click", () => switchGame(tab.dataset.game));
});

bindHoldToRepeat(lowerBetButton, -5);
bindHoldToRepeat(raiseBetButton, 5);

chipButtons.forEach((button) => {
  button.addEventListener("click", () => setBet(Number(button.dataset.chip)));
});

roulettePickButtons.forEach((button) => {
  button.addEventListener("click", () => selectRouletteBet(button.dataset.rouletteType, button.dataset.rouletteValue));
});

activityTabs.forEach((button) => {
  button.addEventListener("click", async () => {
    activityFilter = button.dataset.activityFilter || "all";
    activityTabs.forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    await refreshRecentEvents();
  });
});

minBetButton.addEventListener("click", () => setBet(5));
maxBetButton.addEventListener("click", () => setBet(maxBet()));

dealButton.addEventListener("click", () => {
  if (state.game === "high-card") {
    dealHighCard();
  } else if (state.game === "blackjack") {
    startBlackjack();
  } else if (state.game === "roulette") {
    spinRoulette();
  } else {
    spinSlots();
  }
});

hitButton.addEventListener("click", hitBlackjack);
standButton.addEventListener("click", standBlackjack);

resetButton.addEventListener("click", () => {
  const balanceBefore = state.credits;
  state.credits = DEFAULT_BALANCE;
  state.bet = 5;
  state.streak = 0;
  state.wins = 0;
  state.losses = 0;
  state.blackjackActive = false;
  state.blackjackResolving = false;
  state.rouletteActive = false;
  state.rouletteBetType = "color";
  state.rouletteChoice = "red";
  state.slotActive = false;
  state.slotFreeSpins = 0;
  state.slotMultiplier = 1;
  state.slotLastWin = 0;
  state.slotScatterCount = 0;
  state.slotBonusTotal = 0;
  state.slotRetriggerText = "";
  state.slotRound += 1;
  state.dealerHand = [];
  state.playerHand = [];
  state.hideDealerHole = false;
  state.blackjackRound += 1;
  clearBlackjackTable();
  resetEffects();
  rouletteResultEl.textContent = "--";
  rouletteResultEl.className = "roulette-result";
  playerCardEl.classList.remove("winner");
  houseCardEl.classList.remove("winner");
  renderSlotGrid(generateSlotGrid());
  renderSlotPaylineSummary([], state.bet);
  renderSlotWinPanel({
    title: "Ready to spin",
    detail: "Awaiting result.",
    amount: 0
  });
  updateSlotMeta();
  showResult("Place a bet", "Choose High Card, Blackjack, Roulette, or Slots to begin.");
  pulseStats(creditsStatEl, streakStatEl, recordStatEl);
  savePlayerBalance(buildEvent({
    game: "system",
    eventType: "bankroll_reset",
    outcome: "reset",
    betAmount: 0,
    payoutAmount: 0,
    balanceBefore,
    balanceAfter: state.credits,
    details: {
      reason: "manual_reset"
    }
  }));
  render();
});

render();
loadPlayerBalance();
