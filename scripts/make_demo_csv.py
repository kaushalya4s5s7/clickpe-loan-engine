"""Generate a demo upload: fresh user_ids (so they count as NEW users) + a few realistic dirty rows.

    python scripts/make_demo_csv.py 200 > data/demo_users.csv

Every address is @example.com (reserved, never deliverable). Emails in the demo go to your
Gmail +aliases via TEST_MODE, never to these addresses.
"""

import csv
import random
import sys
import time

NAMES = ["Aarav Shah", "Diya Patel", "Rohan Mehta", "Ananya Iyer", "Kabir Singh", "Isha Reddy", "Vihaan Gupta",
         "Meera Nair", "Arjun Desai", "Saanvi Joshi", "Reyansh Kumar", "Kavya Rao"]
JOBS = ["Salaried", "Self-Employed", "Business"]


def main(n: int) -> None:
    rng = random.Random()
    run = time.strftime("%m%d%H%M")
    out = csv.writer(sys.stdout)
    out.writerow(["user_id", "name", "email", "monthly_income", "credit_score", "employment_status", "age"])
    for i in range(n):
        out.writerow([f"D{run}-{i:04d}", rng.choice(NAMES), f"demo{run}{i}@example.com",
                      rng.choice([25000, 32000, 45000, 60000, 85000, 120000, 150000]),
                      rng.choice([650, 700, 720, 750, 780, 800, "NA"]), rng.choice(JOBS), rng.randint(22, 58)])
    # what real spreadsheets contain — each produces a row-level error in the report
    out.writerow([f"D{run}-bad1", "No Email", "", 50000, 750, "Salaried", 30])
    out.writerow([f"D{run}-bad2", "Typo Income", f"bad{run}@example.com", "fifty thousand", 750, "Salaried", 30])
    out.writerow(["1.23457E+11", "Excel Mangled", f"x{run}@example.com", 50000, 750, "Salaried", 30])
    out.writerow([f"D{run}-bad4", "Too Young", f"y{run}@example.com", 50000, 750, "Salaried", 16])


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 200)
