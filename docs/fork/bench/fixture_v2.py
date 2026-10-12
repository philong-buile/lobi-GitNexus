"""lobibench v2 fixture: the v1 repo (36 files) plus ~130 deterministic noise/trap files, a second
worktree that is AHEAD of the indexed commit, and two unrelated small repos for a realistic registry.

    python fixture_v2.py <root>

Layout under <root>: main (C0, branch main, indexed), wt-agent (C0, uncommitted edit, NOT indexed),
wt-ahead (branch feature-ahead = C0 + C1, uncommitted edit, NOT indexed), notes-app and cli-tool
(small unrelated repos, indexed together with main). No randomness.
"""
import pathlib
import sys

import make_fixture as v1
from make_fixture import sh, _edit

CHECKOUTS = ("main", "wt-agent", "wt-ahead")
REGISTRY = ("notes-app", "cli-tool", "main")  # repos indexed in each MCP arm's GITNEXUS_HOME

# ---- bulk noise: 9 domains x 10 entities, each file has load/validate/summarize, unique names ----
DOMAINS = ["accounts", "analytics", "audit", "catalogs", "compliance", "crm", "loyalty", "payroll", "suppliers"]
ENTITIES = ["contact", "profile", "segment", "campaign", "ticket", "contract", "policy", "region", "channel", "metric"]


def _cap(s):
    return s[0].upper() + s[1:]


def bulk():
    out = {}
    for d in DOMAINS:
        for i, e in enumerate(ENTITIES):
            n = _cap(d) + _cap(e)
            prev = _cap(d) + _cap(ENTITIES[i - 1]) if i else None
            imp = f'import {{ summarize{prev} }} from "./{ENTITIES[i - 1]}";\n' if prev else ""
            tail = f' + (summarize{prev}(id) ? "+" : "")' if prev else ""
            out[f"src/modules/{d}/{e}.ts"] = (
                f'import {{ logInfo }} from "../../logger";\n{imp}\n'
                f"export interface {n}Record {{\n  id: string;\n  label: string;\n}}\n\n"
                f"export function load{n}(id: string): {n}Record {{\n"
                f'  logInfo("load {d}/{e} " + id);\n  return {{ id, label: "{e}-" + id }};\n}}\n\n'
                f"export function validate{n}(r: {n}Record): boolean {{\n"
                f'  return r.id.length > 0 && r.label.startsWith("{e}");\n}}\n\n'
                f"export function summarize{n}(id: string): string {{\n"
                f'  const r = load{n}(id);\n  return (validate{n}(r) ? r.label : ""){tail};\n}}\n')
        out[f"src/modules/{d}/index.ts"] = "".join(
            f'export * from "./{e}";\n' for e in ENTITIES)
    return out


# ---- handwritten trap files ----
H = {}
# deep chain (depth 5) + prefix-name decoy + comment/string mention
H["src/crypto/checksum.ts"] = (
    'export function computeChecksum(data: string): number {\n  let h = 0;\n'
    '  for (let i = 0; i < data.length; i++) {\n    h = (h * 31 + data.charCodeAt(i)) | 0;\n  }\n  return h;\n}\n\n'
    'export function computeChecksumLegacy(data: string): number {\n  return data.length;\n}\n')
H["src/crypto/sign.ts"] = (
    'import { computeChecksum, computeChecksumLegacy } from "./checksum";\n\n'
    'export function signPayload(payload: string): string {\n  return payload + ":" + computeChecksum(payload);\n}\n\n'
    'export function verifyPayload(payload: string, sig: string): boolean {\n  return sig === payload + ":" + computeChecksumLegacy(payload);\n}\n')
H["src/messaging/envelope.ts"] = (
    'import { signPayload } from "../crypto/sign";\n\n'
    'export function buildEnvelope(to: string, body: string): string {\n  return to + "|" + signPayload(body);\n}\n')
H["src/messaging/outbox.ts"] = (
    'import { buildEnvelope } from "./envelope";\n\nconst queue: string[] = [];\n\n'
    'export function queueMessage(to: string, body: string): number {\n  queue.push(buildEnvelope(to, body));\n  return queue.length;\n}\n\n'
    'export function peekOutbox(): string | undefined {\n  return queue[0];\n}\n')
H["src/messaging/flush.ts"] = (
    'import { queueMessage } from "./outbox";\n\n'
    'export function flushOutbox(pending: string[]): number {\n  let n = 0;\n  for (const p of pending) {\n    n = queueMessage("retry", p);\n  }\n  return n;\n}\n')
H["src/jobs/nightly.ts"] = (
    'import { flushOutbox } from "../messaging/flush";\n\n'
    'export function runNightlyJob(pending: string[]): number {\n  return flushOutbox(pending);\n}\n')
H["src/jobs/audit.ts"] = (
    'import { verifyPayload } from "../crypto/sign";\n\n'
    'export function auditChecksums(items: string[][]): number {\n  return items.filter(([p, s]) => verifyPayload(p, s)).length;\n}\n')
H["src/docs/help.ts"] = (
    '// computeChecksum is a rolling hash; see src/crypto/checksum.ts\n'
    'export function describeChecksum(): string {\n  return "computeChecksum(data) returns a 32-bit rolling hash";\n}\n')
# aliased imports + local function with the aliased name
H["src/reports/total.ts"] = (
    'export function computeGrandTotal(lines: number[]): number {\n  return lines.reduce((a, b) => a + b, 0);\n}\n')
H["src/reports/summary.ts"] = (
    'import { computeGrandTotal as grandTotal } from "./total";\n\n'
    'export function renderSummary(lines: number[]): string {\n  return "Total " + grandTotal(lines);\n}\n')
H["src/reports/csv.ts"] = (
    'import { computeGrandTotal as sumAll } from "./total";\n\n'
    'export function exportCsv(lines: number[]): string {\n  return lines.join(",") + "\\n" + sumAll(lines);\n}\n')
H["src/reports/dashboard.ts"] = (
    'import { computeGrandTotal } from "./total";\n\n'
    'export function buildDashboard(lines: number[]): { total: number } {\n  return { total: computeGrandTotal(lines) };\n}\n')
H["src/reports/legacy.ts"] = (
    'function grandTotal(lines: number[]): number {\n  let t = 0;\n  for (const l of lines) t += l;\n  return t;\n}\n\n'
    'export function renderLegacy(lines: number[]): string {\n  return "Legacy total " + grandTotal(lines);\n}\n')
# barrel + same name in 3 modules (+ aliased import through the barrel)
H["src/shipping/label.ts"] = 'export function printLabel(parcelId: string): string {\n  return "SHIP-" + parcelId;\n}\n'
H["src/shipping/rates.ts"] = 'export function quoteRate(kg: number): number {\n  return kg * 4;\n}\n'
H["src/shipping/index.ts"] = 'export { printLabel } from "./label";\nexport * from "./rates";\n'
H["src/inventory/bin-label.ts"] = 'export function printLabel(sku: string): string {\n  return "BIN-" + sku;\n}\n'
H["src/inventory/tags.ts"] = (
    'import { printLabel } from "./bin-label";\n\nexport function stockBinTag(sku: string): string {\n  return printLabel(sku);\n}\n')
H["src/returns/label.ts"] = 'export function printLabel(rmaId: string): string {\n  return "RMA-" + rmaId;\n}\n'
H["src/returns/slip.ts"] = (
    'import { printLabel } from "./label";\n\nexport function createReturnSlip(rmaId: string): string {\n  return printLabel(rmaId);\n}\n')
H["src/fulfillment/parcel.ts"] = (
    'import { printLabel } from "../shipping";\n\nexport function dispatchParcel(id: string): string {\n  return printLabel(id);\n}\n')
H["src/support/reprint.ts"] = (
    'import { printLabel as reprint } from "../shipping";\n\nexport function reprintLabel(id: string): string {\n  return reprint(id);\n}\n')
H["src/fulfillment/batch.ts"] = (
    'import { printLabel } from "../shipping/label";\n\nexport function batchLabels(ids: string[]): string[] {\n  return ids.map((i) => printLabel(i));\n}\n')
# comment / string mentions that are not calls
H["src/payments/charge.ts"] = 'export function chargeCard(cents: number, token: string): boolean {\n  return cents > 0 && token.length > 0;\n}\n'
H["src/payments/checkout.ts"] = (
    'import { chargeCard } from "./charge";\n\nexport function checkoutCart(cents: number, token: string): boolean {\n  return chargeCard(cents, token);\n}\n')
H["src/payments/renew.ts"] = (
    'import { chargeCard } from "./charge";\n\nexport function renewSubscription(token: string): boolean {\n  return chargeCard(999, token);\n}\n')
H["src/payments/docs.ts"] = (
    'export function describeBilling(): string {\n  return "Call chargeCard() after validating the cart";\n}\n')
H["src/payments/retry.ts"] = (
    'const pending: string[] = [];\n\n// chargeCard is retried by the nightly job, not here\n'
    'export function scheduleRetry(token: string): number {\n  pending.push(token);\n  return pending.length;\n}\n')
H["src/payments/later.ts"] = (
    'export function chargeCardLater(cents: number): string {\n  return "deferred " + cents;\n}\n')
H["src/payments/defer.ts"] = (
    'import { chargeCardLater } from "./later";\n\nexport function deferPayment(cents: number): string {\n  return chargeCardLater(cents);\n}\n')
H["src/support/explain.ts"] = (
    'export function explainFailure(code: number): string {\n  return "chargeCard failed: " + code;\n}\n')
H["src/support/notes.ts"] = (
    'export function auditNotes(): string[] {\n  /* TODO: replace chargeCard with chargeWallet */\n  return ["notes"];\n}\n')
# method call through a class instance, same method name on another class
H["src/accounting/ledger.ts"] = (
    'export class Ledger {\n  private rows: string[] = [];\n\n  post(entry: string): void {\n    this.rows.push(entry);\n  }\n}\n\n'
    'export class Journal {\n  private rows: string[] = [];\n\n  post(entry: string): void {\n    this.rows.push("note:" + entry);\n  }\n}\n')
H["src/accounting/book.ts"] = (
    'import { Journal, Ledger } from "./ledger";\n\nconst ledger = new Ledger();\n\n'
    'export function recordSale(entry: string): void {\n  ledger.post(entry);\n}\n\n'
    'export function closeMonth(): void {\n  const l = new Ledger();\n  l.post("close");\n}\n\n'
    'export function recordNote(entry: string): void {\n  new Journal().post(entry);\n}\n')
# worktree-ahead target (C0 state of the call site that C1 moves)
H["src/cart/summary.ts"] = (
    'import { computeShipping } from "../billing/shipping";\n\n'
    'export function summarizeCart(cents: number[], weightKg: number): number {\n  return cents.reduce((a, b) => a + b, 0) + computeShipping(weightKg);\n}\n')
# look-alike names (never call or define any v1 task symbol)
LOOK = {
    "formatPriceRange": 'export function formatPriceRange(lo: number, hi: number): string {\n  return lo + "-" + hi;\n}\n',
    "formatPrices": "export function formatPrices(xs: number[]): string[] {\n  return xs.map((x) => String(x));\n}\n",
    "parseAmounts": "export function parseAmounts(xs: string[]): number[] {\n  return xs.map((x) => Number(x));\n}\n",
    "parseAmountStrict": "export function parseAmountStrict(x: string): number {\n  return Number(x);\n}\n",
    "toCentsSafe": "export function toCentsSafe(x: number): number {\n  return Math.round(x * 100);\n}\n",
    "computeTaxes": "export function computeTaxes(xs: number[]): number {\n  return xs.length;\n}\n",
    "applyDiscounts": "export function applyDiscounts(xs: number[]): number[] {\n  return xs.slice();\n}\n",
    "handleRefundLater": 'export function handleRefundLater(x: number): string {\n  return "later " + x;\n}\n',
}
for k, v in LOOK.items():
    H[f"src/lookalikes/{k}.ts"] = v
H["src/lookalikes/index.ts"] = "".join(f'export * from "./{k}";\n' for k in LOOK)

# ---- C1 on feature-ahead ----
AHEAD = {
    "src/billing/coupon.ts": (
        'import { applyDiscount } from "./discount";\n\n'
        'export function couponPct(code: string): number {\n  return code === "HALF" ? 50 : 10;\n}\n\n'
        'export function applyCoupon(cents: number, code: string): number {\n  return applyDiscount(cents, couponPct(code));\n}\n'),
    "src/billing/redeem.ts": (
        'import { applyCoupon } from "./coupon";\n\n'
        'export function redeemCode(cents: number, code: string): number {\n  return applyCoupon(cents, code);\n}\n'),
    "src/cart/cart.ts": (
        'import { applyCoupon } from "../billing/coupon";\n\n'
        'export function priceCart(cents: number[], code: string): number[] {\n  return cents.map((c) => applyCoupon(c, code));\n}\n'),
    "src/cart/summary.ts": (
        'export function summarizeCart(cents: number[]): number {\n  return cents.reduce((a, b) => a + b, 0);\n}\n'),
    "src/cart/totals.ts": (
        'import { computeShipping } from "../billing/shipping";\n\n'
        'export function cartTotals(cents: number[], weightKg: number): number {\n  return cents.reduce((a, b) => a + b, 0) + computeShipping(weightKg);\n}\n'),
}

EDITS_MAIN = v1.EDITS_MAIN  # roundCents: someone else's uncommitted work in the indexed checkout
EDITS_WT = v1.EDITS_WT      # applyDiscount, in wt-agent
EDITS_AHEAD = [("src/billing/shipping.ts",
                "  return roundCents(weightKg * 1.5);",
                "  return roundCents(Math.max(0.5, weightKg) * 1.5);")]


def all_files():
    f = dict(v1.FILES)
    f.update(bulk())
    f.update(H)
    return f


def _write(base, files):
    for rel, text in files.items():
        p = base / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")


G = ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid"]


def _repo(path, files):
    path.mkdir(parents=True)
    _write(path, files)
    sh("git", "init", "-b", "main", cwd=path)
    sh("git", "config", "core.autocrlf", "false", cwd=path)
    sh("git", "add", "-A", cwd=path)
    sh("git", *G, "commit", "-m", "C0", cwd=path)


NOTES = {
    "package.json": '{ "name": "notes-app", "version": "0.1.0", "private": true }\n',
    "src/note.ts": 'export interface Note {\n  id: number;\n  text: string;\n}\n\nexport function newNote(id: number, text: string): Note {\n  return { id, text };\n}\n',
    "src/store.ts": 'import { Note } from "./note";\n\nconst notes: Note[] = [];\n\nexport function addNote(n: Note): number {\n  notes.push(n);\n  return notes.length;\n}\n\nexport function listNotes(): Note[] {\n  return notes.slice();\n}\n',
    "src/search.ts": 'import { listNotes } from "./store";\n\nexport function findNotes(term: string): string[] {\n  return listNotes().filter((n) => n.text.includes(term)).map((n) => n.text);\n}\n',
    "src/index.ts": 'import { newNote } from "./note";\nimport { addNote } from "./store";\n\nexport function quickAdd(text: string): number {\n  return addNote(newNote(Date.now(), text));\n}\n',
}
CLI = {
    "package.json": '{ "name": "cli-tool", "version": "0.1.0", "private": true }\n',
    "src/args.ts": 'export function parseFlags(argv: string[]): Record<string, string> {\n  const out: Record<string, string> = {};\n  for (const a of argv) {\n    const m = /^--(\\w+)=(.*)$/.exec(a);\n    if (m) out[m[1]] = m[2];\n  }\n  return out;\n}\n',
    "src/commands/hello.ts": 'export function runHello(name: string): string {\n  return "hello " + name;\n}\n',
    "src/commands/version.ts": 'export function runVersion(): string {\n  return "0.1.0";\n}\n',
    "src/cli.ts": 'import { parseFlags } from "./args";\nimport { runHello } from "./commands/hello";\nimport { runVersion } from "./commands/version";\n\nexport function main(argv: string[]): string {\n  const f = parseFlags(argv);\n  return f.version ? runVersion() : runHello(f.name ?? "world");\n}\n',
}


def apply_edits(root):
    """Reset every checkout, then re-create the three uncommitted edits."""
    root = pathlib.Path(root)
    for sub in CHECKOUTS:
        sh("git", "checkout", "--", ".", cwd=root / sub)
    _edit(root / "main", EDITS_MAIN)
    _edit(root / "wt-agent", EDITS_WT)
    _edit(root / "wt-ahead", EDITS_AHEAD)


def make(root):
    root = pathlib.Path(root)
    _repo(root / "notes-app", NOTES)
    _repo(root / "cli-tool", CLI)
    _repo(root / "main", all_files())
    main = root / "main"
    sh("git", "worktree", "add", "-b", "agent-task", str(root / "wt-agent"), cwd=main)
    sh("git", "worktree", "add", "-b", "feature-ahead", str(root / "wt-ahead"), cwd=main)
    _write(root / "wt-ahead", AHEAD)
    sh("git", "add", "-A", cwd=root / "wt-ahead")
    sh("git", *G, "commit", "-m", "C1: applyCoupon", cwd=root / "wt-ahead")
    return root


if __name__ == "__main__":
    make(sys.argv[1])
    apply_edits(sys.argv[1])
    print("fixture at", sys.argv[1], "with", len(all_files()), "files in main")
