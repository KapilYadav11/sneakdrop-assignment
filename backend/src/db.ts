import { PrismaClient, Prisma } from "@prisma/client";


export const TOTAL_STOCK = 20;
export const MAX_PAIRS_PER_USER = 2;


export const HOLD_SECONDS = Number(process.env.HOLD_SECONDS ?? 300);
export const HOLD_MS = HOLD_SECONDS * 1000;

export const HoldStatus = {
  ACTIVE: "ACTIVE",
  PAID: "PAID",
  EXPIRED: "EXPIRED",
  REFUNDED: "REFUNDED",
} as const;

export const WaitStatus = {
  WAITING: "WAITING",
  FULFILLED: "FULFILLED",
  CANCELLED: "CANCELLED",
} as const;


export const prisma = new PrismaClient({
  datasourceUrl: "file:./dev.db?connection_limit=1&socket_timeout=60",
});

export type Tx = Prisma.TransactionClient;

export async function seedStock() {
  const existing = await prisma.stock.findUnique({ where: { id: 1 } });
  if (existing) return;

  await prisma.stock.create({
    data: { id: 1, total: TOTAL_STOCK, available: TOTAL_STOCK },
  });
  console.log(`Stock seeded: ${TOTAL_STOCK} pairs`);
}