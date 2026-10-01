import { expireDueHolds } from "./holdService";

const TICK_MS = 1000;

let timer: NodeJS.Timeout | null = null;

let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const expired = await expireDueHolds();
    if (expired > 0) {
      console.log(`[worker] ${expired} hold(s) expire , pair move forward`);
    }
  } catch (err) {
    console.error("[worker] expiry round fail :", (err as Error).message);
  } finally {
    busy = false;
  }
}

export function startWorker() {
  if (timer) return; // dobara start na ho
  timer = setInterval(() => void tick(), TICK_MS);
  console.log(`[worker] expiry loop start (each ${TICK_MS / 1000}s)`);
}

export function stopWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}