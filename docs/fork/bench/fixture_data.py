"""lobibench data-file fixture: a small Python shop repo with 15 CSV/TSV files (live, dead, overlapping
columns, one large, one text-only). All data is synthetic; every personal value carries the canary "qzx".

    python fixture_data.py <root>      # builds, restores, self-checks

Deterministic: no randomness, no clock.
"""
import csv
import pathlib
import shutil
import sys

from make_fixture import sh

CHECKOUTS = ("main",)
REGISTRY = ("main",)
CANARIES = ("qzx",)
G = ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid"]
CITIES = ["Springfield", "Rivertown", "Lakeside", "Hillview", "Fairmont"]
SKUS = ["SKU-100", "SKU-200", "SKU-300", "SKU-400", "SKU-500", "SKU-600"]


def _write(repo, rel, text):
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8", newline="\n")


def _table(repo, rel, header, rows, delim=","):
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter=delim, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def _data(repo):
    _table(repo, "data/customers.csv", ["customer_id", "full_name", "email", "phone", "city", "signup_year"],
           [[1000 + i, f"Nora Qzx{i:04d}", f"c{i:04d}.qzx@example.invalid", f"+1-555-qzx-{i:04d}",
             CITIES[i % 5], 2015 + i % 10] for i in range(1, 21)])
    _table(repo, "data/orders.csv", ["order_id", "customer_id", "sku", "qty", "unit_price", "order_date"],
           [[5000 + i, 1001 + i % 20, SKUS[i % 6], 1 + i % 4, f"{10 + i % 7 * 5}.50", f"2026-02-{1 + i % 28:02d}"]
            for i in range(25)])
    _table(repo, "data/products.csv", ["sku", "name", "category", "price", "stock"],
           [[s, f"Widget {i}", ["tools", "toys", "home"][i % 3], f"{9 + i * 4}.99", 40 + i * 7]
            for i, s in enumerate(SKUS)])
    _table(repo, "data/returns.csv", ["return_id", "order_id", "sku", "qty", "reason"],
           [[900 + i, 5000 + i * 3, SKUS[i % 6], 1 + i % 2, ["damaged", "wrong size", "changed mind"][i % 3]]
            for i in range(8)])
    _table(repo, "data/inventory.tsv", ["sku", "warehouse", "on_hand", "reorder_level"],
           [[SKUS[i % 6], ["east", "west", "north"][i % 3], 100 + i * 13, 20 + i % 4 * 5] for i in range(12)], "\t")
    _table(repo, "data/suppliers.csv", ["supplier_id", "name", "contact_email", "country", "lead_days"],
           [[10 + i, f"Supplier {c.upper()}", f"ops@supplier-{c}.example.invalid",
             ["US", "DE", "JP", "BR", "IN"][i], 5 + i * 3] for i, c in enumerate("abcde")])
    _table(repo, "data/regions.csv", ["region_code", "region_name", "manager"],
           [[c, n, f"Desk {d}"] for c, n, d in (("NE", "North East", "A"), ("NW", "North West", "B"),
                                                ("SE", "South East", "C"), ("SW", "South West", "D"),
                                                ("CE", "Central", "E"))])
    types = ("view", "cart", "buy", "refund")
    _table(repo, "data/events_large.csv", ["event_id", "customer_id", "event_type", "ts", "value"],
           [[f"EV{i:08d}", 1001 + i % 20, types[i % 4], f"2026-01-{1 + i % 28:02d}", f"{i % 97}.{i % 100:02d}"]
            for i in range(75000)])
    _table(repo, "data/legacy/customers_2019.csv", ["customer_id", "full_name", "email", "city"],
           [[100 + i, f"Olga Qzx{i:04d}", f"old{i:04d}.qzx@example.invalid", CITIES[i % 5]] for i in range(1, 11)])
    _table(repo, "data/legacy/orders_backup.csv", ["order_id", "customer_id", "sku", "qty"],
           [[3000 + i, 100 + i % 10, SKUS[i % 6], 1 + i % 3] for i in range(10)])
    _table(repo, "data/staff.csv", ["staff_id", "full_name", "email", "salary"],
           [[200 + i, f"Sam Qzx{i:04d}", f"s{i:04d}.qzx@example.invalid", 40000 + i * 2500] for i in range(1, 9)])
    _table(repo, "data/fx_rates.csv", ["currency", "rate_to_usd"],
           [[c, r] for c, r in (("EUR", "1.08"), ("GBP", "1.27"), ("JPY", "0.0067"), ("BRL", "0.19"), ("INR", "0.012"))])
    _table(repo, "data/promo_codes.tsv", ["code", "discount_pct", "expires_year"],
           [[f"SAVE{p}", p, 2027 + i % 3] for i, p in enumerate((5, 10, 15, 20, 25))], "\t")
    _table(repo, "data/exports/monthly_sales.csv", ["month", "sku", "units", "revenue"],
           [[f"2026-{m:02d}", SKUS[m % 6], 100 + m * 11, f"{1000 + m * 137}.00"] for m in range(1, 7)])
    _table(repo, "tests/fixtures/sample_orders.csv", ["order_id", "sku", "qty"],
           [[1, "SKU-100", 2], [2, "SKU-200", 3], [3, "SKU-300", 1]])


def _code(repo):
    _write(repo, "README.md", "Shop: a small order, catalog and reporting package with CSV-backed data under data/.\n")
    _write(repo, "docs/README.md",
           "# Data folder\n\nThe data/ folder holds the shop's CSV and TSV tables: customers, orders, products,\n"
           "inventory, suppliers and daily events. The file data/legacy/customers_2019.csv is an archived export\n"
           "that no code uses; it is kept for audit only.\n")
    _write(repo, "src/shop/__init__.py", "")
    _write(repo, "src/shop/config.py", 'FX_RATES_PATH = "data/fx_rates.csv"\nEVENTS_PATH = "data/events_large.csv"\n')
    _write(repo, "src/shop/loaders.py", '''import csv


def load_customers():
    with open("data/customers.csv", newline="", encoding="utf-8") as f:
        return {row["customer_id"]: row["email"] for row in csv.DictReader(f)}


def load_orders():
    with open("data/orders.csv", newline="", encoding="utf-8") as f:
        return [row["customer_id"] for row in csv.DictReader(f)]


def order_total(path="data/orders.csv"):
    with open(path, newline="", encoding="utf-8") as f:
        return sum(float(row["qty"]) * float(row["unit_price"]) for row in csv.DictReader(f))
''')
    _write(repo, "src/shop/catalog.py", '''import csv


def load_products():
    with open("data/products.csv", newline="", encoding="utf-8") as f:
        return [(row["category"], float(row["price"])) for row in csv.DictReader(f)]


def stock_levels():
    with open("data/inventory.tsv", newline="", encoding="utf-8") as f:
        return {row["warehouse"]: int(row["on_hand"]) for row in csv.DictReader(f, delimiter="\\t")}
''')
    _write(repo, "src/shop/returns.py", '''import csv


def process_return():
    with open("data/returns.csv", newline="", encoding="utf-8") as f:
        return [(int(row["qty"]), row["reason"]) for row in csv.DictReader(f)]
''')
    _write(repo, "src/shop/currency.py", '''import csv

from shop.config import FX_RATES_PATH


def load_fx_rates():
    with open(FX_RATES_PATH, newline="", encoding="utf-8") as f:
        return {row["currency"]: float(row["rate_to_usd"]) for row in csv.DictReader(f)}
''')
    _write(repo, "src/shop/analytics.py", '''import csv
from collections import Counter

from shop.config import EVENTS_PATH


def load_events():
    with open(EVENTS_PATH, newline="", encoding="utf-8") as f:
        return Counter(row["event_type"] for row in csv.DictReader(f))
''')
    _write(repo, "src/shop/regions.py", '''import csv


def region_managers():
    with open("data/regions.csv", newline="", encoding="utf-8") as f:
        return {row["region_code"]: row["manager"] for row in csv.DictReader(f)}
''')
    _write(repo, "src/shop/promo.py", '''import csv


def active_promos():
    with open("data/promo_codes.tsv", newline="", encoding="utf-8") as f:
        return {row.get("code"): row.get("discount_pct") for row in csv.DictReader(f, delimiter="\\t")}
''')
    _write(repo, "src/shop/suppliers.py", '''import csv


def supplier_lead_times():
    with open("data/suppliers.csv", newline="", encoding="utf-8") as f:
        return {row["name"]: int(row["lead_days"]) for row in csv.DictReader(f)}


def notify_suppliers():
    with open("data/suppliers.csv", newline="", encoding="utf-8") as f:
        return [row["contact_email"] for row in csv.DictReader(f)]
''')
    _write(repo, "src/shop/marketing.py", '''import csv


def send_newsletter():
    with open("data/customers.csv", newline="", encoding="utf-8") as f:
        return [(row.get("full_name"), row.get("email")) for row in csv.DictReader(f)]
''')
    _write(repo, "src/shop/reports.py", '''import csv
import os
from collections import Counter

from shop.loaders import load_customers, load_orders


def best_sellers():
    totals = Counter()
    with open(os.path.join("data", "orders.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            totals[row["sku"]] += int(row["qty"])
    return totals.most_common(3)


def write_monthly_sales(rows):
    with open("data/exports/monthly_sales.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["month", "sku", "units", "revenue"])
        w.writerows(rows)
''')
    _write(repo, "scripts/migrate_2019.py", '''def migrate():
    # old: rows = read_csv("data/legacy/orders_backup.csv")
    return 0
''')
    _write(repo, "tests/test_orders.py", '''import csv


def test_sample_orders():
    with open("tests/fixtures/sample_orders.csv", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert all(int(row["qty"]) > 0 for row in rows)
''')


def make(root):
    repo = pathlib.Path(root) / "main"
    repo.mkdir(parents=True)
    _data(repo)
    _code(repo)
    sh("git", "init", "-b", "main", cwd=repo)
    sh("git", "config", "core.autocrlf", "false", cwd=repo)
    sh("git", "add", "-A", cwd=repo)
    sh("git", *G, "commit", "-m", "C0", cwd=repo)
    return pathlib.Path(root)


def apply_edits(root):
    repo = pathlib.Path(root) / "main"
    sh("git", "checkout", "--", ".", cwd=repo)
    shutil.rmtree(repo / "node_modules", ignore_errors=True)
    sh("git", "clean", "-fdq", cwd=repo)


if __name__ == "__main__":
    import subprocess
    root = pathlib.Path(sys.argv[1])
    make(root)
    apply_edits(root)
    repo = root / "main"
    files = [p for p in repo.rglob("*") if p.is_file() and ".git" not in p.relative_to(repo).parts]
    data = [p for p in files if p.suffix in (".csv", ".tsv")]
    code = [p for p in files if p not in data]
    assert len(data) == 15, len(data)
    for p in data:
        if p.name == "events_large.csv":
            assert 2_500_000 <= p.stat().st_size <= 4_000_000, p.stat().st_size
        else:
            assert p.stat().st_size < 100_000, p
        assert "qzx" not in p.read_text(encoding="utf-8").splitlines()[0].lower(), p
    for p in code:
        assert "qzx" not in p.read_text(encoding="utf-8").lower(), p
    with open(repo / "data/regions.csv", newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            for c in row:
                try:
                    float(c)
                except ValueError:
                    continue
                raise AssertionError(("numeric cell", c))
    assert "fx_rates.csv" not in (repo / "src/shop/currency.py").read_text(encoding="utf-8")
    assert "events_large.csv" not in (repo / "src/shop/analytics.py").read_text(encoding="utf-8")

    def mentions(s):
        return sorted(p.relative_to(repo).as_posix() for p in code if s in p.read_text(encoding="utf-8"))
    assert mentions("orders_backup") == ["scripts/migrate_2019.py"], mentions("orders_backup")
    assert mentions("customers_2019") == ["docs/README.md"], mentions("customers_2019")
    assert mentions("staff.csv") == [] and mentions("staff") == [], mentions("staff")
    st = subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True, check=True)
    assert st.stdout == "", st.stdout
    print(f"ok: {len(data)} data files, {len(code)} code/doc files, events_large "
          f"{(repo / 'data/events_large.csv').stat().st_size} bytes, git clean")
