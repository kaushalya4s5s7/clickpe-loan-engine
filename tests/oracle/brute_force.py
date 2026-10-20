"""The obvious O(users × products) matcher — the reference the optimised pipeline must equal."""


def eligible(user: dict, product: dict) -> bool:
    income, score, age, job = user["monthly_income"], user["credit_score"], user["age"], user["employment_status"]
    if product["min_monthly_income"] is not None and income < product["min_monthly_income"]:
        return False
    if score is None:
        if not product["accepts_ntc"]:
            return False
    elif product["min_credit_score"] is not None and score < product["min_credit_score"]:
        return False
    if product["min_age"] is not None and age < product["min_age"]:
        return False
    if product["max_age"] is not None and age > product["max_age"]:
        return False
    types = product["employment_types"]
    return not types or job in types


def all_pairs(users: list[dict], products: list[dict]) -> set[tuple[str, int]]:
    return {(u["user_id"], p["id"]) for u in users for p in products if eligible(u, p)}
