"""Small factories for n8n node JSON, so workflow definitions read like diagrams.

Node type versions target n8n 2.42 (pinned in docker-compose.yml).
"""

import uuid
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent

# Fixed ids so workflows can reference each other and credentials survive re-imports.
WORKFLOW_IDS = {"A": "loanEngineCrawlA", "B": "loanEngineMatchB", "C": "loanEngineNotifC", "E": "loanEngineErrorE"}
CREDENTIALS = {
    "postgres": {"id": "loanEngineDbCred", "name": "Loan DB"},
    "aws": {"id": "loanEngineSesCrd", "name": "AWS SES"},
    "httpHeaderAuth": {"id": "loanEngineLlmCrd", "name": "LLM API"},
}


def _id(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"loan-engine/{name}"))  # stable across builds → clean diffs


def sql(name: str) -> str:
    return (SRC / "sql" / f"{name}.sql").read_text().strip()


def include(module: str) -> str:
    """Inline a tested module from src/code/ inside an IIFE (no global-name clashes between modules)."""
    source = (SRC / "code" / f"{module}.js").read_text()
    return (f"// ---- {module}.js (source: apps/workflows/src/code/{module}.js — edit there, then rebuild) ----\n"
            f"const {module} = (() => {{ const module = {{ exports: {{}} }};\n{source}\nreturn module.exports; }})();\n")


class Workflow:
    def __init__(self, key: str, name: str, error_workflow: bool = True):
        self.key, self.name = key, name
        self.nodes: list[dict] = []
        self.connections: dict = {}
        self.error_workflow = error_workflow
        self._x = 0

    def add(self, name: str, type_: str, version: float, params: dict, pos: tuple[int, int], **extra) -> str:
        node = {"id": _id(f"{self.key}/{name}"), "name": name, "type": type_, "typeVersion": version,
                "position": list(pos), "parameters": params, **extra}
        self.nodes.append(node)
        return name

    def connect(self, src: str, dst: str, output: int = 0, dst_input: int = 0) -> None:
        outs = self.connections.setdefault(src, {"main": []})["main"]
        while len(outs) <= output:
            outs.append([])
        outs[output].append({"node": dst, "type": "main", "index": dst_input})

    def chain(self, *names: str) -> None:
        for a, b in zip(names, names[1:], strict=False):
            self.connect(a, b)

    # ---- node helpers -------------------------------------------------------------------
    def postgres(self, name, query_file, pos, params_expr=None, **extra):
        options = {"queryReplacement": params_expr} if params_expr else {}
        return self.add(name, "n8n-nodes-base.postgres", 2.5,
                        {"operation": "executeQuery", "query": sql(query_file), "options": options}, pos,
                        credentials={"postgres": CREDENTIALS["postgres"]}, **extra)

    def code(self, name, js, pos, per_item=False, **extra):
        params = {"jsCode": js}
        if per_item:
            params["mode"] = "runOnceForEachItem"
        return self.add(name, "n8n-nodes-base.code", 2, params, pos, **extra)

    def to_json(self) -> dict:
        settings = {"executionOrder": "v1", "timezone": "Asia/Kolkata", "saveDataSuccessExecution": "all",
                    "saveManualExecutions": True, "callerPolicy": "workflowsFromSameOwner"}
        if self.error_workflow:
            settings["errorWorkflow"] = WORKFLOW_IDS["E"]
        return {"id": WORKFLOW_IDS[self.key], "name": self.name, "active": False, "nodes": self.nodes,
                "connections": self.connections, "settings": settings, "pinData": {}, "tags": []}
