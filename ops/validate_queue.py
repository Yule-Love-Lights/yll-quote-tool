"""Validate a queue.jsonl file against ops/queue.schema.json.

No third-party dependencies (no jsonschema, no pip install). Overnight runs
should not depend on network access just to check their own homework.

Usage:
    python ops/validate_queue.py path/to/queue.jsonl

Exit 0 and prints "QUEUE VALID" when every task line matches the schema.
Exit 1 and prints "QUEUE INVALID" plus every error found when it does not.
Run this before executing any task in the queue. Refuse to run the queue
on a non-zero exit.
"""

import json
import sys
import os


def main():
    if len(sys.argv) != 2:
        print("usage: python ops/validate_queue.py path/to/queue.jsonl")
        sys.exit(2)

    queue_path = sys.argv[1]
    schema_path = os.path.join(os.path.dirname(__file__), "queue.schema.json")

    with open(schema_path, encoding="utf-8") as f:
        schema = json.load(f)

    props = schema["properties"]
    required = schema["required"]
    valid_statuses = set(props["status"]["enum"])
    valid_blast = set(props["blast_radius"]["enum"])

    with open(queue_path, encoding="utf-8") as f:
        lines = [ln for ln in f.read().splitlines() if ln.strip()]

    errors = []
    seen_ids = set()
    tasks = []

    for lineno, line in enumerate(lines, 1):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            errors.append("line %d: not valid JSON: %s" % (lineno, e))
            continue

        tag = obj.get("id", "?")

        for key in obj:
            if key not in props:
                errors.append("line %d (%s): unknown field '%s'" % (lineno, tag, key))

        for key in required:
            if key not in obj:
                errors.append("line %d (%s): missing required field '%s'" % (lineno, tag, key))

        if "id" in obj:
            if obj["id"] in seen_ids:
                errors.append("line %d: duplicate id '%s'" % (lineno, obj["id"]))
            seen_ids.add(obj["id"])

        if "blast_radius" in obj and obj["blast_radius"] not in valid_blast:
            errors.append("line %d (%s): bad blast_radius '%s'" % (lineno, tag, obj["blast_radius"]))

        if "status" in obj and obj["status"] not in valid_statuses:
            errors.append("line %d (%s): bad status '%s'" % (lineno, tag, obj["status"]))

        if "max_attempts" in obj:
            ma = obj["max_attempts"]
            if not isinstance(ma, int) or isinstance(ma, bool) or ma < 1:
                errors.append("line %d (%s): max_attempts must be an integer >= 1" % (lineno, tag))

        v = obj.get("verify")
        if v is None:
            errors.append("line %d (%s): missing verify block" % (lineno, tag))
        elif not isinstance(v, dict) or "type" not in v:
            errors.append("line %d (%s): verify block needs a type" % (lineno, tag))
        elif v["type"] == "shell":
            if not isinstance(v.get("command"), str) or not v["command"].strip():
                errors.append("line %d (%s): shell verify needs a non-empty command" % (lineno, tag))
            extra = set(v) - {"type", "command"}
            if extra:
                errors.append("line %d (%s): verify has unexpected fields %s" % (lineno, tag, sorted(extra)))
        elif v["type"] == "manual":
            if not isinstance(v.get("check"), str) or not v["check"].strip():
                errors.append("line %d (%s): manual verify needs a non-empty check" % (lineno, tag))
            extra = set(v) - {"type", "check"}
            if extra:
                errors.append("line %d (%s): verify has unexpected fields %s" % (lineno, tag, sorted(extra)))
        else:
            errors.append("line %d (%s): verify type must be 'shell' or 'manual', got '%s'" % (lineno, tag, v["type"]))

        tasks.append(obj)

    for t in tasks:
        for dep in t.get("depends_on", []):
            if dep not in seen_ids:
                errors.append("task '%s': depends_on references unknown id '%s'" % (t.get("id", "?"), dep))

    if errors:
        print("QUEUE INVALID: %d error(s)" % len(errors))
        for e in errors:
            print(" - " + e)
        sys.exit(1)

    print("QUEUE VALID: %d task(s), ids: %s" % (len(tasks), ", ".join(sorted(seen_ids))))
    sys.exit(0)


if __name__ == "__main__":
    main()
