import express, { Request, Response, NextFunction, RequestHandler } from "express";
import cors from "cors";
import { prisma, seedStock, HoldStatus, WaitStatus } from "./db";
import { AppError, buy, joinWaitlist, getStatus } from "./holdService";
import { handlePaymentEvent } from "./webhookService";
import { fakePayRouter, WEBHOOK_SECRET } from "./fakePay";
import { startWorker } from "./worker";

const PORT = Number(process.env.PORT ?? 4000);

const app = express();
app.use(cors()); 
app.use(express.json());

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };



app.post(
  "/api/buy",
  wrap(async (req, res) => {
    const result = await buy(String(req.body?.name ?? ""));
    res.status(201).json(result);
  })
);

// Stock is 0 ,waiting line join
app.post(
  "/api/waitlist",
  wrap(async (req, res) => {
    const result = await joinWaitlist(String(req.body?.name ?? ""));
    res.status(201).json(result);
  })
);


app.get(
  "/api/status",
  wrap(async (req, res) => {
    const name = typeof req.query.name === "string" ? req.query.name : undefined;
    res.json(await getStatus(name));
  })
);

// ---- Payment webhook ----
app.post(
  "/webhooks/payment",
  wrap(async (req, res) => {
    if (req.header("x-fakepay-secret") !== WEBHOOK_SECRET) {
      throw new AppError("BAD_SECRET", "Secret galat hai", 401);
    }
    const result = await handlePaymentEvent(req.body);
    res.status(200).json(result);
  })
);

// Fake payment provider: POST /fakepay/pay
app.use("/fakepay", fakePayRouter);


app.get(
  "/api/stats",
  wrap(async (_req, res) => {
    const stock = await prisma.stock.findUnique({ where: { id: 1 } });
    const count = (status: string) => prisma.hold.count({ where: { status } });

    const active = await count(HoldStatus.ACTIVE);
    const paid = await count(HoldStatus.PAID);
    const expired = await count(HoldStatus.EXPIRED);
    const refunded = await count(HoldStatus.REFUNDED);
    const waiting = await prisma.waitlistEntry.count({ where: { status: WaitStatus.WAITING } });

    const total = stock?.total ?? 0;
    const available = stock?.available ?? 0;

    res.json({
      total,
      available,
      active,
      paid,
      expired,
      refunded,
      waiting,
      sold_plus_held: paid + active,
      neverOversold: paid + active <= total,
      stockBalanced: available + active + paid === total,
    });
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ---- Error handler ----
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.httpStatus).json({ code: err.code, error: err.message });
  }
  console.error("[server] unexpected error:", err);
  return res.status(500).json({ code: "INTERNAL", error: "Error" });
});

// ---- Start ----
async function main() {
  await seedStock();
  startWorker();
  app.listen(PORT, () => {
    console.log(`Server is running on: http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Server not started yet:", err);
  process.exit(1);
});