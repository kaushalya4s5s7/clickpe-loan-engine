"""Error workflow — any failed execution of A, B or C lands in pipeline_events (visible in the UI timeline)."""

from .nodes import Workflow


def build() -> dict:
    w = Workflow("E", "E · Error handler", error_workflow=False)
    w.add("On workflow error", "n8n-nodes-base.errorTrigger", 1, {}, (0, 0))
    w.postgres("Record failure", "record_event", (240, 0), params_expr=(
        "={{ ['', 'workflow', 'failed', JSON.stringify({ workflow: $json.workflow?.name, "
        "node: $json.execution?.lastNodeExecuted, message: String($json.execution?.error?.message ?? '').slice(0, 500), "
        "execution: $json.execution?.url }) ] }}"))
    w.chain("On workflow error", "Record failure")
    return w.to_json()
