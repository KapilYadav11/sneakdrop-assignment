const BASE = process.env.BASE_URL ?? "http://localhost:4000";
const USERS = Number(process.env.USERS ?? 2000);
const SPAM = Number(process.env.SPAM ?? 50);
const TOTAL_PAIRS = 20;

interface BuyResult {
  status: number; 
  code?: string;
}

async function tryBuy(name: string): Promise<BuyResult> {
  try {
    const res = await fetch(`${BASE}/api/buy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body: any = await res.json().catch(() => ({}));
    return { status: res.status, code: body.code };
  } catch {
    return { status: 0 };
  }
}

function summarize(results: BuyResult[]) {
  const out: Record<string, number> = {};
  for (const r of results) {
    const key = r.status === 201 ? "201 HOLD_CREATED" : r.status === 0 ? "NETWORK_ERROR" : `${r.status} ${r.code}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

async function getStats(): Promise<any> {
  const res = await fetch(`${BASE}/api/stats`);
  return res.json();
}

async function main() {
  try {
    await fetch(`${BASE}/health`);
  } catch {
    console.error(`Server not found: ${BASE}. Pehle 'npm run dev' run.`);
    process.exit(1);
  }

  const before = await getStats();
  console.log("Before the starting:", before);
  if (before.available !== TOTAL_PAIRS) {
    console.error("Database is not fresh. Closed the server, 'npm run db:reset' run, start the server again.");
    process.exit(1);
  }

  console.log(`\nTest 1: single user, ${SPAM} parallel Buy`);
  const spamResults = await Promise.all(
    Array.from({ length: SPAM }, () => tryBuy("spammer"))
  );
  const spamSummary = summarize(spamResults);
  console.log(spamSummary);

  console.log(`\nTest 2: ${USERS} different user, all together`);
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: USERS }, (_, i) => tryBuy(`load_user_${i}`))
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(summarize(results), `(${seconds}s)`);

  
  const after = await getStats();
  console.log("\nStart in Last:", after);

  const holdsCreated =
    [...spamResults, ...results].filter((r) => r.status === 201).length;
  const spamHolds = spamResults.filter((r) => r.status === 201).length;
  const networkErrors = [...spamResults, ...results].filter((r) => r.status === 0).length;

  const checks: [string, boolean][] = [
    ["spammer found only 1 hold", spamHolds === 1],
    [`Total holds ${TOTAL_PAIRS} s (found: ${holdsCreated})`, holdsCreated <= TOTAL_PAIRS],
    [`sold + held <= ${TOTAL_PAIRS} (hai: ${after.sold_plus_held})`, after.sold_plus_held <= TOTAL_PAIRS],
    ["send till stock 0", after.available === 0],
    ["available + active + paid == total", after.stockBalanced === true],
    ["server neverOversold flag true", after.neverOversold === true],
    ["No error network", networkErrors === 0],
  ];

  console.log("\nResult:");
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) allOk = false;
  }

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Load test crashed:", err);
  process.exit(1);
});