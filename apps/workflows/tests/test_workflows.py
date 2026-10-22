"""Static checks on the generated n8n workflows (no n8n needed)."""

import importlib.util
import json
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("wf_build", ROOT / "build.py")
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)

WORKFLOWS = {name: json.loads(text) for name, text in build.render().items()}


def test_dist_is_up_to_date():
    for name, text in build.render().items():
        assert (ROOT / "dist" / name).read_text() == text, f"dist/{name} is stale: run python apps/workflows/build.py"


@pytest.mark.parametrize("name", WORKFLOWS)
def test_graph_is_well_formed(name):
    wf = WORKFLOWS[name]
    names = [n["name"] for n in wf["nodes"]]
    assert len(names) == len(set(names)), "node names must be unique"
    targets = set()
    for src, outs in wf["connections"].items():
        assert src in names
        for branch in outs["main"]:
            for edge in branch:
                assert edge["node"] in names, f"{src} → unknown node {edge['node']}"
                targets.add(edge["node"])
    triggers = {n["name"] for n in wf["nodes"] if "Trigger" in n["type"] or n["type"].endswith(("webhook", "errorTrigger"))}
    orphans = set(names) - targets - triggers
    assert not orphans, f"unreachable nodes: {orphans}"


@pytest.mark.parametrize("name", WORKFLOWS)
def test_no_secrets_in_exports(name):
    text = json.dumps(WORKFLOWS[name])
    for node in WORKFLOWS[name]["nodes"]:
        for cred in node.get("credentials", {}).values():
            assert set(cred) == {"id", "name"}, "credentials are referenced, never embedded"
    assert not re.search(r"(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|password\s*[:=]\s*\S+)", text, re.I)


@pytest.mark.parametrize("name", WORKFLOWS)
def test_code_nodes_are_valid_javascript(name, tmp_path):
    for node in WORKFLOWS[name]["nodes"]:
        if node["type"] != "n8n-nodes-base.code":
            continue
        f = tmp_path / "node.js"
        f.write_text(f"(async function () {{\n{node['parameters']['jsCode']}\n}});\n")  # n8n runs the code in a function body
        result = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
        assert result.returncode == 0, f"{name} / {node['name']}: {result.stderr}"


@pytest.mark.parametrize("name", WORKFLOWS)
def test_query_parameter_counts_match(name):
    for node in WORKFLOWS[name]["nodes"]:
        if node["type"] != "n8n-nodes-base.postgres":
            continue
        query = re.sub(r"--[^\n]*", "", node["parameters"]["query"])
        needed = max((int(m) for m in re.findall(r"\$(\d+)", query)), default=0)
        expr = node["parameters"]["options"].get("queryReplacement", "")
        # top-level commas of the "={{ [ ... ] }}" array literal
        inner = expr[expr.find("[") + 1: expr.rfind("]")] if expr else ""
        depth, given = 0, (1 if inner.strip() else 0)
        for ch in inner:
            depth += ch in "([{"
            depth -= ch in ")]}"
            given += ch == "," and depth == 0
        assert given == needed, f"{name} / {node['name']}: query uses ${needed}, expression passes {given}"


def test_workflow_b_hands_off_to_c():
    b = WORKFLOWS["B_match.json"]
    call = next(n for n in b["nodes"] if n["type"] == "n8n-nodes-base.executeWorkflow")
    assert call["parameters"]["workflowId"]["value"] == WORKFLOWS["C_notify.json"]["id"]
    assert all(w["settings"].get("errorWorkflow") == WORKFLOWS["E_errors.json"]["id"]
               for k, w in WORKFLOWS.items() if k != "E_errors.json")


def test_workflow_c_links_to_workflow_d():
    """The question link C puts in emails must hit D's GET webhook, and D's form must post to D's POST webhook."""
    render = next(n for n in WORKFLOWS["C_notify.json"]["nodes"] if n["name"] == "Render emails")
    assert "questions.confirmLink(" in render["parameters"]["jsCode"]
    hooks = {n["parameters"]["httpMethod"]: n["parameters"]["path"]
             for n in WORKFLOWS["D_confirm.json"]["nodes"] if n["type"] == "n8n-nodes-base.webhook"}
    assert hooks == {"GET": "confirm", "POST": "confirm-submit"}
    questions_js = (ROOT / "src" / "code" / "questions.js").read_text()
    assert "webhook/confirm?t=" in questions_js
    assert "webhook/confirm-submit" in (ROOT / "src" / "workflows" / "wf_d_confirm.py").read_text()
