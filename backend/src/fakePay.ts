import { Router } from "express";
import { randomUUID } from "crypto";
import { HOLD_MS } from "./db";

// ---- Config ----
const PORT = Number(process.env.PORT ?? 4000);
export const WEBHOOK_URL =
  process.env.WEBHOOK_URL ?? `http://localhost:${PORT}/webhooks/payment`;

export const WEBHOOK_SECRET = "fakepay_test_secret";

type EventType = "payment.processing" | "payment.succeeded";
type Mode = "clean" | "duplicate" | "reorder" | "late" | "random";

interface PaymentEvent {
  eventId: string;
  type: EventType;
  paymentId: string;
  holdId: number;
  createdAt: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);
const between = (min: number, max: number) => min + Math.random() * (max - min);

// ---- Webhook send ----
async function deliver(event: PaymentEvent, attempt = 1): Promise<void> {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fakepay-secret": WEBHOOK_SECRET,
      },
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error(`app status ${res.status} diya`);
  } catch (err) {
    if (attempt >= 3) {
      console.log(`[fakepay] ${event.type} (${event.eventId}) not deliever:`, (err as Error).message);
      return;
    }
    await sleep(1000 * attempt);
    return deliver(event, attempt + 1);
  }
}

function makeEvent(type: EventType, paymentId: string, holdId: number): PaymentEvent {
  return {
    eventId: `evt_${randomUUID()}`,
    type,
    paymentId,
    holdId,
    createdAt: new Date().toISOString(),
  };
}

interface Chaos {
  duplicate: boolean; 
  reorder: boolean; 
  late: boolean; 
}

function pickChaos(mode: Mode): Chaos {
  switch (mode) {
    case "clean":
      return { duplicate: false, reorder: false, late: false };
    case "duplicate":
      return { duplicate: true, reorder: false, late: false };
    case "reorder":
      return { duplicate: false, reorder: true, late: false };
    case "late":
      return { duplicate: false, reorder: false, late: true };
    default:
      return {
        duplicate: Math.random() < 0.25,
        reorder: Math.random() < 0.25,
        late: Math.random() < 0.15,
      };
  }
}

// ---- Routes ----
export const fakePayRouter = Router();

// POST /fakepay/pay   body: { holdId: number, mode?: "clean"|"duplicate"|"reorder"|"late"|"random" }
fakePayRouter.post("/pay", (req, res) => {
  const holdId = Number(req.body?.holdId);
  if (!Number.isInteger(holdId) || holdId <= 0) {
    return res.status(400).json({ error: "holdId number should be correct" });
  }

  const mode: Mode = ["clean", "duplicate", "reorder", "late"].includes(req.body?.mode)
    ? req.body.mode
    : "random";
  const chaos = pickChaos(mode);
  const paymentId = `pay_${randomUUID()}`;

  const processing = makeEvent("payment.processing", paymentId, holdId);
  const succeeded = makeEvent("payment.succeeded", paymentId, holdId);

  // Normal time: 0.5 to 1.5 second.
  const normalDelay = between(500, 1500);
  const succeededAt = chaos.late ? HOLD_MS + 3000 : normalDelay;

  // reorder: 
  const processingAt = chaos.reorder ? succeededAt + 1000 : Math.min(300, normalDelay / 2);

  later(processingAt, () => void deliver(processing));
  later(succeededAt, () => void deliver(succeeded));

  // duplicate: 
  if (chaos.duplicate) {
    later(succeededAt + between(700, 2000), () => void deliver(succeeded));
  }

  console.log(`[fakepay] hold ${holdId}: ${mode}`, chaos);
  return res.status(202).json({ paymentId, mode, chaos });
});