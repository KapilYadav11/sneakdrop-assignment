import { prisma, HoldStatus } from "./db";
import { AppError, runExclusive, TX_OPTIONS } from "./holdService";

export interface PaymentEventInput {
  eventId: string;
  type: string;
  paymentId?: string;
  holdId: number;
}

export type WebhookOutcome =
  | "PAID" // hold ACTIVE tha, ab pair pakka bik gaya
  | "DUPLICATE" // ye eventId pehle aa chuka hai, kuch nahi kiya
  | "ALREADY_PAID" // dusre eventId se payment pehle hi ho chuki thi
  | "REFUNDED_LATE" // hold expire 
  | "ALREADY_REFUNDED"
  | "IGNORED" // processing 
  | "UNKNOWN_HOLD";

const KNOWN_TYPES = ["payment.processing", "payment.succeeded"];

function validate(input: PaymentEventInput) {
  if (!input || typeof input.eventId !== "string" || !input.eventId) {
    throw new AppError("BAD_EVENT", "eventId required", 400);
  }
  if (!KNOWN_TYPES.includes(input.type)) {
    throw new AppError("BAD_EVENT", `type not found: ${input.type}`, 400);
  }
  if (!Number.isInteger(input.holdId) || input.holdId <= 0) {
    throw new AppError("BAD_EVENT", "holdId number must be correct", 400);
  }
}


export function handlePaymentEvent(input: PaymentEventInput) {
  validate(input);

  return runExclusive(() =>
    prisma.$transaction(async (tx) => {
      // 1. Idempotency: ye event pehle dekha hai?
      const seen = await tx.webhookEvent.findUnique({ where: { eventId: input.eventId } });
      if (seen) {
        return { outcome: "DUPLICATE" as WebhookOutcome, firstOutcome: seen.outcome };
      }

    
      const record = async (outcome: WebhookOutcome) => {
        await tx.webhookEvent.create({
          data: { eventId: input.eventId, holdId: input.holdId, type: input.type, outcome },
        });
        return { outcome };
      };

      // 2. processing
      if (input.type !== "payment.succeeded") {
        return record("IGNORED");
      }

      // 3. Payment succeeded. 
      const hold = await tx.hold.findUnique({ where: { id: input.holdId } });
      if (!hold) return record("UNKNOWN_HOLD");

      switch (hold.status) {
        case HoldStatus.ACTIVE: {
          // updateMany + status condition: sirf ACTIVE se PAID hoga, aur sirf ek baar.
          const res = await tx.hold.updateMany({
            where: { id: hold.id, status: HoldStatus.ACTIVE },
            data: { status: HoldStatus.PAID, paidAt: new Date() },
          });
          return record(res.count === 1 ? "PAID" : "ALREADY_PAID");
        }

        case HoldStatus.PAID:
          // Dusra succeeded event (alag eventId) par hold pehle se PAID. Dobara count nahi hoga.
          return record("ALREADY_PAID");

        case HoldStatus.EXPIRED: {
          
          await tx.hold.update({
            where: { id: hold.id },
            data: { status: HoldStatus.REFUNDED },
          });
          console.log(`[refund] hold ${hold.id} (user ${hold.userId}): payment late aaya, paisa wapas`);
          return record("REFUNDED_LATE");
        }

        default:
          // REFUNDED: 
          return record("ALREADY_REFUNDED");
      }
    }, TX_OPTIONS)
  );
}