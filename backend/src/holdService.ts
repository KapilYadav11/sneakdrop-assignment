import { Prisma } from "@prisma/client";
import { prisma, Tx, HOLD_MS, HoldStatus, WaitStatus, MAX_PAIRS_PER_USER } from "./db";


export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 400
  ) {
    super(message);
  }
}


let chain: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(() => fn());
  chain = run.catch(() => undefined);
  return run;
}

export const TX_OPTIONS = { maxWait: 60_000, timeout: 60_000 };

// ---- Helpers ----

async function getOrCreateUser(tx: Tx, name: string) {
  const clean = name.trim();
  if (!clean) throw new AppError("BAD_NAME", "Name cannot be empty", 400);

  const found = await tx.user.findUnique({ where: { name: clean } });
  if (found) return found;
  return tx.user.create({ data: { name: clean } });
}

type TakeCheck = "OK" | "ALREADY_HOLDING" | "LIMIT_REACHED";


async function canTake(tx: Tx, userId: number): Promise<TakeCheck> {
  const active = await tx.hold.count({
    where: { userId, status: HoldStatus.ACTIVE },
  });
  if (active > 0) return "ALREADY_HOLDING";

  const owned = await tx.hold.count({
    where: { userId, status: { in: [HoldStatus.ACTIVE, HoldStatus.PAID] } },
  });
  if (owned >= MAX_PAIRS_PER_USER) return "LIMIT_REACHED";

  return "OK";
}

async function assertCanTake(tx: Tx, userId: number) {
  const result = await canTake(tx, userId);
  if (result === "ALREADY_HOLDING") {
    throw new AppError("ALREADY_HOLDING", "You have alraedy one hold", 409);
  }
  if (result === "LIMIT_REACHED") {
    throw new AppError("LIMIT_REACHED", "You can take only 2 maximum", 409);
  }
}

async function queuePosition(tx: Tx, entryId: number) {
  const ahead = await tx.waitlistEntry.count({
    where: { status: WaitStatus.WAITING, id: { lt: entryId } },
  });
  return ahead + 1;
}


export async function freePair(tx: Tx): Promise<{ assignedToUserId: number | null }> {
  while (true) {
    const next = await tx.waitlistEntry.findFirst({
      where: { status: WaitStatus.WAITING },
      orderBy: { id: "asc" },
    });
    if (!next) break;

    const check = await canTake(tx, next.userId);
    if (check !== "OK") {
      
      await tx.waitlistEntry.update({
        where: { id: next.id },
        data: { status: WaitStatus.CANCELLED },
      });
      continue;
    }

    await tx.hold.create({
      data: {
        userId: next.userId,
        expiresAt: new Date(Date.now() + HOLD_MS),
        fromQueue: true,
      },
    });
    await tx.waitlistEntry.update({
      where: { id: next.id },
      data: { status: WaitStatus.FULFILLED },
    });
    return { assignedToUserId: next.userId };
  }

  await tx.$executeRaw`UPDATE "Stock" SET "available" = "available" + 1 WHERE "id" = 1 AND "available" < "total"`;
  return { assignedToUserId: null };
}

// ---- Buy ----
export function buy(userName: string) {
  return runExclusive(() =>
    prisma.$transaction(async (tx) => {
      const user = await getOrCreateUser(tx, userName);

      const waiting = await tx.waitlistEntry.findFirst({
        where: { userId: user.id, status: WaitStatus.WAITING },
      });
      if (waiting) {
        throw new AppError("ALREADY_WAITING", "You are already in waiting line", 409);
      }

      await assertCanTake(tx, user.id);

     
      const updated = await tx.$executeRaw`UPDATE "Stock" SET "available" = "available" - 1 WHERE "id" = 1 AND "available" > 0`;
      if (updated === 0) {
        throw new AppError("SOLD_OUT", "Out of Stock.You can join the waiting line", 409);
      }

      const hold = await tx.hold.create({
        data: { userId: user.id, expiresAt: new Date(Date.now() + HOLD_MS) },
      });
      return { holdId: hold.id, expiresAt: hold.expiresAt };
    }, TX_OPTIONS)
  );
}

// ---- Waiting line join ----
export function joinWaitlist(userName: string) {
  return runExclusive(() =>
    prisma.$transaction(async (tx) => {
      const user = await getOrCreateUser(tx, userName);

      const stock = await tx.stock.findUnique({ where: { id: 1 } });
      if (stock && stock.available > 0) {
        throw new AppError("STOCK_AVAILABLE", "Stock is available", 409);
      }

      const already = await tx.waitlistEntry.findFirst({
        where: { userId: user.id, status: WaitStatus.WAITING },
      });
      if (already) {
        throw new AppError("ALREADY_WAITING", "you are already in the waiting line", 409);
      }

      await assertCanTake(tx, user.id);

      const entry = await tx.waitlistEntry.create({ data: { userId: user.id } });
      return { position: await queuePosition(tx, entry.id) };
    }, TX_OPTIONS)
  );
}

// ---- Expiry ----

export function expireDueHolds() {
  return runExclusive(() =>
    prisma.$transaction(async (tx) => {
      const due = await tx.hold.findMany({
        where: { status: HoldStatus.ACTIVE, expiresAt: { lte: new Date() } },
        orderBy: { expiresAt: "asc" },
      });

      let expired = 0;
      for (const hold of due) {
        const res = await tx.hold.updateMany({
          where: { id: hold.id, status: HoldStatus.ACTIVE },
          data: { status: HoldStatus.EXPIRED },
        });
        if (res.count === 1) {
          await freePair(tx);
          expired++;
        }
      }
      return expired;
    }, TX_OPTIONS)
  );
}

// ---- Status 
export async function getStatus(userName?: string) {
  const stock = await prisma.stock.findUnique({ where: { id: 1 } });
  const base = {
    available: stock?.available ?? 0,
    total: stock?.total ?? 0,
    waitingCount: await prisma.waitlistEntry.count({ where: { status: WaitStatus.WAITING } }),
  };

  const name = userName?.trim();
  if (!name) return { ...base, user: null };

  const user = await prisma.user.findUnique({ where: { name } });
  if (!user) return { ...base, user: null };

  const hold = await prisma.hold.findFirst({
    where: { userId: user.id, status: HoldStatus.ACTIVE },
  });
  const entry = await prisma.waitlistEntry.findFirst({
    where: { userId: user.id, status: WaitStatus.WAITING },
  });
  const paid = await prisma.hold.count({
    where: { userId: user.id, status: HoldStatus.PAID },
  });

  return {
    ...base,
    user: {
      name: user.name,
      paidPairs: paid,
      hold: hold
        ? {
            expiresAt: hold.expiresAt,
            secondsLeft: Math.max(0, Math.ceil((hold.expiresAt.getTime() - Date.now()) / 1000)),
            fromQueue: hold.fromQueue,
          }
        : null,
      queuePosition: entry ? await queuePosition(prisma as unknown as Tx, entry.id) : null,
    },
  };
}