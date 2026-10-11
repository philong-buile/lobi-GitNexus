"""Build the lobibench fixture: a small TypeScript repo with planted traps.

    python make_fixture.py <root>

Creates <root>/main (commit C0 on branch main, NOT yet indexed) and
<root>/wt-agent (linked worktree at C0, branch agent-task). The uncommitted
edits are applied by apply_edits(); the runner calls it again after every
session to restore a pristine state. Deterministic: no randomness.
"""
import pathlib
import subprocess
import sys

FILES = {
    "package.json": '{\n  "name": "shopkit",\n  "version": "1.0.0",\n  "private": true\n}\n',
    "tsconfig.json": '{\n  "compilerOptions": { "target": "ES2020", "module": "commonjs", "strict": true }\n}\n',
    "src/config.ts": 'export const CURRENCY = "USD";\nexport const TAX_RATE = 0.08;\nexport const MAX_ITEMS = 50;\n',
    "src/types.ts": 'export interface Item {\n  sku: string;\n  cents: number;\n}\n\nexport interface Invoice {\n  id: string;\n  total: number;\n}\n',
    "src/logger.ts": 'export function logInfo(msg: string): void {\n  console.log("[info] " + msg);\n}\n\nexport function logWarn(msg: string): void {\n  console.warn("[warn] " + msg);\n}\n',
    # trap 1: duplicate name
    "src/billing/format.ts": 'import { CURRENCY } from "../config";\n\nexport function formatPrice(cents: number): string {\n  return CURRENCY + " " + (cents / 100).toFixed(2);\n}\n',
    "src/catalog/format.ts": 'export function formatPrice(cents: number, locale: string): string {\n  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(cents / 100);\n}\n',
    "src/billing/lines.ts": 'import { formatPrice } from "./format";\n\nexport function renderInvoiceLine(label: string, cents: number): string {\n  return label + ": " + formatPrice(cents);\n}\n',
    "src/billing/receipt.ts": 'import { formatPrice } from "./format";\n\nexport function renderReceipt(total: number): string {\n  return "Paid " + formatPrice(total);\n}\n',
    "src/catalog/listing.ts": 'import { formatPrice } from "./format";\nimport { Item } from "../types";\n\nexport function renderListing(item: Item): string {\n  return item.sku + " " + formatPrice(item.cents, "en-US");\n}\n',
    "src/catalog/search.ts": 'import { formatPrice } from "./format";\n\nexport function renderSearchResult(sku: string, cents: number): string {\n  return sku + " @ " + formatPrice(cents, "en-GB");\n}\n',
    "src/catalog/index.ts": 'import { Item } from "../types";\n\nexport function listSkus(items: Item[]): string[] {\n  return items.map((i) => i.sku);\n}\n',
    # trap 2: three-level chain + unrelated sibling
    "src/billing/amount.ts": 'export function parseAmount(text: string): number {\n  const n = parseFloat(text.replace(/[^0-9.]/g, ""));\n  return Number.isNaN(n) ? 0 : n;\n}\n\nexport function toCents(text: string): number {\n  return Math.round(parseAmount(text) * 100);\n}\n',
    "src/billing/invoice.ts": 'import { toCents } from "./amount";\nimport { applyTax } from "../tax/tax";\nimport { deliver } from "../notifications/email";\nimport { Invoice } from "../types";\n\nexport function buildInvoice(prices: string[], region: string): Invoice {\n  let total = 0;\n  for (const p of prices) {\n    total += applyTax(toCents(p), region);\n  }\n  return { id: "inv-" + prices.length, total };\n}\n\nexport function sendInvoice(prices: string[], region: string, to: string): void {\n  const invoice = buildInvoice(prices, region);\n  deliver(to, "Invoice " + invoice.id);\n}\n',
    "src/billing/sum.ts": 'export function sumLines(lines: number[]): number {\n  return lines.reduce((a, b) => a + b, 0);\n}\n',
    "src/billing/refund.ts": 'import { sumLines } from "./sum";\n\nexport function refundTotal(lines: number[]): number {\n  return sumLines(lines);\n}\n',
    # trap 6 targets
    "src/billing/money.ts": 'export function roundCents(value: number): number {\n  return Math.round(value * 100) / 100;\n}\n',
    "src/billing/discount.ts": 'import { roundCents } from "./money";\n\nexport function applyDiscount(cents: number, pct: number): number {\n  const factor = 1 - pct / 100;\n  return roundCents(cents * factor);\n}\n',
    "src/billing/shipping.ts": 'import { roundCents } from "./money";\n\nexport function computeShipping(weightKg: number): number {\n  return roundCents(weightKg * 1.5);\n}\n',
    "src/cart/cart.ts": 'import { applyDiscount } from "../billing/discount";\n\nexport function priceCart(cents: number[], pct: number): number[] {\n  return cents.map((c) => applyDiscount(c, pct));\n}\n',
    "src/cart/quote.ts": 'import { applyDiscount } from "../billing/discount";\n\nexport function quoteOrder(cents: number, pct: number): number {\n  return applyDiscount(cents, pct);\n}\n',
    # trap 4: dead code, name-prefix collision
    "src/tax/tax.ts": 'import { TAX_RATE } from "../config";\n\nexport function computeTax(amount: number): number {\n  return amount * TAX_RATE;\n}\n\nexport function computeTaxRate(region: string): number {\n  return region === "EU" ? 0.2 : TAX_RATE;\n}\n\nexport function applyTax(cents: number, region: string): number {\n  return Math.round(cents * (1 + computeTaxRate(region)));\n}\n',
    # trap 3: import cycle a -> b -> c -> a, d imports a
    "src/cycle/a.ts": 'import { fromB } from "./b";\n\nexport function fromA(n: number): number {\n  return n > 0 ? fromB(n - 1) : 0;\n}\n',
    "src/cycle/b.ts": 'import { fromC } from "./c";\n\nexport function fromB(n: number): number {\n  return n > 0 ? fromC(n - 1) : 0;\n}\n',
    "src/cycle/c.ts": 'import { fromA } from "./a";\n\nexport function fromC(n: number): number {\n  return n > 0 ? fromA(n - 1) : 0;\n}\n',
    "src/cycle/d.ts": 'import { fromA } from "./a";\n\nexport function useCycle(): number {\n  return fromA(3);\n}\n',
    # trap 5: table dispatch
    "src/dispatch/handlers.ts": 'export function handleRefund(x: number): string {\n  return "refund " + x;\n}\n\nexport function handleVoid(x: number): string {\n  return "void " + x;\n}\n\nexport function handleCapture(x: number): string {\n  return "capture " + x;\n}\n\nexport function handleLegacy(x: number): string {\n  return "legacy " + x;\n}\n\nexport const handlers: Record<string, (x: number) => string> = {\n  refund: handleRefund,\n  void: handleVoid,\n  capture: handleCapture,\n};\n',
    "src/dispatch/dispatch.ts": 'import { handlers } from "./handlers";\n\nexport function dispatch(kind: string, x: number): string {\n  return handlers[kind](x);\n}\n',
    # padding (does not touch any trap symbol)
    "src/notifications/email.ts": 'import { logInfo } from "../logger";\n\nexport function deliver(to: string, body: string): void {\n  logInfo("mail to " + to + ": " + body);\n}\n',
    "src/notifications/sms.ts": 'import { logInfo } from "../logger";\n\nexport function textUser(phone: string, body: string): void {\n  logInfo("sms to " + phone + ": " + body);\n}\n',
    "src/users/user.ts": 'export interface User {\n  id: string;\n  email: string;\n}\n\nexport function makeUser(id: string, email: string): User {\n  return { id, email };\n}\n',
    "src/users/repo.ts": 'import { User, makeUser } from "./user";\n\nconst store = new Map<string, User>();\n\nexport function saveUser(id: string, email: string): User {\n  const u = makeUser(id, email);\n  store.set(id, u);\n  return u;\n}\n\nexport function findUser(id: string): User | undefined {\n  return store.get(id);\n}\n',
    "src/orders/order.ts": 'export interface Order {\n  id: string;\n  status: string;\n}\n\nexport function openOrder(id: string): Order {\n  return { id, status: "open" };\n}\n',
    "src/orders/status.ts": 'import { Order } from "./order";\n\nexport function closeOrder(o: Order): Order {\n  return { ...o, status: "closed" };\n}\n',
    "src/inventory/stock.ts": 'const levels = new Map<string, number>();\n\nexport function setStock(sku: string, n: number): void {\n  levels.set(sku, n);\n}\n\nexport function getStock(sku: string): number {\n  return levels.get(sku) ?? 0;\n}\n',
    "src/inventory/warehouse.ts": 'export function pickWarehouse(region: string): string {\n  return region === "EU" ? "ams" : "iad";\n}\n',
    "src/utils/strings.ts": 'export function slugify(s: string): string {\n  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");\n}\n',
    "src/utils/dates.ts": 'export function isoDay(d: Date): string {\n  return d.toISOString().slice(0, 10);\n}\n',
    "src/utils/ids.ts": 'let counter = 0;\n\nexport function nextId(prefix: string): string {\n  counter += 1;\n  return prefix + "-" + counter;\n}\n',
}

# (relative path, old text, new text) -- body-only edits, signatures untouched
EDITS_MAIN = [("src/billing/money.ts",
               "  return Math.round(value * 100) / 100;",
               "  return Math.round((value + Number.EPSILON) * 100) / 100;")]
EDITS_WT = [("src/billing/discount.ts",
             "  const factor = 1 - pct / 100;",
             "  const factor = Math.max(0, 1 - pct / 100);")]


def sh(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


def _edit(root, edits):
    for rel, old, new in edits:
        p = pathlib.Path(root) / rel
        s = p.read_text(encoding="utf-8")
        assert old in s, (rel, old)
        p.write_text(s.replace(old, new), encoding="utf-8", newline="\n")


def apply_edits(root):
    """Re-create the uncommitted edits after resetting both checkouts."""
    root = pathlib.Path(root)
    for sub in ("main", "wt-agent"):
        sh("git", "checkout", "--", ".", cwd=root / sub)
    _edit(root / "main", EDITS_MAIN)
    _edit(root / "wt-agent", EDITS_WT)


def make(root):
    root = pathlib.Path(root)
    main = root / "main"
    main.mkdir(parents=True)
    for rel, text in FILES.items():
        p = main / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")
    g = ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid"]
    sh("git", "init", "-b", "main", cwd=main)
    sh("git", "config", "core.autocrlf", "false", cwd=main)
    sh("git", "add", "-A", cwd=main)
    sh("git", *g, "commit", "-m", "C0", cwd=main)
    sh("git", "worktree", "add", "-b", "agent-task", str(root / "wt-agent"), cwd=main)
    return root


if __name__ == "__main__":
    make(sys.argv[1])
    apply_edits(sys.argv[1])
    print("fixture at", sys.argv[1], "with", len(FILES), "files")
